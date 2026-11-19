/*
 * 跨源隔离 shim：给同源响应补上 COOP/COEP，让 CheerpX（WebVM）能用
 * SharedArrayBuffer。静态托管（GitHub Pages 等）没法自定义响应头，所以用这个
 * 很小的 service worker 兜底；APK 的本地 HTTP 服务自己就带这两个头。
 *
 * 只在用户第一次启用 WebVM 时注册；页面会刷新一次，之后每次导航都由它接管。
 * 这里只做透传与加头，不缓存任何内容，避免把旧版本的 index.html 留在客户端。
 */
'use strict'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) {
    return
  }
  event.respondWith(
    (async () => {
      const response = await fetch(request)
      if (response.status === 0 || response.type === 'opaque') {
        return response
      }
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
      if (response.redirected) {
        headers.set('location', response.url)
      }
      return new Response(response.redirected ? null : response.body, {
        headers,
        status: response.redirected ? 301 : response.status,
        statusText: response.statusText,
      })
    })()
  )
})
