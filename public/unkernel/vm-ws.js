// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// WebSockets for the guest preview. The service worker (vm-sw.js) puts
// <script src="/vm-ws.js" data-kw-vm data-kw-port> into each HTML document
// it relays, right after the doctype, because a WebSocket never reaches a
// service worker. This replaces window.WebSocket with a class of the same
// API whose connections to the guest (ws://localhost:<port>, this origin's
// /vm/<vmId>/<port>/…, or a root-relative URL: the document's own port)
// run through the page that owns the kernel: over the BroadcastChannel
// "kw-vm-<vmId>", where preview.ts opens them with websocketOver()
// (js/core/ws.ts) on the guest's loopback. Other URLs get the browser's
// own WebSocket.
//
// Messages (`id` is the socket's, random):
//   here -> page: ws-open {id, port, path, protocols}, ws-send {id, data},
//                 ws-ack {id} (a message was delivered: one more credit), ws-close {id, code, reason}
//   page -> here: ws-accept {id}, ws-opened {id, protocol}, ws-msg {id, data},
//                 ws-sent {id, n} (bytes written to the guest), ws-closed {id, code, reason, wasClean},
//                 ws-error {id, message} (the connection failed: error, then close 1006)
// Teardown by Web Locks: this document holds "kw-ws-<id>" while the socket
// is open, so the page learns when the document is gone; the page holds
// "kw-vm-<vmId>", so this document learns when the page is gone.
//
// A plain script, not a module, and not part of the TypeScript build, like vm-sw.js.
(() => {
	"use strict";
	const script = document.currentScript;
	const vmId = script?.dataset.kwVm ?? "";
	const docPort = Number(script?.dataset.kwPort);
	const Native = window.WebSocket;
	if (!vmId || !Native || !(docPort > 0) || typeof BroadcastChannel !== "function" || Native.__kwPreview) return;

	const PREVIEW_RE = /^\/vm\/([A-Za-z0-9_-]{1,64})\/(\d{1,5})(\/.*)?$/;
	/** The page must take the socket within this, else it fails (no page runs this kernel, or an old one). */
	const ACCEPT_MS = 5000;
	const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
	const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
	const enc = new TextEncoder();
	const chan = new BroadcastChannel(`kw-vm-${vmId}`);
	/** id -> socket */
	const sockets = new Map();
	const locks = navigator.locks;
	let watchingPage = false;

	chan.onmessage = (e) => {
		const d = e.data;
		const s = d && typeof d.id === "string" && sockets.get(d.id);
		if (s) s._fromPage(d);
	};
	const post = (m) => { try { chan.postMessage(m); } catch { /* a closed channel */ } };

	/** Once a socket is open: the page's lock is granted to us when the page is gone, which ends every socket. */
	function watchPage() {
		if (watchingPage || !locks) return;
		watchingPage = true;
		locks.request(`kw-vm-${vmId}`, () => {
			watchingPage = false;
			for (const s of [...sockets.values()]) s._end(1006, "", false, "the unkernel page that runs this kernel is gone");
		}).catch(() => { watchingPage = false; });
	}
	// The document goes away (navigation, closed tab, the back-forward cache): its sockets end.
	addEventListener("pagehide", () => {
		for (const s of [...sockets.values()]) { post({ t: "ws-close", id: s._id }); s._end(1001, "", false); }
	});

	/** The guest port and path a WebSocket URL reaches, or null: not the guest. */
	function target(u) {
		if (u.host === location.host) {
			const m = PREVIEW_RE.exec(u.pathname);
			if (!m) return { port: docPort, path: u.pathname + u.search }; // root-relative: this document's port
			return m[1] === vmId ? { port: Number(m[2]), path: (m[3] ?? "/") + u.search } : null;
		}
		if (LOCAL.has(u.hostname)) return { port: Number(u.port) || (u.protocol === "wss:" ? 443 : 80), path: u.pathname + u.search };
		return null;
	}

	const domError = (msg, name) => new DOMException(msg, name);
	const byteLength = (d) => typeof d === "string" ? enc.encode(d).length : d instanceof Blob ? d.size : d.byteLength;
	const newId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID()
		: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

	class WebSocket extends EventTarget {
		#url;
		#origin;
		#state = 0;
		#protocol = "";
		#binaryType = "blob";
		#buffered = 0;
		#timer = 0;
		#release = null;
		/** Sends wait behind a Blob being read, to keep their order. */
		#chain = null;

		constructor(url, protocols) {
			let u;
			try { u = new URL(String(url), document.baseURI); } catch { throw domError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, "SyntaxError"); }
			if (u.protocol === "http:") u.protocol = "ws:";
			else if (u.protocol === "https:") u.protocol = "wss:";
			if (u.protocol !== "ws:" && u.protocol !== "wss:") throw domError(`Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${u.protocol}' is not allowed.`, "SyntaxError");
			if (u.hash) throw domError(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${u.hash}').`, "SyntaxError");
			const t = target(u);
			// Not the guest: the browser's own (instanceof still holds: Symbol.hasInstance below).
			if (!t) return protocols === undefined ? new Native(u.href) : new Native(u.href, protocols);
			const list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols].map(String);
			for (const p of list) if (!TOKEN.test(p)) throw domError(`Failed to construct 'WebSocket': The subprotocol '${p}' is invalid.`, "SyntaxError");
			if (new Set(list).size !== list.length) throw domError("Failed to construct 'WebSocket': The subprotocol is duplicated.", "SyntaxError");
			if (!(t.port >= 1 && t.port <= 65535)) throw domError(`Failed to construct 'WebSocket': Bad port in '${u.href}'.`, "SyntaxError");
			super();
			this.#url = u.href;
			this.#origin = u.origin;
			this._id = newId();
			sockets.set(this._id, this);
			const open = () => {
				if (this.#state !== 0) return;
				post({ t: "ws-open", id: this._id, port: t.port, path: t.path, protocols: list });
				this.#timer = setTimeout(() => this._end(1006, "", false, "no unkernel page took the connection (reload the page that runs this kernel)"), ACCEPT_MS);
			};
			// Held while the socket lives, so the page learns when this document is gone.
			if (locks) {
				locks.request(`kw-ws-${this._id}`, () => new Promise((r) => { this.#release = r; open(); })).catch(() => open());
			} else queueMicrotask(open);
		}

		static [Symbol.hasInstance](o) { return Function.prototype[Symbol.hasInstance].call(this, o) || o instanceof Native; }

		get url() { return this.#url; }
		get readyState() { return this.#state; }
		get protocol() { return this.#protocol; }
		get extensions() { return ""; }
		get bufferedAmount() { return this.#buffered; }
		get binaryType() { return this.#binaryType; }
		set binaryType(v) { if (v === "blob" || v === "arraybuffer") this.#binaryType = v; }

		send(data) {
			if (this.#state === 0) throw domError("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
			if (typeof data !== "string" && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) data = String(data);
			this.#buffered += byteLength(data);
			if (this.#state !== 1) return; // closing or closed: counted, not sent
			const go = (d) => { if (this.#state === 1) post({ t: "ws-send", id: this._id, data: d }); };
			const copy = (d) => typeof d === "string" ? d
				: d instanceof ArrayBuffer ? d.slice(0) : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
			if (data instanceof Blob || this.#chain) {
				const prev = this.#chain ?? Promise.resolve();
				const mine = prev.then(async () => go(data instanceof Blob ? await data.arrayBuffer() : copy(data)));
				this.#chain = mine;
				mine.finally(() => { if (this.#chain === mine) this.#chain = null; });
			} else go(copy(data));
		}

		close(code, reason) {
			if (code !== undefined) {
				code = Number(code);
				if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw domError(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, "InvalidAccessError");
			}
			reason = reason === undefined ? "" : String(reason);
			if (enc.encode(reason).length > 123) throw domError("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
			if (this.#state >= 2) return;
			if (this.#state === 0) {
				// Not open yet: the connection fails (error, then close 1006).
				post({ t: "ws-close", id: this._id });
				this._end(1006, "", false, "");
				return;
			}
			this.#state = 2;
			post({ t: "ws-close", id: this._id, code, reason });
		}

		/** A message from the page for this socket. */
		_fromPage(d) {
			switch (d.t) {
				case "ws-accept":
					clearTimeout(this.#timer);
					watchPage();
					break;
				case "ws-opened":
					if (this.#state !== 0) break;
					this.#state = 1;
					this.#protocol = typeof d.protocol === "string" ? d.protocol : "";
					this.dispatchEvent(new Event("open"));
					break;
				case "ws-msg": {
					if (this.#state !== 1) break;
					const data = typeof d.data === "string" ? d.data : this.#binaryType === "blob" ? new Blob([d.data]) : d.data;
					this.dispatchEvent(new MessageEvent("message", { data, origin: this.#origin }));
					post({ t: "ws-ack", id: this._id });
					break;
				}
				case "ws-sent":
					this.#buffered = Math.max(0, this.#buffered - (Number(d.n) || 0));
					break;
				case "ws-closed":
					this._end(Number(d.code) || 1006, typeof d.reason === "string" ? d.reason : "", !!d.wasClean);
					break;
				case "ws-error":
					this._end(1006, "", false, typeof d.message === "string" ? d.message : "the connection failed");
					break;
			}
		}

		/** Closed: an error event first if `error` is a string (a failed connection), then close. */
		_end(code, reason, wasClean, error) {
			if (this.#state === 3) return;
			clearTimeout(this.#timer);
			this.#state = 3;
			sockets.delete(this._id);
			this.#release?.();
			this.#release = null;
			if (typeof error === "string") {
				if (error) console.warn(`WebSocket connection to '${this.#url}' failed: ${error}`);
				this.dispatchEvent(new Event("error"));
			}
			this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
		}
	}

	for (const [i, name] of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].entries()) {
		Object.defineProperty(WebSocket, name, { value: i, enumerable: true });
		Object.defineProperty(WebSocket.prototype, name, { value: i, enumerable: true });
	}
	// onopen, onmessage, onerror, onclose: a listener added when first set, calling whatever is set now.
	for (const type of ["open", "message", "error", "close"]) {
		const handlers = new WeakMap();
		Object.defineProperty(WebSocket.prototype, `on${type}`, {
			configurable: true,
			enumerable: true,
			get() { return handlers.get(this) ?? null; },
			set(f) {
				if (!handlers.has(this)) this.addEventListener(type, (e) => { const h = handlers.get(this); if (typeof h === "function") h.call(this, e); });
				handlers.set(this, typeof f === "function" ? f : null);
			},
		});
	}
	Object.defineProperty(WebSocket, "__kwPreview", { value: true });
	Object.defineProperty(window, "WebSocket", { value: WebSocket, writable: true, configurable: true, enumerable: false });
})();
