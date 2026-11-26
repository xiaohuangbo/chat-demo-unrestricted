import{a as e,i as t,l as n,n as r,o as i,r as a,s as o,t as s}from"./config-CVLoJQN3.js";var c=`if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi
s=$1
shift
exec \${SUDO:+$SUDO -n} /bin/sh -c "$s" sh "$@"`;function l(e,t,n=[],r){return e.exec(`/bin/sh`,[`-c`,c,`sh`,t,...n],r)}var u=e=>document.getElementById(e),d=new URLSearchParams(location.search),f=navigator.hardwareConcurrency||1,p=Math.max(1,Math.min(16,f)),m=a(),h=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)||location.hostname.endsWith(`.localhost`),ee=location.protocol===`https:`?`https`:location.protocol===`http:`?h?`http, localhost`:`plain http, not localhost`:location.protocol;function te(){let e=1/0;for(let t=0;t<300;t++){let t=performance.now(),n;for(;(n=performance.now())===t;);e=Math.min(e,n-t)}return Math.round(e*1e3*100)/100}var g={ua:navigator.userAgent,hardwareConcurrency:f,deviceMemory:navigator.deviceMemory??null,webkit:t(),crossOriginIsolated,isSecureContext,origin:location.origin,originKind:ee,jspi:typeof WebAssembly.Suspending==`function`,smp:m??`yes`,timerResUs:te(),build:`linux ${{linux:`7.3.4+`,kernel:`v0.2.0-261126-fd204d3`,commit:`fd204d3130309c45ce51795c753c3b8ec1eaddfd`,date:`2026-11-26T00:44:09Z`}.linux}, kernel ${{linux:`7.3.4+`,kernel:`v0.2.0-261126-fd204d3`,commit:`fd204d3130309c45ce51795c753c3b8ec1eaddfd`,date:`2026-11-26T00:44:09Z`}.kernel}, page ${{linux:`7.3.4+`,kernel:`v0.2.0-261126-fd204d3`,commit:`fd204d3130309c45ce51795c753c3b8ec1eaddfd`,date:`2026-11-26T00:44:09Z`}.commit||`?`} ${{linux:`7.3.4+`,kernel:`v0.2.0-261126-fd204d3`,commit:`fd204d3130309c45ce51795c753c3b8ec1eaddfd`,date:`2026-11-26T00:44:09Z`}.date||``}`.trim(),kernelUrl:o.pathname.split(`/`).pop()??``,kernelSmpUrl:i?.pathname.split(`/`).pop()??null};u(`env`).textContent=Object.entries(g).map(([e,t])=>`${e.padEnd(20)} ${t}`).join(`
`);var _=[];isSecureContext||_.push(`Not a secure context (${ee}): Safari runs JS and wasm WITHOUT its JIT here, so every number is meaningless. Open http://localhost:<port>/smp-probe.html on this machine itself, or the page over https.`),crossOriginIsolated||_.push(`Not cross-origin isolated: no SharedArrayBuffer, so neither the probes nor several CPUs can run (the dev server and the built server send COOP/COEP).`),m&&_.push(`No SMP here: ${m}. Part B runs only the 1-CPU configurations.`),u(`warn`).textContent=_.join(`
`);var v=e=>new Promise(t=>setTimeout(t,e)),y=e=>[...e].sort((e,t)=>e-t),b=e=>{let t=y(e);return t.length?t[t.length>>1]:NaN},x=(e,t)=>{let n=y(e);return n.length?n[Math.min(n.length-1,Math.floor(t*n.length))]:NaN},S=e=>Math.round(e),C=e=>Math.round(e*10)/10,w=e=>Math.round(e*100)/100,T=e=>e?.message??String(e),E=(e,t=0)=>e==null||!Number.isFinite(e)?`-`:t===0?String(S(e)):t===1?C(e).toFixed(1):w(e).toFixed(2);function D(e,t,n){let r;return Promise.race([e,new Promise((e,i)=>{r=setTimeout(()=>i(Error(`${n}: timed out after ${C(t/1e3)} s`)),t)})]).finally(()=>clearTimeout(r))}var O=u(`log`);function k(e){O.textContent+=`${e}\n`,O.scrollTop=O.scrollHeight,console.log(`[smp-probe] ${e}`)}var A=e=>{u(`status`).textContent=e};document.addEventListener(`visibilitychange`,()=>{document.hidden&&k(`the tab was hidden: timings meanwhile may be off (background throttling)`)});var j=!1,M=class extends Error{constructor(){super(`stopped`)}},N=()=>{if(j)throw new M},ne=`"use strict";
const now = () => performance.now();
const spinJs = (iters) => { let x = 1; for (let i = 0; i < iters; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; } return x; };
const go = (g) => { const t0 = now(); while (Atomics.load(g, 0) === 0) if (now() - t0 > 60000) throw new Error("never released"); };
const resolution = () => { let m = Infinity; for (let i = 0; i < 200; i++) { const a = now(); let b; while ((b = now()) === a); m = Math.min(m, b - a); } return m * 1000; };
const leb = (v) => { const o = []; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (v) => { v = BigInt(v); const o = []; for (;;) { const b = Number(v & 0x7fn); v >>= 7n; if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const sec = (id, body) => [id, ...leb(body.length), ...body];
const str = (s) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
// A module shaped like a kwemu JIT block: imports env.memory (shared) and
// env.table, exports f(x, cpu, irqp, jl: i64) -> i64, which returns at once
// for cpu = 0 (the warm call); k load/xor/add steps, a store every 8. The
// first constant is a padded 5-byte LEB at "at", patched per module so that
// no two modules are the same bytes.
const templates = new Map();
function template(k) {
	let t = templates.get(k);
	if (t) return t;
	const body = [0x01, 0x01, 0x7e, 0x20, 0x01, 0x50, 0x04, 0x40, 0x42, 0x00, 0x0f, 0x0b];
	let at = -1;
	for (let j = 0; j < k; j++) {
		const off = leb((j * 8) & 0xfff8);
		body.push(0x20, 0x04, 0x20, 0x00, 0xa7, 0x29, 0x03, ...off, 0x42);
		if (j === 0) { at = body.length; body.push(0x80, 0x80, 0x80, 0x80, 0x00); } else body.push(...sleb(j * 7919 + k));
		body.push(0x85, 0x7c, 0x21, 0x04);
		if ((j & 7) === 7) body.push(0x20, 0x00, 0xa7, 0x20, 0x04, 0x37, 0x03, ...off);
	}
	body.push(0x20, 0x04, 0x0b);
	const head = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...sec(1, [0x01, 0x60, 0x04, 0x7e, 0x7e, 0x7e, 0x7e, 0x01, 0x7e]),
		...sec(2, [0x02, ...str("env"), ...str("memory"), 0x02, 0x03, 0x01, ...leb(65536), ...str("env"), ...str("table"), 0x01, 0x70, 0x00, 0x01]),
		...sec(3, [0x01, 0x00]),
		...sec(7, [0x01, ...str("f"), 0x00, 0x00])];
	const code = sec(10, [0x01, ...leb(body.length), ...body]);
	const bytes = new Uint8Array([...head, ...code]);
	t = { bytes, at: head.length + (code.length - body.length) + at };
	templates.set(k, t);
	return t;
}
function jitModule(seed, k) {
	const t = template(k), b = t.bytes.slice();
	for (let i = 0; i < 5; i++) b[t.at + i] = (Math.floor(seed / Math.pow(2, 7 * i)) & 0x7f) | (i < 4 ? 0x80 : 0);
	return b;
}
function job(d) {
	switch (d.kind) {
	case "ping":
		postMessage({ ok: true, res: resolution() });
		return;
	case "spin": {
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), x = spinJs(d.iters);
		postMessage({ ms: now() - t0, x });
		return;
	}
	case "busy": {
		postMessage({ ready: true });
		let x = 1;
		while (Atomics.load(d.stop, 0) === 0) x ^= spinJs(100000);
		postMessage({ x });
		return;
	}
	case "tw": {
		const ex = new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports;
		const a = new Int32Array(d.memory.buffer), out = [], end = now() + d.budgetMs;
		for (const c of d.cases) {
			const us = [];
			let odd = 0;
			for (let i = 0; i < c.n && now() < end; i++) {
				const t0 = now();
				const r = c.via === "js" ? Atomics.wait(a, d.word, 0, c.ms) : ex.wait(d.word * 4, 0, BigInt(Math.round(c.ms * 1e6)));
				us.push((now() - t0) * 1000);
				if (r !== "timed-out" && r !== 2) odd++;
			}
			out.push({ via: c.via, ms: c.ms, us, odd });
		}
		postMessage({ out, res: resolution() });
		return;
	}
	case "wake": {
		const a = new Int32Array(d.memory.buffer), W0 = d.base, ACK = d.base + 1, ANN = d.base + 2, STOP = d.base + 3;
		if (d.role === "waiter") {
			const ex = d.via === "wasm" ? new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports : null;
			postMessage({ ready: true });
			outer: for (let r = 1; r <= d.rounds; r++) {
				Atomics.store(a, ANN, r);
				let v;
				while ((v = Atomics.load(a, W0)) !== r) {
					if (Atomics.load(a, STOP)) break outer;
					if (d.via === "js") Atomics.wait(a, W0, v, 2000);
					else if (ex) ex.wait(W0 * 4, v, 2000000000n);
				}
				Atomics.store(a, ACK, r);
			}
			postMessage({ done: true });
			return;
		}
		postMessage({ ready: true });
		go(d.go);
		const lat = [], cost = [], end = now() + d.budgetMs;
		let woke = 0, partial = false;
		for (let r = 1; r <= d.rounds && !partial; r++) {
			while (Atomics.load(a, ANN) !== r) if (now() > end) { partial = true; break; }
			if (partial) break;
			const g = now() + d.gapUs / 1000;
			while (now() < g);
			const t0 = now();
			Atomics.store(a, W0, r);
			if (d.via !== "spin") woke += Atomics.notify(a, W0, 1);
			const t1 = now();
			while (Atomics.load(a, ACK) !== r) if (now() > end) { partial = true; break; }
			if (partial) break;
			lat.push((now() - t0) * 1000);
			cost.push((t1 - t0) * 1000);
		}
		Atomics.store(a, STOP, 1);
		Atomics.store(a, W0, -1);
		Atomics.notify(a, W0);
		postMessage({ lat, cost, woke, partial });
		return;
	}
	case "pong": {
		const a = new Int32Array(d.sab), id = d.id;
		postMessage({ ready: true });
		for (let i = 0; i < d.rounds; i++) {
			let v;
			if (d.wait) while ((v = Atomics.load(a, 0)) !== id) Atomics.wait(a, 0, v);
			else while (Atomics.load(a, 0) !== id);
			Atomics.store(a, 0, 1 - id);
			Atomics.notify(a, 0);
		}
		postMessage({ done: true });
		return;
	}
	case "wasm": {
		const ex = new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports;
		const f = ex[{ shared: "rmw", aload1: "aload", aloadadj: "aload", pload1: "pload" }[d.op] || d.op];
		const call = (n) => d.op === "compute" ? f(n) : f(d.addr, n);
		call(Math.max(1000, d.iters >> 4));
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), x = call(d.iters);
		postMessage({ ms: now() - t0, x });
		return;
	}
	case "compile": {
		const table = new WebAssembly.Table({ element: "anyfunc", initial: 1024 });
		const memory = d.memory || new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
		const one = (seed, k) => { const f = new WebAssembly.Instance(new WebAssembly.Module(jitModule(seed, k)), { env: { memory, table } }).exports.f; f(0n, 0n, 0n, 0n); return f; };
		table.set(1023, one(d.seed - 1, 20));
		for (let k = 10; k < 300; k++) template(k);
		postMessage({ ready: true });
		go(d.go);
		let n = 0, bytes = 0, tc = 0, ti = 0, tf = 0, tt = 0, max = 0, slot = 0, failed = 0, err = "";
		const bins = [0, 0, 0], t0 = now(), end = t0 + d.ms;
		let t = t0;
		while (t < end) {
			const m = jitModule(d.seed + n + failed, 10 + ((n * 37) % 290));
			const a = now();
			try {
				const mod = new WebAssembly.Module(m);
				const b = now();
				const f = new WebAssembly.Instance(mod, { env: { memory, table } }).exports.f;
				const c = now();
				f(0n, 0n, 0n, 0n);
				const e = now();
				table.set(slot, f);
				slot = (slot + 1) % 1023;
				t = now();
				tc += b - a; ti += c - b; tf += e - c; tt += t - e;
				if (t - a > max) max = t - a;
				n++;
				bytes += m.length;
				bins[Math.min(2, Math.floor(((t - t0) / d.ms) * 3))]++;
			} catch (e) {
				failed++;
				err = String((e && e.message) || e);
				t = now();
				if (failed > 20) break;
			}
		}
		postMessage({ n, bytes, tc, ti, tf, tt, max, bins, ms: t - t0, failed, err });
		return;
	}
	case "gc": {
		let keep = null;
		if (d.memory) { keep = new Int32Array(d.memory.buffer); keep[0] |= 0; }
		const ring = new Array(1024);
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), end = t0 + d.ms;
		let last = t0, t = t0, batches = 0, maxGap = 0, over2 = 0;
		while (t < end) {
			for (let i = 0; i < 1000; i++) { const o = { a: i, b: [i, batches], c: null }; o.c = o.b; ring[(batches * 1000 + i) & 1023] = o; }
			batches++;
			t = now();
			const g = t - last;
			last = t;
			if (g > maxGap) maxGap = g;
			if (g > 2) over2++;
		}
		postMessage({ ops: batches * 1000, ms: t - t0, maxGap, over2, attached: keep ? keep.length * 4 : 0 });
		return;
	}
	}
	throw new Error("unknown job " + d.kind);
}
onmessage = (e) => {
	const d = e.data;
	if (d.kind === "parent") {
		const url = URL.createObjectURL(new Blob([d.src], { type: "text/javascript" }));
		const kids = [];
		for (let i = 0; i < d.n; i++) {
			const w = new Worker(url);
			w.onmessage = (m) => postMessage({ i, m: m.data });
			w.onerror = (ev) => { ev.preventDefault(); postMessage({ i, m: { error: "nested worker: " + (ev.message || "error") } }); };
			kids.push(w);
		}
		onmessage = (m) => kids[m.data.to].postMessage(m.data.m);
		return;
	}
	try { job(d); } catch (err) { postMessage({ error: String((err && err.message) || err) }); }
};`,re=null,ie=()=>re??=URL.createObjectURL(new Blob([ne],{type:`text/javascript`})),ae=class{#e=[];#t;#n;push(e){if(e&&typeof e==`object`&&`error`in e)return this.fail(Error(String(e.error)));if(this.#t){let t=this.#t;this.#t=void 0,t.res(e)}else this.#e.push(e)}fail(e){if(this.#n??=e,this.#t){let t=this.#t;this.#t=void 0,t.rej(e)}}next(){return this.#e.length?Promise.resolve(this.#e.shift()):this.#n?Promise.reject(this.#n):new Promise((e,t)=>{this.#t={res:e,rej:t}})}},P=new Set,oe=()=>{for(let e of P)e.close()};async function F(e,t){let n=Array.from({length:e},()=>new ae),r=[],i=e=>n.forEach(t=>t.fail(e)),a,o=performance.now();if(t){let t=new Worker(ie());r.push(t),t.onerror=e=>{e.preventDefault(),i(Error(`parent worker: ${e.message||`error`}`))},t.onmessage=e=>n[e.data.i]?.push(e.data.m),t.postMessage({kind:`parent`,n:e,src:ne}),a=(e,n)=>t.postMessage({to:e,m:n})}else{for(let t=0;t<e;t++){let e=new Worker(ie());e.onerror=e=>{e.preventDefault(),n[t].fail(Error(`worker: ${e.message||`error`}`))},e.onmessage=e=>n[t].push(e.data),r.push(e)}a=(e,t)=>r[e].postMessage(t)}let s={n:e,nested:t,startMs:0,post:a,next:e=>n[e].next(),all:()=>Promise.all(n.map(e=>e.next())),close:()=>{r.forEach(e=>e.terminate()),i(Error(`closed`)),P.delete(s)}};P.add(s);try{for(let t=0;t<e;t++)a(t,{kind:`ping`});await D(s.all(),2e4,`starting ${e} ${t?`nested `:``}workers`)}catch(e){throw s.close(),e}return s.startMs=C(performance.now()-o),s}async function I(e,t,n=6e4){let r=new Int32Array(new SharedArrayBuffer(4));for(let n=0;n<e.n;n++)e.post(n,t(r,n));return await D(e.all(),n,`workers getting ready`),Atomics.store(r,0,1),D(e.all(),n,`workers running`)}var L=e=>{let t=[];do{let n=e&127;e=Math.floor(e/128),e&&(n|=128),t.push(n)}while(e);return t},se=e=>{let t=[];for(;;){let n=e&127;if(e>>=7,e===0&&!(n&64)||e===-1&&n&64)return t.push(n),t;t.push(n|128)}},R=(e,t)=>[e,...L(t.length),...t],ce=e=>[e.length,...Array.from(e,e=>e.charCodeAt(0))],z=(e,t)=>{let n=[...e,...t,11];return[...L(n.length),...n]},B=(e,t,n)=>[2,64,3,64,32,e,32,t,79,13,1,...n,32,e,65,1,106,33,e,12,0,11,11];function le(){let e=e=>[32,0,32,e,65,63,113,65,2,116,106],t=z([1,2,127],[32,0,40,2,0,33,3,...B(2,1,[32,3,65,...se(1103515245),108,65,...se(12345),106,...e(2),40,2,0,106,33,3,32,0,32,2,65,7,106,65,63,113,65,2,116,106,32,3,54,2,0]),32,3]),n=z([1,1,127],[...B(2,1,[32,0,65,1,254,30,2,0,26]),32,0,254,16,2,0]),r=z([1,1,127],[...B(2,1,[32,0,32,2,54,2,0,254,3,0]),32,0,40,2,0]),i=(e,t)=>[32,2,32,2,65,e,t,115,33,2],a=z([1,2,127],[65,1,33,2,...B(1,0,[...i(13,116),...i(17,118),...i(5,116)]),32,2]),o=z([0],[32,0,32,1,32,2,254,1,2,0]),s=z([0],[32,0,32,1,254,0,2,0]),c=e=>z([1,2,127],[...B(2,1,[32,3,32,0,...e,3,0,167,106,33,3]),32,3]),l=c([254,17]),u=c([41]),d=[`plain`,`rmw`,`fence`,`compute`,`wait`,`notify`,`aload`,`pload`];return new Uint8Array([0,97,115,109,1,0,0,0,...R(1,[3,96,2,127,127,1,127,96,3,127,127,126,1,127,96,1,127,1,127]),...R(2,[1,...ce(`env`),...ce(`memory`),2,3,1,...L(65536)]),...R(3,[8,0,0,0,2,1,0,0,0]),...R(7,[8,...d.flatMap((e,t)=>[...ce(e),0,t])]),...R(10,[8,...t,...n,...r,...a,...o,...s,...l,...u])])}var ue=null,de=()=>ue??=new WebAssembly.Module(le()),V=e=>new WebAssembly.Memory({initial:e*16,maximum:e*16,shared:!0}),fe=e=>({minUs:C(Math.min(...e)),medUs:C(b(e)),p95Us:C(x(e,.95)),maxUs:C(Math.max(...e)),meanUs:C(e.reduce((e,t)=>e+t,0)/(e.length||1)),count:e.length}),H=e=>{if(N(),e.cancel)throw new M},U=[1,2,4,8].filter(e=>e<=Math.max(2,f));async function pe(e){let t=e.quick?1e7:1e8,n=e.quick?1:3,r={iters:t,top:[],nested:[]};e.a.spin=r;for(let i of[!1,!0]){let a=i?r.nested:r.top;for(let r of U){H(e),A(`A spin: ${r} ${i?`nested `:``}workers`);let o=await F(r,i);try{await I(o,e=>({kind:`spin`,iters:t/10,go:e}));let e=[];for(let r=0;r<n;r++)e.push(Math.max(...(await I(o,e=>({kind:`spin`,iters:t,go:e}))).map(e=>e.ms)));let i=b(e),s=a[0]?.ms??i;a.push({n:r,ms:C(i),runs:e.map(C),speedup:w(r*s/i),startMs:o.startMs})}finally{o.close()}X()}}}async function me(e){let t=de(),n=V(1),r=[.02,.1,1].flatMap(t=>[`js`,`wasm`].map(n=>({via:n,ms:t,n:e.quick?40:t<1?200:50}))),i={workerResUs:NaN,cases:[]};e.a.timedWait=i;let a=[0,...f>=3?[Math.min(4,f-1)]:[]];for(let o of a){H(e),A(`A timed waits${o?` beside ${o} busy workers`:``}`);let a=await F(1+o,e.nested),s=new Int32Array(new SharedArrayBuffer(4));try{for(let e=1;e<=o;e++)a.post(e,{kind:`busy`,stop:s});for(let e=1;e<=o;e++)await D(a.next(e),2e4,`busy worker`);a.post(0,{kind:`tw`,mod:t,memory:n,word:16,cases:r,budgetMs:e.quick?3e3:1e4});let c=await D(a.next(0),3e4,`timed waits`);i.workerResUs=w(c.res);for(let e of c.out)e.us.length&&i.cases.push({load:o,via:e.via,targetUs:e.ms*1e3,unexpected:e.odd,...fe(e.us)})}finally{Atomics.store(s,0,1),a.close()}X()}}async function he(e){let t={pong:{},gapUs:200,cases:[]};e.a.wake=t;for(let n of[!0,!1]){H(e),A(`A wake: ${n?`wait/notify`:`spinning`} round trips`);let r=(n?5e3:5e4)/(e.quick?5:1),i=new SharedArrayBuffer(8),a=new Int32Array(i);a[0]=-1;let o=await F(2,e.nested);try{o.post(0,{kind:`pong`,sab:i,id:0,rounds:r,wait:n}),o.post(1,{kind:`pong`,sab:i,id:1,rounds:r,wait:n}),await D(o.all(),2e4,`pong workers`);let e=performance.now();Atomics.store(a,0,0),Atomics.notify(a,0),await D(o.all(),3e4,`pong`);let s=w((performance.now()-e)*1e3/r);n?t.pong.waitUs=s:t.pong.spinUs=s}finally{o.close()}}let n=de(),r=[1,2,4].filter(e=>e===1||2*e<=f);for(let i of[`js`,`wasm`,`spin`])for(let a of r){H(e),A(`A wake: ${i}, ${a} pair${a>1?`s`:``}`);let r=V(1),o=e.quick?60:300,s=await F(2*a,e.nested);try{let c=(await I(s,(a,s)=>({kind:`wake`,role:s%2?`waker`:`waiter`,via:i,base:(s>>1)*32,rounds:o,gapUs:t.gapUs,budgetMs:e.quick?3e3:8e3,memory:r,mod:n,go:a}),3e4)).filter((e,t)=>t%2),l=c.flatMap(e=>e.lat),u=c.flatMap(e=>e.cost);l.length&&t.cases.push({via:i,pairs:a,rounds:l.length,notifyUs:w(u.reduce((e,t)=>e+t,0)/u.length),wokeFrac:w(c.reduce((e,t)=>e+t.woke,0)/l.length),partial:c.some(e=>e.partial),...fe(l)})}finally{s.close()}X()}}async function ge(e){let t=de(),n=e.memory??V(16),r={memMiB:e.memory?e.memMiB:16,cases:[]};e.a.wasm=r;let i=e.quick?1:3,a=e.quick?60:150,o=[`compute`,`plain`,`rmw`,`shared`,`fence`,`aload`,`aloadadj`,`aload1`,`pload1`],s=(e,t)=>e===`shared`||e===`aload1`||e===`pload1`?524288:e===`aloadadj`?786432+t*8:1048576+t*4096,c=await F(1,e.nested);try{for(let i of o){H(e),A(`A wasm: calibrating ${i}`);let o=1e6,l=0;for(let e=0;e<4&&(l=(await I(c,e=>({kind:`wasm`,mod:t,memory:n,op:i,addr:s(i,0),iters:o,go:e})))[0].ms,!(l>=20));e++)o*=10;r.cases.push({op:i,iters:Math.min(2e9,Math.max(1e3,Math.round(o*a/Math.max(l,.1)))),rows:[]})}}finally{c.close()}for(let a of U){H(e);let o=await F(a,e.nested);try{for(let c of r.cases){H(e),A(`A wasm: ${c.op} in ${a} workers`);let r=[],l=c.op===`shared`,u=l?Math.ceil(c.iters/a):c.iters;for(let e=0;e<i;e++)r.push(Math.max(...(await I(o,(e,r)=>({kind:`wasm`,mod:t,memory:n,op:c.op,addr:s(c.op,r),iters:u,go:e}))).map(e=>e.ms)));let d=b(r),f=c.rows[0]?.ms??d;c.rows.push({n:a,ms:C(d),runs:r.map(C),speedup:w((l?1:a)*f/d),nsPerOp:w(d*1e6/(l?u*a:u))}),X()}}finally{o.close()}}}var _e=1;async function ve(e){let t={cases:[{mem:e.memory?`one shared ${e.memMiB} MiB memory (as kwemu)`:`one shared 16 MiB memory`,rows:[]},{mem:`own small shared memory per worker`,rows:[]}]};e.a.compile=t;let n=e.memory??V(16),r=e.quick?400:1e3;for(let i of U){H(e);let a=await F(i,e.nested);try{for(let[o,s]of t.cases.entries()){H(e),A(`A compile: ${i} workers, ${o?`own memory`:`one memory`}`),_e+=1e7;let t=await I(a,(e,t)=>({kind:`compile`,memory:o?null:n,ms:r,seed:_e+t*1e6,go:e}),r+6e4),c=e=>t.reduce((t,n)=>t+e(n),0),l=c(e=>e.n),u=c(e=>e.n*1e3/e.ms),d=s.rows[0]?.perSec??u,f=e=>C(c(e)*1e3/Math.max(1,l)),p=t.find(e=>e.err)?.err;s.rows.push({n:i,perSec:S(u),perWorker:S(u/i),speedup:w(u/d),usCompile:f(e=>e.tc),usInstantiate:f(e=>e.ti),usCall:f(e=>e.tf),usTable:f(e=>e.tt),maxMs:C(Math.max(...t.map(e=>e.max))),bytesAvg:S(c(e=>e.bytes)/Math.max(1,l)),thirds:[0,1,2].map(e=>c(t=>t.bins[e])),failed:c(e=>e.failed),...p?{err:p}:{}}),X()}}finally{a.close()}}}async function ye(e){let t=e.memory?e.memMiB:0,n={memMiB:t,cases:[{attached:!1,rows:[]},...e.memory?[{attached:!0,rows:[]}]:[]]};e.a.gc=n;let r=e.quick?400:1e3;for(let i of U)for(let a of n.cases){H(e),A(`A gc: ${i} workers${a.attached?`, ${t} MiB attached`:``}`);let n=await F(i,e.nested);try{let t=await I(n,t=>({kind:`gc`,memory:a.attached?e.memory:null,ms:r,go:t}),r+6e4),o=t.reduce((e,t)=>e+t.ops/t.ms/1e3,0),s=a.rows[0]?.mops??o;a.rows.push({n:i,mops:w(o),speedup:w(o/s),maxPauseMs:C(Math.max(...t.map(e=>e.maxGap))),pausesOver2:t.reduce((e,t)=>e+t.over2,0)})}finally{n.close()}X()}}var be=[{id:`spin`,label:`spin workers, top-level and nested`,run:pe,timeout:12e4},{id:`timedWait`,label:`timed wait accuracy (20 µs, 100 µs, 1 ms)`,run:me,timeout:9e4},{id:`wake`,label:`notify-to-wake latency, round trips`,run:he,timeout:15e4},{id:`wasm`,label:`wasm on one shared memory`,run:ge,timeout:15e4},{id:`compile`,label:`compile + instantiate + table.set`,run:ve,timeout:12e4},{id:`gc`,label:`GC churn, shared memory attached or not`,run:ye,timeout:9e4}],xe=d.get(`probes`)?.split(`,`);u(`probes`).innerHTML=be.map(e=>`<label><input type="checkbox" data-probe="${e.id}"${!xe||xe.includes(e.id)?` checked`:``}> ${e.label}</label>`).join(``);async function Se(){let e=u(`nested`).checked,t=d.get(`quick`)===`1`,n={nested:e,errors:{}};K.a=n,K.options.a={nested:e,quick:t,probeMemMiB:Number(u(`pmem`).value)||512};let r=null,i=Number(u(`pmem`).value)||512;for(;!r&&i>=16;)try{r=V(i)}catch{k(`A: a shared memory of ${i} MiB was refused`),i>>=1}n.probeMemMiB=r?i:0;for(let a of be){if(j)break;if(!document.querySelector(`[data-probe="${a.id}"]`).checked)continue;k(`A: ${a.label}`);let o=performance.now(),s={a:n,nested:e,memory:r,memMiB:i,quick:t,cancel:!1};try{let e=a.run(s);e.catch(()=>{}),await D(e,a.timeout,a.id).finally(()=>{s.cancel=!0})}catch(e){e instanceof M||(n.errors[a.id]=T(e),k(`A: ${a.id} failed: ${T(e)}`))}finally{oe()}k(`A: ${a.id} took ${C((performance.now()-o)/1e3)} s`),X()}}var Ce=[{id:`1`,label:`1 CPU (UP kernel)`,cpus:1,jit:!0,base:`1`,scale:1,variants:!1,on:!0},{id:`2`,label:`2 CPUs`,cpus:2,jit:!0,base:`1`,scale:1,variants:!1,on:!0},{id:`4`,label:`4 CPUs (+ the parameter variants)`,cpus:4,jit:!0,base:`1`,scale:1,variants:!0,on:!0},{id:`8`,label:`8 CPUs`,cpus:8,jit:!0,base:`1`,scale:1,variants:!1,on:!1},{id:`1-nojit`,label:`1 CPU, JIT off (0.25x work)`,cpus:1,jit:!1,base:`1-nojit`,scale:.25,variants:!1,on:!0},{id:`4-nojit`,label:`4 CPUs, JIT off (0.25x work)`,cpus:4,jit:!1,base:`1-nojit`,scale:.25,variants:!1,on:!0}].filter(e=>e.cpus===1||!m&&e.cpus<=p),W=[{id:`default`,label:`defaults`,params:{}},{id:`spin0`,label:`kw_spin_us=0 (spin only)`,params:{kw_spin_us:`0`}},{id:`spin2000`,label:`kw_spin_us=2000`,params:{kw_spin_us:`2000`}},{id:`fair`,label:`kw_spin_unfair=0 (ticket locks)`,params:{kw_spin_unfair:`0`}}],we=[`kw_spin_us`,`kw_spin_sleep_us`,`kw_spin_unfair`],G=[{id:`compute`,label:`user compute (awk loop)`,n0:1e5,cmd:e=>`awk 'BEGIN{s=0;for(i=0;i<${e};i++)s+=i%7;print s}'`},{id:`syscall`,label:`syscalls (dd bs=1)`,n0:2e4,cmd:e=>`dd if=/dev/zero of=/dev/null bs=1 count=${e}`},{id:`fork`,label:`fork+exec /bin/true`,n0:20,cmd:e=>`i=0; while [ $i -lt ${e} ]; do /bin/true; i=$((i+1)); done`}],Te=(e,t)=>`w() { read a _ < /proc/uptime; ${e} >/dev/null 2>&1; read b _ < /proc/uptime; echo "T $a $b"; }
j=0; while [ $j -lt ${t} ]; do w & j=$((j+1)); done; wait`,Ee=d.get(`configs`)?.split(`,`),De=d.get(`variants`)?.split(`,`);u(`configs`).innerHTML=Ce.map(e=>`<label><input type="checkbox" data-conf="${e.id}"${(Ee?Ee.includes(e.id):e.on)?` checked`:``}> ${e.label}</label>`).join(``)+(m?`<div class="dim">No SMP: ${m}</div>`:``),u(`variants`).innerHTML=`<span class="dim">variants on 4 CPUs:</span> `+W.map(e=>`<label><input type="checkbox" data-variant="${e.id}"${!De||De.includes(e.id)?` checked`:``}${e.id==="default"?` disabled`:``}> ${e.label}</label>`).join(``),u(`distro`).innerHTML=[...r.map(e=>e.name),`none`].map(e=>`<option${e===(d.get(`distro`)??s)?` selected`:``}>${e}</option>`).join(``);for(let e of[`mem`,`runs`,`scale`,`sizes`,`pmem`])d.has(e)&&(u(e).value=d.get(e));d.get(`nested`)===`0`&&(u(`nested`).checked=!1);var Oe=new Map;function ke(e){let t=(e?i:o).href,r=Oe.get(t);return r||Oe.set(t,r=n(t,{what:`kernel`})),r}async function Ae(e){await v(600);try{return e.stats()}catch{return}}async function je(e,t){let[n=``,r=``,i=``]=(await e.exec(`sh`,[`-c`,`cat /proc/kwmove 2>/dev/null; echo ===; cat /proc/interrupts 2>/dev/null; echo ===; cat /proc/stat`],{signal:t,timeout:3e4})).stdout.split(`===
`),a={},o=n.trim().split(/\s+/);for(let e=0;e+1<o.length;e+=2)a[o[e]]=Number(o[e+1]);let s={};for(let e of i.split(`
`)){let t=e.trim().split(/\s+/);t[0]&&t.length>1&&(s[t[0]]=t.slice(1).map(Number))}let c={},l=r.split(`
`),u=(l[0]?.match(/CPU\d+/g)??[]).length;for(let e of l.slice(1)){let t=e.trim().split(/\s+/);if(!t[0]?.endsWith(`:`))continue;let n=t.slice(1,1+u).map(Number);n.some(e=>!Number.isFinite(e))||(c[`${t[0]} ${t.slice(1+u).join(` `)}`.trim()]=n)}return{kwmove:a,stat:s,irq:c}}function Me(e,t,n,r){let i={};if(e&&t&&Ne(i,e,t),n&&r){let e=n.jitCpus??[n.jit];i.jit=(r.jitCpus??[r.jit]).map((t,n)=>{let r=e[n]??t;return{compiled:t.compiled-r.compiled,compileMs:C(t.compileMs-r.compileMs),maxCompileMs:C(t.maxCompileMs),failed:t.failed-r.failed,refused:t.refused-r.refused,retained:t.retained}}),i.kernel={switches:r.switches-n.switches,idles:r.idles-n.idles,yields:r.yields-n.yields}}return i}function Ne(e,t,n){e.cpu=Object.keys(n.stat).filter(e=>/^cpu\d+$/.test(e)).sort((e,t)=>Number(e.slice(3))-Number(t.slice(3))).map(e=>{let r=t.stat[e]??[],i=n.stat[e].map((e,t)=>e-(r[t]??0)),[a=0,o=0,s=0,c=0,l=0,u=0,d=0]=i,f=Math.max(1,i.slice(0,8).reduce((e,t)=>e+t,0));return{busy:S(100*(f-c-l)/f),user:S(100*(a+o)/f),sys:S(100*(s+u+d)/f),idle:S(100*(c+l)/f)}});let r=e=>(n.stat[e]?.[0]??0)-(t.stat[e]?.[0]??0);e.ctxt=r(`ctxt`),e.processes=r(`processes`),e.intr=r(`intr`),Object.keys(n.kwmove).length&&(e.kwmove=Object.fromEntries(Object.entries(n.kwmove).map(([e,n])=>[e,n-(t.kwmove[e]??0)]))),e.irq={};for(let[r,i]of Object.entries(n.irq)){let n=i.map((e,n)=>e-(t.irq[r]?.[n]??0));n.some(e=>e)&&(e.irq[r]=n)}}var Pe=(e,t)=>e.exec(`sh`,[`-c`,`cd /sys/module/kernel/parameters 2>/dev/null && for p in `+we.join(` `)+`; do [ -e $p ] && echo "$p=$(cat $p)"; done; true`],{signal:t,timeout:3e4}).then(e=>Object.fromEntries(e.stdout.trim().split(`
`).filter(Boolean).map(e=>e.split(`=`))));async function Fe(e,t,n){let r=Object.entries(t).map(([e,t])=>`${e}=${t}`);if(!r.length)return;let i=await l(e,'for kv in "$@"; do echo "${kv#*=}" > "/sys/module/kernel/parameters/${kv%%=*}" || exit 1; done',r,{signal:n,timeout:3e4});if(i.exitCode!==0)throw Error(`writing ${r.join(` `)} failed: ${i.stderr.trim().slice(0,200)}`)}async function Ie(t,n,i,a){let o={conf:t.id,label:t.label,cpus:t.cpus,jit:t.jit,cells:[],variantParams:{}},s=t.cpus>1;A(`B ${t.label}: loading the kernel`);let c;try{let l=await D(ke(s),18e4,`loading the kernel`),u=r.find(e=>e.name===n.distro)?.url;A(`B ${t.label}: booting`);let d=performance.now();c=await D(e({kernel:l,memoryMiB:n.memMiB,jit:t.jit,distro:u,vsock:!0,worker:!0,cpus:s?t.cpus:void 0,display:!1,sound:!1,consoleSize:{cols:80,rows:24},log:e=>console.log(e)}),18e4,`booting`),o.kernelMs=S(performance.now()-d),await c.exec(`true`,[],{timeout:18e4,signal:a}),o.bootMs=S(performance.now()-d);let[f=`?`,...p]=(await c.exec(`sh`,[`-c`,`nproc; uname -rv; cat /run/kw-base 2>/dev/null`],{signal:a,timeout:3e4})).stdout.trim().split(`
`);o.nproc=f,o.uname=p.join(` | `),o.params=await Pe(c,a).catch(()=>({})),k(`B ${t.label}: kernel up in ${o.kernelMs} ms, shell in ${o.bootMs} ms, nproc ${o.nproc}, ${o.uname}, ${JSON.stringify(o.params)}`);let m=async e=>{let t=performance.now(),n=await c.exec(`sh`,[`-c`,e],{signal:a,timeout:3e5}),r=performance.now()-t;if(n.exitCode!==0)throw Error(`exit ${n.exitCode??`signal ${n.signal}`}: ${n.stderr.trim().slice(0,200)}`);return{ms:r,copies:[...n.stdout.matchAll(/^T ([\d.]+) ([\d.]+)$/gm)].map(e=>(Number(e[2])-Number(e[1]))*1e3)}};for(let e of G){if(n.sizes[e.id])continue;N(),A(`B ${t.label}: calibrating ${e.id}`);let r=e.n0,i=0;for(let t=0;t<5&&(i=(await m(Te(e.cmd(r),1))).ms,!(i>=150));t++)r*=i<15?10:3;n.sizes[e.id]=Math.max(1,Math.round(r*300*n.scale/Math.max(i,1)/t.scale)),k(`B: ${e.id} size ${n.sizes[e.id]} (one copy took ${S(i)} ms at ${r})`)}let h=await Ae(c);for(let e of t.variants?i:[W[0]]){if(N(),t.variants){try{await Fe(c,{...o.params,...e.params},a),o.variantParams[e.id]=await Pe(c,a)}catch(n){if(n instanceof M||a.aborted)throw n;k(`B ${t.label}: ${e.label}: ${T(n)}; skipped`),o.variantParams[e.id]={error:T(n)};continue}h=await Ae(c)}for(let r of G){N();let i=Math.max(1,Math.round(n.sizes[r.id]*t.scale)),s={variant:e.id,work:r.id,copies:n.copies,size:i,cold:NaN,runs:[],median:NaN};o.cells.push(s);let l=[],u,d;try{for(let o=0;o<=n.runs;o++){N(),A(`B ${t.label}${e.id==="default"?``:`, ${e.label}`}: ${r.label} x${n.copies} (${o+1}/${n.runs+1})`);let f=o===n.runs;f&&(u=await je(c,a).catch(()=>void 0));let p=await m(Te(r.cmd(i),n.copies));f&&(d=await je(c,a).catch(()=>void 0)),o===0?s.cold=S(p.ms):(s.runs.push(S(p.ms)),l.push(...p.copies))}s.median=b(s.runs),l.length&&(s.perCopy={min:S(Math.min(...l)),max:S(Math.max(...l))})}catch(n){if(n instanceof M)throw n;s.error=T(n),k(`B ${t.label} ${e.id} ${r.id}: ${s.error}`)}let f=await Ae(c);s.deltas=Me(u,d,h,f),h=f,X()}}}catch(e){e instanceof M||a.aborted?o.error??=`stopped`:(o.error=T(e),k(`B ${t.label}: ${o.error}`))}finally{A(`B ${t.label}: stopping`),await D(c?.stop()??Promise.resolve(),15e3,`stopping the kernel`).catch(e=>k(`B ${t.label}: ${T(e)}`))}return o}var Le=null;async function Re(){let e=Ce.filter(e=>document.querySelector(`[data-conf="${e.id}"]`).checked),t=W.filter(e=>e.id==="default"||document.querySelector(`[data-variant="${e.id}"]`).checked),n={};for(let e of u(`sizes`).value.split(`,`)){let[t,r]=e.split(`:`).map(e=>e.trim());t&&Number(r)>0&&(n[t]=Number(r))}let r={distro:u(`distro`).value,memMiB:Number(u(`mem`).value)||512,runs:Math.max(1,Number(u(`runs`).value)||1),scale:Number(u(`scale`).value)||1,copies:Math.max(4,...e.map(e=>e.cpus)),sizes:n,boots:[]};K.b=r,K.options.b={configs:e.map(e=>e.id),variants:t.map(e=>e.id)},Le=new AbortController;for(let n of e){if(j)break;let e=performance.now();r.boots.push(await Ie(n,r,t,Le.signal)),k(`B: ${n.label} took ${C((performance.now()-e)/1e3)} s`),X()}u(`sizes`).value=Object.entries(r.sizes).map(([e,t])=>`${e}:${t}`).join(`,`)}var K={env:g,date:new Date().toISOString(),options:{}};function ze(e){let t=[`A. Engine probes (no kernel; workers ${e.nested?`nested in one worker, as the kernel's CPUs`:`top-level`}; probe memory ${e.probeMemMiB??`?`} MiB shared)`],n=(e,t)=>e.map(e=>`n=${e.n} ${E(e.ms)} ms ${E(e.speedup,2)}x${t?t(e):``}`).join(` | `);e.spin&&(t.push(`spin (JS integer loop, ${e.spin.iters/1e6}M iterations per worker; wall = slowest worker, median; ideal speedup = n):`),t.push(`  top-level: ${n(e.spin.top)}  (start ${e.spin.top.map(e=>e.startMs).join(`/`)} ms)`),t.push(`  nested:    ${n(e.spin.nested)}  (start ${e.spin.nested.map(e=>e.startMs).join(`/`)} ms)`));let r=e=>`${E(e.minUs)} / ${E(e.medUs)} / ${E(e.p95Us)} / ${E(e.maxUs)}, mean ${E(e.meanUs)} (${e.count})`;if(e.timedWait){t.push(`timed wait on a word nobody notifies (actual µs: min / median / p95 / max, mean (samples); worker timer step ${e.timedWait.workerResUs} µs):`);for(let n of e.timedWait.cases)t.push(`  ${(n.load?`beside ${n.load} busy`:`idle`).padEnd(13)} ${n.via.padEnd(4)} ${String(n.targetUs).padStart(5)} µs: ${r(n)}${n.unexpected?`  ${n.unexpected} did not time out`:``}`)}if(e.wake){t.push(`wake latency: notify -> the waiter's ack seen by the spinning waker, ${e.wake.gapUs} µs after the waiter blocked (µs: min / median / p95 / max, mean; notify call mean; share of notifies that woke a blocked waiter):`);for(let n of e.wake.cases)t.push(`  ${n.via.padEnd(4)} ${n.pairs} pair${n.pairs>1?`s`:` `}: ${r(n)}; notify ${E(n.notifyUs,1)} µs; woke ${E(n.wokeFrac,2)}${n.partial?` (partial: timed out)`:``}`);t.push(`  round trip between two workers (profile.html's Host threads): Atomics.wait/notify ${e.wake.pong.waitUs??`?`} µs, spinning ${e.wake.pong.spinUs??`?`} µs`)}if(e.wasm){t.push(`wasm in n workers on one shared memory of ${e.wasm.memMiB} MiB (wall ms, median; speedup n*t1/tn; ns per op per worker; "shared": atomic adds to one word, the same total split among the workers, speedup t1/tn, ns per op overall; "aload": i64.atomic.load in a loop, each worker its own page; "aloadadj": on adjacent words; "aload1": all on one word, as kwemu's code epoch at every block end; "pload1": a plain load of that word):`);for(let r of e.wasm.cases)t.push(`  ${r.op.padEnd(8)} ${n(r.rows,e=>` ${E(e.nsPerOp,2)}ns`)}`)}if(e.compile){t.push(`compile + instantiate + first call + table.set of distinct small modules for about 1 s per worker (modules/s in all, speedup; µs per module: compile / instantiate / call / table.set; longest ms; modules in each third of the time):`);for(let n of e.compile.cases){t.push(`  ${n.mem}:`);for(let e of n.rows)t.push(`    n=${e.n} ${e.perSec}/s ${E(e.speedup,2)}x (${e.perWorker}/s each): ${E(e.usCompile)} / ${E(e.usInstantiate)} / ${E(e.usCall)} / ${E(e.usTable)} µs, max ${E(e.maxMs,1)} ms, ${e.bytesAvg} B avg, thirds ${e.thirds.join(`/`)}${e.failed?`, ${e.failed} failed: ${e.err}`:``}`)}}if(e.gc){t.push(`GC churn, small objects for about 1 s per worker (M objects/s in all, speedup; longest pause; pauses over 2 ms):`);for(let n of e.gc.cases)t.push(`  ${(n.attached?`${e.gc.memMiB} MiB attached`:`no memory`).padEnd(16)} ${n.rows.map(e=>`n=${e.n} ${E(e.mops,1)} ${E(e.speedup,2)}x ${E(e.maxPauseMs,1)}ms/${e.pausesOver2}`).join(` | `)}`)}for(let[n,r]of Object.entries(e.errors))t.push(`error in ${n}: ${r}`);return t}function Be(e,t,n){let r=Ce.find(e=>e.id===t.conf)?.base??`1`;return e.boots.find(e=>e.conf===r)?.cells.find(e=>e.variant==="default"&&e.work===n)?.median}function q(e,t,n,r){return e.boots.find(e=>e.conf===t)?.cells.find(e=>e.variant===n&&e.work===r)}function J(e,t,n,r){let i=e.boots.find(e=>e.conf===t),a=q(e,t,n,r),o=i&&Be(e,i,r);return a&&o&&Number.isFinite(a.median)?o/a.median:void 0}function Ve(e){let t=[`B. Kernel (distro ${e.distro}, ${e.memMiB} MiB, ${e.copies} copies at once of each workload, sizes ${Object.entries(e.sizes).map(([e,t])=>`${e}:${t}`).join(`,`)}, ${e.runs} run${e.runs>1?`s`:``} + a cold one)`];t.push(`wall ms of ${e.copies} copies (speedup against the same work on 1 CPU; JIT-off rows against 1 CPU JIT off) [slowest copy ms]; cold run in ()`),t.push(`${``.padEnd(30)}${G.map(e=>e.id.padEnd(30)).join(``)}`);for(let n of e.boots){let r=[...new Set(n.cells.map(e=>e.variant))];r.length||t.push(`${n.label.padEnd(30)}${n.error?`error: ${n.error}`:`-`}`);for(let i of r){let r=Object.entries(W.find(e=>e.id===i)?.params??{}).map(([e,t])=>`${e}=${t}`).join(` `),a=`${n.cpus} CPU${n.cpus>1?`s`:``}${n.jit?``:` nojit`} ${r}`;t.push(a.padEnd(30)+G.map(t=>{let r=n.cells.find(e=>e.variant===i&&e.work===t.id);if(!r)return`-`.padEnd(30);if(r.error)return`error`.padEnd(30);let a=J(e,n.conf,i,t.id);return`${E(r.median)} ${E(a,2)}x [${r.perCopy?.max??`-`}] (${E(r.cold)})`.padEnd(30)}).join(``))}n.error&&r.length&&t.push(`  ${n.label}: error: ${n.error}`)}t.push(`boots: `+e.boots.map(e=>`${e.conf}: shell ${e.bootMs??`-`} ms, nproc ${e.nproc??`-`}${e.params&&Object.keys(e.params).length?`, ${Object.entries(e.params).map(([e,t])=>`${e}=${t}`).join(` `)}`:``}`).join(`; `));let n=e.boots.find(e=>e.uname)?.uname;n&&t.push(`kernel: ${n}`),t.push(`details per cell (the guest's /proc over the last timed run: CPU busy% (user+sys) per CPU, idle%, context switches, processes, kwmove, IRQs per CPU; the JIT over all the cell's runs: compiles/ms per CPU (longest compile ms)):`);for(let n of e.boots)for(let e of n.cells){let r=e.deltas;if(!r)continue;let i=[];r.cpu?.length&&i.push(`busy ${r.cpu.map(e=>`${e.busy}(${e.user}+${e.sys})`).join(` `)} idle ${r.cpu.map(e=>e.idle).join(`/`)}`),i.push(`ctxt ${r.ctxt} procs ${r.processes}`),r.kwmove&&i.push(`kwmove ${Object.entries(r.kwmove).filter(([,e])=>e).map(([e,t])=>`${e} ${t}`).join(` `)||`0`}`),r.irq&&Object.keys(r.irq).length&&i.push(`irq ${Object.entries(r.irq).map(([e,t])=>`${e.replace(/\s+/g,` `)} ${t.join(`/`)}`).join(`; `)}`),r.jit&&i.push(`jit ${r.jit.map(e=>`${e.compiled}/${E(e.compileMs)}ms(${E(e.maxCompileMs,1)})`).join(` `)}${r.jit.some(e=>e.refused||e.failed)?` refused ${r.jit.map(e=>e.refused).join(`/`)} failed ${r.jit.map(e=>e.failed).join(`/`)}`:``}`),t.push(`  ${n.conf} ${e.variant} ${e.work}: ${i.join(`; `)}`)}return t}function He(e){let t=[`READING (heuristic: simple thresholds on the numbers above, not a proof)`],n=e.a,r=e.b,i=(e,t)=>e?.find(e=>e.n===t)??e?.filter(e=>e.n<=t).pop(),a=Math.min(4,Math.max(...U)),o=i(n?.spin?.top,a)?.speedup,s=i(n?.spin?.nested,a)?.speedup;if(o==null&&s==null)t.push(`H3 threads in parallel: no data`);else{let e=(o??99)<a*.7||(s??99)<a*.7,n=o!=null&&s!=null&&s<o*.75;t.push(`H3 threads in parallel: ${e||n?`INDICATED`:`not indicated`} (JS spin speedup at n=${a}: top-level ${E(o,2)}x, nested ${E(s,2)}x; flagged below ${C(a*.7)}x, or nested below 0.75x of top-level)`)}let c=n?.timedWait?.cases.filter(e=>!e.load),l=c?.find(e=>e.via===`wasm`&&e.targetUs===100)??c?.find(e=>e.targetUs===100),u=c?.find(e=>e.via===`wasm`&&e.targetUs===20)??c?.find(e=>e.targetUs===20),d=n?.wake?.cases.find(e=>e.via===`wasm`&&e.pairs===1)??n?.wake?.cases.find(e=>e.via===`js`&&e.pairs===1),f=n?.wake?.cases.find(e=>e.via===`spin`&&e.pairs===1),p=n?.wake?.cases.filter(e=>e.via===d?.via).pop(),m=r&&Ue(r,`spin0`),h=r&&Ue(r,`spin2000`);if(!l&&!d&&m==null)t.push(`H1 waits: no data`);else{let e=l?l.medUs>300||(u?.medUs??0)>150:!1,n=d?d.medUs>100:!1,r=d&&p&&p.pairs>1?p.medUs>d.medUs*3:!1,i=(m??0)>1.3||(h??0)>1.3;t.push(`H1 waits: ${e||n||r||i?`INDICATED`:`not indicated`} (`+[l?`100 µs timed wait sleeps ${E(l.medUs)} µs at the median (${l.via}), 20 µs sleeps ${E(u?.medUs)} µs; flagged above 300 / 150`:``,d?`notify-to-wake ${E(d.medUs)} µs median, p95 ${E(d.p95Us)} (${d.via}; spinning ${E(f?.medUs,1)}); flagged above 100`:``,r?`with ${p.pairs} pairs ${E(p.medUs)} µs, over 3x one pair`:``,m==null?``:`kernel kw_spin_us=0 vs defaults ${E(m,2)}x faster`,h==null?``:`kw_spin_us=2000 ${E(h,2)}x; flagged above 1.3x`].filter(Boolean).join(`; `)+`)`)}let ee=n?.compile?.cases[0],te=n?.compile?.cases[1],g=i(ee?.rows,a),_=i(te?.rows,a),v=r&&We(r);if(!g&&v==null)t.push(`H2 compile lock: no data`);else{let e=g?g.speedup<a*.4:!1,n=g&&_?_.speedup>g.speedup*1.5:!1,r=g?g.thirds[2]<g.thirds[0]*.6:!1,i=v!=null&&v>1.5;t.push(`H2 compile lock: ${e||n||i?`INDICATED`:`not indicated`} (`+[g?`compile+instantiate speedup at n=${g.n} ${E(g.speedup,2)}x with one memory, ${E(_?.speedup,2)}x with own memories; flagged below ${C(a*.4)}x, or own memories 1.5x better (a per-memory lock)`:``,r?`rate falls over the second (thirds ${g.thirds.join(`/`)})`:``,v==null?``:`kernel: 4-CPU speedup with the JIT off is ${E(v,2)}x that with it on; flagged above 1.5x`].filter(Boolean).join(`; `)+`)`)}let y=i(n?.gc?.cases.find(e=>!e.attached)?.rows,a),b=i(n?.gc?.cases.find(e=>e.attached)?.rows,a);if(!y||!b)t.push(`H4 GC pressure: no data`);else{let e=b.mops<y.mops*.6,n=b.maxPauseMs>Math.max(20,y.maxPauseMs*3);t.push(`H4 GC pressure: ${e||n?`INDICATED`:`not indicated`} (n=${b.n}: ${E(b.mops,1)} vs ${E(y.mops,1)} M objects/s with and without the memory, longest pause ${E(b.maxPauseMs,1)} vs ${E(y.maxPauseMs,1)} ms; flagged below 0.6x or pauses over 3x and 20 ms)`)}let x=e=>i(n?.wasm?.cases.find(t=>t.op===e)?.rows,a),w=x(`compute`),T=x(`plain`),D=x(`rmw`),O=x(`fence`),k=x(`shared`);if(!T)t.push(`H5 wasm on a shared memory: no data`);else{let e=a*.7,n=T.speedup<e||(D?.speedup??99)<e||(O?.speedup??99)<e;t.push(`H5 wasm on a shared memory: ${n?`INDICATED`:`not indicated`} (speedup at n=${T.n}: compute ${E(w?.speedup,2)}x, plain ${E(T.speedup,2)}x, atomic RMW ${E(D?.speedup,2)}x, fence ${E(O?.speedup,2)}x on disjoint addresses; one shared word ${E(k?.nsPerOp,1)} ns/op; flagged below ${C(e)}x)`)}let A=x(`aload`),j=x(`aload1`),M=x(`aloadadj`);if(A&&j){let e=j.speedup<.6*A.speedup;t.push(`H6 atomic loads of one word: ${e?`INDICATED`:`not indicated`} (i64.atomic.load speedup at n=${j.n}: own pages ${E(A.speedup,2)}x, adjacent words ${E(M?.speedup,2)}x, one word ${E(j.speedup,2)}x, ${E(j.nsPerOp,1)} ns/op; flagged when one word scales below 0.6x of own pages: the engine's atomic load takes the cache line as a write would)`)}if(r?.boots.length){let e=[];for(let t of G){let n=J(r,`4`,`default`,t.id),i=J(r,`2`,`default`,t.id);(n!=null||i!=null)&&e.push(`${t.id} ${E(i,2)}x on 2, ${E(n,2)}x on 4`)}e.length&&t.push(`kernel speedups (defaults): ${e.join(`; `)}`);let n=Ue(r,`fair`);n!=null&&t.push(`kernel kw_spin_unfair=0 vs defaults: ${E(n,2)}x (above 1: ticket locks help)`);let i=q(r,`4`,`default`,`compute`)?.deltas?.cpu;if(i?.length){let e=i.reduce((e,t)=>e+t.idle,0)/i.length,n=i.reduce((e,t)=>e+t.sys,0)/i.length;t.push(`4 CPUs, compute: CPUs ${S(e)}% idle and ${S(n)}% system on average (the guest's view). Much idle while ${r.copies} copies are runnable: CPUs wait to be woken (H1, wakeups and IPIs); much system time: lock waits or kernel work (H1 blocked lock waits, H2 if the JIT counters are high)`)}}return t}function Ue(e,t){let n=G.map(n=>{let r=q(e,`4`,`default`,n.id)?.median,i=q(e,`4`,t,n.id)?.median;return r&&i?r/i:NaN}).filter(Number.isFinite);return n.length?Math.exp(n.reduce((e,t)=>e+Math.log(t),0)/n.length):void 0}function We(e){let t=G.map(t=>{let n=J(e,`4`,`default`,t.id),r=J(e,`4-nojit`,`default`,t.id);return n&&r?r/n:NaN}).filter(Number.isFinite);return t.length?Math.exp(t.reduce((e,t)=>e+Math.log(t),0)/t.length):void 0}function Y(){let e=K,t=[`unkernel SMP probe`,`date ${e.date}${e.durationS?`, took ${e.durationS} s`:``}`,`ua ${g.ua}`,`hardwareConcurrency ${g.hardwareConcurrency}, deviceMemory ${g.deviceMemory??`?`}, crossOriginIsolated ${g.crossOriginIsolated}, isSecureContext ${g.isSecureContext}, origin ${g.origin} (${g.originKind}), jspi ${g.jspi}, smp ${g.smp}, timer step ${g.timerResUs} µs`,`build ${g.build}; kernels ${g.kernelUrl} / ${g.kernelSmpUrl??`-`}`,..._.map(e=>`WARNING ${e}`),``];return e.a&&t.push(...ze(e.a),``),e.b&&t.push(...Ve(e.b),``),t.push(...e.reading??He(e)),t.join(`
`)}function X(){K.reading=He(K),u(`report`).textContent=Y(),u(`report`).classList.remove(`dim`),u(`copytext`).disabled=u(`copyjson`).disabled=!1}async function Ge(e){try{await navigator.clipboard.writeText(e),A(`copied`)}catch{u(`log`).textContent=e,A(`clipboard unavailable: the log shows it to copy`)}}var Z={running:!1,done:!1,report:()=>K,text:Y};globalThis.smpProbe=Z;var Ke=[`runall`,`runa`,`runb`];async function Q(e,t){if(Z.running)return;Z.running=!0,Z.done=!1,j=!1,Ke.forEach(e=>u(e).disabled=!0),u(`stop`).disabled=!1,O.textContent=``,K={env:g,date:new Date().toISOString(),options:{url:location.search}};let n=performance.now();try{e&&await Se(),t&&!j&&await Re()}catch(e){k(`failed: ${T(e)}`)}K.durationS=S((performance.now()-n)/1e3),X();try{localStorage.setItem(`kw-smp-probe-last`,JSON.stringify(K))}catch{}k(K.reading?.join(`
`)??``),A(j?`stopped`:`done in ${K.durationS} s`),Ke.forEach(e=>u(e).disabled=!1),u(`stop`).disabled=!0,Z.running=!1,Z.done=!0}u(`runall`).onclick=()=>void Q(!0,!0),u(`runa`).onclick=()=>void Q(!0,!1),u(`runb`).onclick=()=>void Q(!1,!0),u(`stop`).onclick=()=>{j=!0,Le?.abort(),oe()},u(`copytext`).onclick=()=>void Ge(Y()),u(`copyjson`).onclick=()=>void Ge(JSON.stringify(K,null,1));try{let e=localStorage.getItem(`kw-smp-probe-last`);e&&!d.has(`auto`)&&(K=JSON.parse(e),u(`report`).textContent=`(last run, ${K.date})\n${Y()}`,u(`copytext`).disabled=u(`copyjson`).disabled=!1)}catch{}var $=d.get(`auto`);($===`all`||$===`a`||$===`b`)&&Q($!==`b`,$!==`a`);