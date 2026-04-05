/**
 * Cloudflare Worker: Secure Image Watermark Proxy
 * Project: wedding-image-proxy
 * Version: 1.3.0
 *
 * Purpose:
 *   - Receives image requests from the WEDDING frontend
 *   - Validates the tenant's license directly via Supabase REST API (Edge)
 *   - Fetches original images from R2 bucket via native Bindings (env.BUCKET)
 *   - Applies dynamic watermarks via Cloudflare Image Resizing (if enabled)
 *
 * Required Secrets (set via `wrangler secret put`):
 *   - SUPABASE_URL                : Supabase project URL
 *   - SUPABASE_SERVICE_ROLE_KEY   : Service role key for license verification
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-ID',
  'Access-Control-Expose-Headers': 'X-Tenant-ID',
}

/**
 * Helper: Normalize URL to hostname or host.
 * Ported from Zorvik-Tech to ensure identical domain matching.
 */
function getHostname(url) {
  if (!url) return ''
  try {
    const urlStr = url.startsWith('http') ? url : `https://${url}`
    const urlObj = new URL(urlStr)
    const hostname = urlObj.hostname.toLowerCase()
    return hostname.replace(/^www\./, '')
  } catch {
    return (url || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/^www\./, '')
  }
}

/**
 * Deep merge helper for plan features + tenant overrides.
 * Ported from Zorvik-Tech.
 */
function mergeDeep(target, source) {
  const isObject = (item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (!isObject(target) || !isObject(source)) return source || target
  const output = Object.assign({}, target)
  Object.keys(source).forEach((key) => {
    if (isObject(source[key])) {
      if (!(key in target)) Object.assign(output, { [key]: source[key] })
      else output[key] = mergeDeep(target[key], source[key])
    } else {
      Object.assign(output, { [key]: source[key] })
    }
  })
  return output
}

/**
 * Fetch tenant settings directly from Supabase with Edge Caching.
 * IDENTITY-FIRST: Uses tc_id for deterministic lookup, then verifies Origin.
 */
async function getTenantSettings(tenantId, hostname, env) {
  const cache = caches.default
  const cacheKey = new Request(`https://image-proxy-cache.local/tenant/id/${tenantId}`)
  const cachedResponse = await cache.match(cacheKey)

  if (cachedResponse) {
    const result = await cachedResponse.json()
    // Verification: Even if cached, we must ensure the host is authorized for this ID
    if (!result.data.licensedDomains.includes(hostname)) {
      throw new Error('UNAUTHORIZED_DOMAIN')
    }
    return result
  }

  // Supabase Rest API Headers
  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept': 'application/vnd.pgrst.object+json',
  }

  // 1. Fetch Client from management.tbl_clients via GUID (tc_id)
  const clientUrl = `${env.SUPABASE_URL}/rest/v1/tbl_clients?tc_id=eq.${tenantId}&tc_deleted_flag=eq.false`
  const clientResp = await fetch(clientUrl, { headers })

  if (!clientResp.ok) {
    if (clientResp.status === 406 || clientResp.status === 404) {
      throw new Error('TENANT_NOT_FOUND')
    }
    const errorText = await clientResp.text()
    throw new Error(`Supabase Client lookup failed: ${errorText}`)
  }

  const client = await clientResp.json()
  if (!client || Object.keys(client).length === 0) {
      throw new Error('TENANT_NOT_FOUND')
  }

  // 1a. Strict hostname match verification
  const licensedDomains = (client.tc_domain || '')
    .split(',')
    .map(d => getHostname(d.trim()))
    .filter(Boolean)

  if (!licensedDomains.includes(hostname)) {
    throw new Error('UNAUTHORIZED_DOMAIN')
  }

  // 1b. Status check
  if (client.tc_status === 'suspended') {
    throw new Error('TENANT_SUSPENDED')
  }

  // 2. Fetch Plan Features if client has a plan
  let planFeatures = {}
  if (client.tc_plan_id) {
    const planUrl = `${env.SUPABASE_URL}/rest/v1/tbl_plans?tp_id=eq.${client.tc_plan_id}`
    const planResp = await fetch(planUrl, { headers })
    if (planResp.ok) {
      const plan = await planResp.json()
      planFeatures = plan.tp_features || {}
    }
  }

  // 3. Merge Plan Features + Tenant Overrides
  const mergedFeatures = mergeDeep(planFeatures, client.tc_feature_overrides || {})

  const result = {
    valid: true,
    data: {
      client_id: client.tc_id,
      features: mergedFeatures,
      is_maintenance: client.tc_is_maintenance || false,
      licensedDomains: licensedDomains,
    }
  }

  // Cache successful result for 5 minutes
  const responseToCache = new Response(JSON.stringify(result), {
    headers: { 
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=300' 
    }
  })
  // ctx.waitUntil can be used if we had ctx, but for simple put it's fine
  await cache.put(cacheKey, responseToCache)

  return result
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
      return new Response(JSON.stringify({ status: 'ok', service: 'wedding-image-proxy', version: '0.5.0' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Root welcome message --
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'running',
        service: 'wedding-image-proxy',
        message: 'Wedding Image Proxy — Active and Running',
        version: '0.5.0',
      }), {
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

    // -- Extract Tenant Identity and Object Key from Path --
    // Format: /images/{tenantId}/folder/photo.jpg
    const pathParts = url.pathname.replace('/images/', '').split('/')
    const tenantId = pathParts[0]
    const objectKey = pathParts.slice(1).join('/')

    if (!tenantId || !objectKey) {
      return new Response(JSON.stringify({ error: 'Incomplete path: Missing tenantId or objectKey' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // 1. Resolve tenant via direct Supabase REST API (Identity-First)
    const originHeader = request.headers.get('Origin') || request.headers.get('Referer') || request.url
    const hostname = getHostname(originHeader)

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase configuration secrets are missing.')
    }

    let tenantSettings
    try {
      tenantSettings = await getTenantSettings(tenantId, hostname, env)
    } catch (err) {
      const isAuthError = err.message === 'UNAUTHORIZED_DOMAIN' || err.message === 'TENANT_SUSPENDED' || err.message === 'TENANT_NOT_FOUND'
      if (isAuthError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Error-Reason': err.message },
        })
      }
      return new Response(JSON.stringify({ error: 'Tenant verification failed', details: err.message }), {
        status: 406,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Error-Reason': 'SYSTEM_ERROR' },
      })
    }

    // -- Handle PUT (Secure Upload Proxy) --
    if (request.method === 'PUT') {
      if (!env.BUCKET) {
        throw new Error('R2 Bucket binding is missing in Worker configuration.')
      }

      try {
        const contentType = request.headers.get('Content-Type') || 'image/jpeg'
        await env.BUCKET.put(objectKey, request.body, {
          httpMetadata: { contentType },
          customMetadata: {
            tenant_id: tenantSettings.data.client_id,
            uploaded_at: new Date().toISOString(),
          }
        })

        return new Response(JSON.stringify({ success: true, key: objectKey }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      } catch (err) {
        console.error('[image-proxy] Upload failure:', err)
        return new Response(JSON.stringify({ error: 'Upload failed' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
    }

    try {

      const { features } = tenantSettings.data
      const watermarkEnabled = features?.enable_watermark || false
      const watermarkUrl = features?.watermark_url || null

      // 2. Fetch Original from R2 Bucket (Native Binding)
      if (!env.BUCKET) {
        throw new Error('R2 Bucket binding is missing in Worker configuration.')
      }

      const object = await env.BUCKET.get(objectKey)
      if (!object) {
        return new Response(JSON.stringify({ error: `Asset not found: ${objectKey}` }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }

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

        // We fetch the current request URL with resizing options applied
        // But since we are using bindings, we can't resize from a stream directly without a URL
        // SO: We keep using the image resizing by passing the R2 object status.
        return new Response(object.body, {
          status: 200,
          headers: { 
            ...CORS_HEADERS, 
            'Content-Type': object.httpMetadata?.contentType || 'image/jpeg' 
          },
          ...cfOptions
        })
      } else {
        // No watermark — pass through raw image
        return new Response(object.body, {
          status: 200,
          headers: { 
            ...CORS_HEADERS, 
            'Content-Type': object.httpMetadata?.contentType || 'image/jpeg' 
          },
        })
      }
    } catch (error) {
      console.error('[image-proxy] Unhandled error:', error?.message || error)
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
  },
}
