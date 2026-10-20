import assets from './assets.generated.mjs'

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (assets.canonicalOrigin && url.origin !== assets.canonicalOrigin) {
      const destination = new URL(url.pathname + url.search, assets.canonicalOrigin)
      return Response.redirect(destination.href, 308)
    }
    const path = url.pathname
    const asset = path === '/' ? [assets.html, 'text/html; charset=utf-8']
      : path === '/style.css' ? [assets.css, 'text/css; charset=utf-8']
      : path === '/wordmark.svg' ? [assets.wordmark, 'image/svg+xml']
      : path === '/svg/liammendes.svg' ? [assets.logo, 'image/svg+xml']
      : undefined
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    }
    if (!asset) return new Response('Not found', { status: 404, headers })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } })
    }
    return new Response(request.method === 'HEAD' ? null : asset[0], {
      headers: { ...headers, 'Content-Type': asset[1] },
    })
  },
}
