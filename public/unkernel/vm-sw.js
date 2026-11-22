// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's service worker (registered by src/sw.ts at scope /vm/). One
// job, the guest preview (.agents/web.md, Guest preview, has the whole
// design). It answers /vm/<vmId>/<port>/<path> and nothing else, by
// relaying the request to the page that runs that kernel, which calls
// vm.fetch() on the guest's 127.0.0.1:<port> and streams the response
// back. Every other request, a preview's root-relative /style.css
// included, goes to the network as if there were no worker.
//
// Stateless on purpose: browsers stop idle service workers, so every fetch
// asks the open windows again. Each window that is not itself a preview
// gets the request with a MessagePort of its own; the page that owns the
// vmId answers "accept" on it, the others ignore it. Over the accepted port
// (no transferable streams: Safari lacks them):
//   page -> here: {t:"accept"}, then {t:"head", status, statusText, headers},
//                 {t:"chunk", data: ArrayBuffer}..., {t:"end"} or {t:"error", message}
//   here -> page: {t:"more"} (the body stream wants a chunk), {t:"cancel"}
// The page may send a few chunks ahead (credits, preview.ts), so a chunk
// is not a round trip each.
//
// A plain script, not a module, and not part of the TypeScript build, so
// that every engine with service workers runs it as it is.
"use strict";

/** /vm/<vmId>/<port>[/<path>] */
const PREVIEW_RE = /^\/unkernel\/vm\/([A-Za-z0-9_-]{1,64})\/(\d{1,5})(\/.*)?$/;
/** A page must accept within this, else 502 (no page runs that kernel any more). */
const ACCEPT_MS = 5000;
/** The guest must send the status line and headers within this, else 504. */
const HEAD_MS = 60000;
/**
 * The page is cross-origin isolated (COOP same-origin, COEP require-corp),
 * so a document in its iframe must declare COEP too. require-corp, not
 * credentialless: Safari does not implement credentialless, and an iframe
 * without a COEP it knows is blocked there. The cost: a guest page's
 * cross-origin subresources (a CDN) load only if they send CORP or CORS.
 */
const COEP = "require-corp";
/** Not passed on from the guest: hop-by-hop, and what the browser computes itself. */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "set-cookie", "set-cookie2",
	"cross-origin-embedder-policy", "cross-origin-resource-policy", "cross-origin-opener-policy"]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Running in the old scope-/ registration of builds that kept an offline
 * copy. Such a worker only serves pages of those builds: it leaves their
 * requests to the network like any other outside /vm/, so the next load of
 * / is the newest page (whose sw.ts unregisters this scope), and tells them
 * an update is ready.
 */
const LEGACY = self.registration.scope === `${location.origin}/`;

// A new vm-sw.js takes over at once: the relay's messages stay compatible.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		await self.clients.claim();
		// The old offline copy's caches (kw-app-v1). kw-apk-index-v1 is apk.ts's: never touched.
		const names = await caches.keys();
		await Promise.all(names.filter((n) => n.startsWith("kw-app-")).map((n) => caches.delete(n)));
	})());
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== location.origin) return; // cross-origin: the network, as usual
	const m = PREVIEW_RE.exec(url.pathname);
	if (!m) return; // not a preview URL: the network, as if there were no worker
	// /vm/<id>/<port> without the slash: relative URLs in the page need it.
	if (m[3] === undefined) event.respondWith(Response.redirect(new URL(`${url.pathname}/${url.search}`, url).href, 308));
	else event.respondWith(relay(event, m[1], Number(m[2]), m[3] + url.search));
});

// {t: "kw-check", entry} with a MessagePort: the update check of builds that
// kept an offline copy. Such a page is outdated by definition, so under
// LEGACY the answer is "update" (its status line offers a reload, which now
// loads the newest page from the network).
self.addEventListener("message", (event) => {
	const d = event.data, port = event.ports[0];
	if (!port || d?.t !== "kw-check") return;
	port.postMessage({ t: "kw-check", update: LEGACY, offline: false });
});

function text(status, msg) {
	return new Response(`${msg}\n`, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
			"cross-origin-embedder-policy": COEP, "cross-origin-resource-policy": "same-origin",
		},
	});
}

/** A redirect to the guest itself (http://localhost:<port>/x) or to /x, kept under the prefix. */
function relocate(v, prefix, port) {
	if (v.startsWith("/") && !v.startsWith("//")) return prefix + v;
	if (!/^https?:\/\//i.test(v)) return v; // relative to the request: already under the prefix
	try {
		const u = new URL(v);
		const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
		if (local && u.protocol === "http:" && (u.port || "80") === String(port)) return prefix + u.pathname + u.search + u.hash;
	} catch { /* not a URL: as it is */ }
	return v;
}

async function relay(event, vmId, port, path) {
	const req = event.request;
	const prefix = `/unkernel/vm/${vmId}/${port}`;
	if (port < 1 || port > 65535) return text(400, `Bad port in ${prefix}/`);
	const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
	const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	const pages = all.filter((c) => !new URL(c.url).pathname.startsWith("/unkernel/vm/"));
	const gone = `No open unkernel page runs VM ${vmId}: the preview needs the page that started it, in this browser. ` +
		"Each boot gets a new id, so after a reload open the preview again from the page.";
	if (!pages.length) return text(502, gone);

	let finish;
	const done = new Promise((r) => { finish = r; });
	event.waitUntil(done); // keep this worker alive while the body streams
	return new Promise((resolve) => {
		let owner = null, timer = 0, ctrl = null, wake = null;
		const ports = [];
		const settle = (res) => { clearTimeout(timer); resolve(res); };
		const end = () => { clearTimeout(timer); for (const p of ports) p.close(); finish(); };
		const msg = { t: "kw-vm-fetch", vmId, port, method: req.method, path, headers: [...req.headers], body };
		for (const c of pages) {
			const ch = new MessageChannel();
			ports.push(ch.port1);
			ch.port1.onmessage = (e) => onMessage(ch.port1, e.data);
			c.postMessage(msg, [ch.port2]);
		}
		timer = setTimeout(() => { settle(text(502, gone)); end(); }, ACCEPT_MS);

		function onMessage(p, d) {
			if (!d || typeof d.t !== "string") return;
			if (!owner) {
				if (d.t !== "accept") return;
				owner = p;
				for (const q of ports) if (q !== p) q.close();
				ports.length = 0;
				ports.push(p);
				clearTimeout(timer);
				timer = setTimeout(() => { p.postMessage({ t: "cancel" }); settle(text(504, `The guest's port ${port} did not answer within ${HEAD_MS / 1000} s.`)); end(); }, HEAD_MS);
				return;
			}
			if (p !== owner) return;
			if (d.t === "head") head(d);
			else if (d.t === "chunk" && ctrl) ctrl.enqueue(new Uint8Array(d.data));
			else if (d.t === "end") { ctrl?.close(); ctrl = null; end(); }
			else if (d.t === "error") {
				if (ctrl) { ctrl.error(new Error(d.message)); ctrl = null; }
				else settle(text(d.status || 502, d.message || "The relay failed."));
				end();
			}
			if (wake) { const w = wake; wake = null; w(); }
		}

		function head(d) {
			if (d.status < 200 || d.status > 599) { settle(text(502, `The guest sent status ${d.status}.`)); end(); return; }
			const headers = new Headers();
			for (const [k, v] of d.headers) {
				const n = k.toLowerCase();
				if (DROP.has(n)) continue;
				try { headers.append(k, n === "location" ? relocate(v, prefix, port) : v); } catch { /* a value the browser refuses */ }
			}
			headers.set("cross-origin-embedder-policy", COEP);
			headers.set("cross-origin-resource-policy", "same-origin");
			let stream = null;
			if (!NULL_BODY.has(d.status) && req.method !== "HEAD") {
				stream = new ReadableStream({
					start(c) { ctrl = c; },
					// Resolves when the next message comes, so the stream does not pull again at once.
					pull() { owner.postMessage({ t: "more" }); return new Promise((r) => { wake = r; }); },
					cancel() { owner.postMessage({ t: "cancel" }); ctrl = null; end(); },
				});
			}
			let res;
			try { res = new Response(stream, { status: d.status, statusText: d.statusText, headers }); }
			catch { res = new Response(stream, { status: d.status, headers }); } // a reason phrase the browser refuses
			settle(res);
			if (!stream) { owner.postMessage({ t: "cancel" }); end(); }
		}
	});
}
