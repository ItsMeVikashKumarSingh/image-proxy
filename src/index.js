/**
 * Cloudflare Worker: Secure Image Watermark Proxy
 * Project: wedding-image-proxy
 * Version: 1.0.0
 *
 * Purpose:
 *   - Receives image requests from the WEDDING frontend
 *   - Validates the tenant's license via Zorvik API
 *   - Fetches original images from R2/B2 bucket using a secure token
 *   - Applies dynamic watermarks via Cloudflare Image Resizing (if enabled)
 *
 * Required Secrets (set via `wrangler secret put`):
 *   - BUCKET_ACCESS_TOKEN   : Bearer token to access private R2/B2 bucket
 *   - LICENSE_API_BASE      : Zorvik tenant verification API base URL
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url)

    // -- CORS preflight --
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // -- Health check endpoint --
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'wedding-image-proxy', version: '1.0.0' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Only handle /images/* paths --
    if (!url.pathname.startsWith('/images/')) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Require target URL param --
    const targetUrl = url.searchParams.get('url')
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing required query param: url' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Validate target URL format --
    try {
      new URL(targetUrl)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid url param — must be a fully qualified URL' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    try {
      // 1. Resolve tenant via Zorvik license API
      const originHost = request.headers.get('host') || url.hostname
      const verifyApiBase = env.LICENSE_API_BASE

      if (!verifyApiBase) {
        throw new Error('LICENSE_API_BASE secret is required but not set.')
      }

      const verifyResp = await fetch(verifyApiBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ domain: originHost }),
      })

      if (!verifyResp.ok) {
        return new Response(JSON.stringify({ error: 'Unauthorized domain' }), {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }

      const { data } = await verifyResp.json()
      const watermarkEnabled = data?.features?.enable_watermark || false
      const watermarkUrl = data?.features?.watermark_url || null

      // 2. Build authenticated request to private bucket
      const bucketToken = env.BUCKET_ACCESS_TOKEN || ''
      const bucketHeaders = bucketToken
        ? { Authorization: `Bearer ${bucketToken}` }
        : {}

      // 3. Serve with or without watermark via Cloudflare Image Resizing
      if (watermarkEnabled && watermarkUrl) {
        const cfOptions = {
          cf: {
            image: {
              width: 1920,
              fit: 'scale-down',
              draw: [
                {
                  url: watermarkUrl,
                  opacity: 0.8,
                  gravity: 'bottom-right',
                  width: 500,
                },
              ],
            },
          },
        }

        const imageRequest = new Request(targetUrl, { headers: bucketHeaders })
        const imageResp = await fetch(imageRequest, cfOptions)

        return new Response(imageResp.body, {
          status: imageResp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': imageResp.headers.get('Content-Type') || 'image/jpeg' },
        })
      } else {
        // No watermark — pass through raw image
        const imageRequest = new Request(targetUrl, { headers: bucketHeaders })
        const imageResp = await fetch(imageRequest)

        return new Response(imageResp.body, {
          status: imageResp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': imageResp.headers.get('Content-Type') || 'image/jpeg' },
        })
      }
    } catch (error) {
      // Safe error response — never leak internals
      console.error('[image-proxy] Unhandled error:', error?.message || error)
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
  },
}
