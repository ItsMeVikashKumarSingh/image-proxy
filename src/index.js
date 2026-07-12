/**
 * Cloudflare Worker: Secure Multi-Cloud Storage Gateway
 * Project: wedding-image-proxy
 * Version: 0.6.0
 *
 * Purpose:
 *   - Securely proxies assets from Cloudflare R2 and Backblaze B2.
 *   - Enforces strict Multi-Tenant folder isolation (/{bucket}/{tenantId}/...).
 *   - Authenticates private Backblaze B2 requests via AWS Signature V4.
 *   - Validates the tenant's license directly via Supabase REST API (Edge).
 */

import { AwsClient } from 'aws4fetch'
import * as Sentry from '@sentry/cloudflare'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-ID',
  'Access-Control-Expose-Headers': 'X-Tenant-ID',
}

/**
 * Helper: Normalize URL to hostname or host.
 */
function getHostname(urlStr) {
  if (!urlStr) return ''
  try {
    const url = new URL(urlStr)
    return url.hostname.toLowerCase()
  } catch {
    try {
      const fixedUrl = urlStr.startsWith('http') ? urlStr : `https://${urlStr}`
      return (new URL(fixedUrl)).hostname.toLowerCase()
    } catch {
      return urlStr.split('/')[2]?.split(':')[0]?.toLowerCase() || urlStr.toLowerCase()
    }
  }
}

/**
 * Deep merge helper for plan features + tenant overrides.
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
 */
async function getTenantSettings(tenantId, hostname, env) {
  const isDev = hostname === 'localhost' || hostname === '127.0.0.1'
  const cache = caches.default
  const cacheKey = new Request(`https://image-proxy-cache.local/tenant/id/${tenantId}`)
  
  const cachedResponse = isDev ? null : await cache.match(cacheKey)

  if (cachedResponse) {
    const result = await cachedResponse.json()
    if (!result.data.licensedDomains.includes(hostname)) {
      throw new Error('UNAUTHORIZED_DOMAIN')
    }
    return result
  }

  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept': 'application/vnd.pgrst.object+json',
    'Accept-Profile': 'management',
  }

  const clientUrl = `${env.SUPABASE_URL}/rest/v1/tbl_clients?tc_id=eq.${tenantId}&tc_deleted_flag=eq.false`
  const clientResp = await fetch(clientUrl, { headers })

  if (!clientResp.ok) {
    const status = Number(clientResp.status)
    if (status === 406 || status === 404) {
      throw new Error('TENANT_NOT_FOUND')
    }
    throw new Error(`Supabase Client lookup failed: ${clientResp.statusText}`)
  }

  const client = await clientResp.json()
  if (!client || Object.keys(client).length === 0) {
    throw new Error('TENANT_NOT_FOUND')
  }

  const licensedDomains = (client.tc_domain || '')
    .split(',')
    .map(d => getHostname(d.trim()))
    .filter(Boolean)

  if (!licensedDomains.includes(hostname)) {
    throw new Error('UNAUTHORIZED_DOMAIN')
  }

  if (client.tc_status === 'suspended') {
    throw new Error('TENANT_SUSPENDED')
  }

  let planFeatures = {}
  if (client.tc_plan_id) {
    const planUrl = `${env.SUPABASE_URL}/rest/v1/tbl_plans?tp_id=eq.${client.tc_plan_id}`
    const planResp = await fetch(planUrl, { headers })
    if (planResp.ok) {
      const plan = await planResp.json()
      planFeatures = plan.tp_features || {}
    }
  }

  const mergedFeatures = mergeDeep(planFeatures, client.tc_feature_overrides || {})

  // Fetch site settings from studio schema
  const studioHeaders = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept-Profile': 'studio',
  }
  const settingsUrl = `${env.SUPABASE_URL}/rest/v1/tbl_site_settings?client_id=eq.${client.tc_id}&tss_key=in.(watermark_enabled,watermark_url)&tss_deleted_flag=eq.false`
  const settingsResp = await fetch(settingsUrl, { headers: studioHeaders })
  const watermarkSettings = { watermark_enabled: 'false', watermark_url: '' }
  if (settingsResp.ok) {
    const settingsList = await settingsResp.json()
    if (Array.isArray(settingsList)) {
      settingsList.forEach(item => {
        if (item.tss_key === 'watermark_enabled') {
          watermarkSettings.watermark_enabled = item.tss_value
        } else if (item.tss_key === 'watermark_url') {
          watermarkSettings.watermark_url = item.tss_value
        }
      })
    }
  }

  const result = {
    valid: true,
    data: {
      client_id: client.tc_id,
      features: mergedFeatures,
      is_maintenance: client.tc_is_maintenance || false,
      licensedDomains: licensedDomains,
      hostname: hostname,
      watermark: {
        enabled: watermarkSettings.watermark_enabled === 'true',
        url: watermarkSettings.watermark_url,
      }
    }
  }

  const responseToCache = new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }
  })
  await cache.put(cacheKey, responseToCache)

  return result
}

/**
 * Fetch from Backblaze B2 via S3-Compatible API with SIGv4 Signing.
 */
async function fetchFromB2(bucketName, objectKey, env) {
  // Validate Minimal Vault Configuration
  if (!env.B2_APPLICATION_KEY_ID || !env.B2_APPLICATION_KEY || !env.B2_ENDPOINT) {
    throw new Error('Vault Configuration Error: Missing core storage credentials.')
  }

  // Derive Region dynamically from Endpoint (Exact Approach)
  // s3.eu-central-003.backblazeb2.com -> eu-central-003
  const region = env.B2_ENDPOINT.split('.')[1] || 'us-east-005'

  const b2 = new AwsClient({
    accessKeyId: env.B2_APPLICATION_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    service: 's3',
    region: region,
  })

  // Format: https://bucket.s3.region.backblazeb2.com/key
  const url = `https://${bucketName}.${env.B2_ENDPOINT}/${objectKey}`
  
  const response = await b2.fetch(url, {
    method: 'GET',
    headers: {
      'Host': `${bucketName}.${env.B2_ENDPOINT}`,
    }
  })

  return response
}

async function logRequestToDb(request, status, error, env) {
  if (env.SUPABASE_URL === 'https://test.supabase.co') {
    return
  }
  try {
    const headersObj = {}
    for (const [key, val] of request.headers.entries()) {
      headersObj[key] = val
    }
    const body = {
      url: request.url,
      method: request.method,
      headers: headersObj,
      status: status || 0,
      error: error || null
    }
    const headers = {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'management'
    }
    await fetch(`${env.SUPABASE_URL}/rest/v1/imagekit_requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  } catch (_err) {
    // ignore logging failure
  }
}

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN || undefined,
    tracesSampleRate: 1.0,
  }),
  {
    async fetch(request, env, _ctx) {
      const url = new URL(request.url)

      if (url.pathname.startsWith('/images/')) {
        _ctx.waitUntil(logRequestToDb(request, null, null, env))
      }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'wedding-image-proxy', version: '0.6.0' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    if (request.method === 'PURGE') {
      const purgeSecret = request.headers.get('X-Purge-Secret')
      if (!purgeSecret || purgeSecret !== env.PURGE_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        })
      }
      
      const cache = caches.default
      const cacheKeyDefault = new Request(request.url, { method: 'GET' })
      const cacheKeyNoWatermark = new Request(request.url + '?watermark=false', { method: 'GET' })
      
      const deletedDefault = await cache.delete(cacheKeyDefault)
      const deletedNoWatermark = await cache.delete(cacheKeyNoWatermark)
      
      return new Response(JSON.stringify({
        success: true,
        purged: { default: deletedDefault, clean: deletedNoWatermark }
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'running', service: 'wedding-image-proxy', message: 'Wedding Image Proxy — Active and Running', version: '0.6.0' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Mapping of path prefixes to multi-cloud buckets
    const ROUTE_CONFIG = {
      image: { prefix: '/images/', bucket: 'R2', type: 'image' },
      site: { prefix: '/site/', bucket: 'SYSTEM_R2', type: 'image' },
      assets: { prefix: '/assets/', bucket: 'SUPABASE_STORAGE', type: 'image' },
      reel: { prefix: '/reels/', bucket: env.B2_REELS_BUCKET || 'studio-private-reels', type: 'video' },
      film: { prefix: '/films/', bucket: env.B2_FILMS_BUCKET || 'studio-private-films', type: 'video' },
      deliverable: { prefix: '/deliverables/', bucket: env.B2_PRIVATE_BUCKET || 'studio-private-deliverables', type: 'mixed' },
    }

    const route = Object.values(ROUTE_CONFIG).find(r => url.pathname.startsWith(r.prefix))
    if (!route) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Extract Tenant Identity and Object Key from Path --
    const objectKey = url.pathname.replace(route.prefix, '')
    const isPlatformAsset = route.bucket === 'SUPABASE_STORAGE'

    let cleanObjectKey = objectKey
    let isBypassed = false

    const bypassInfix = `/bypass/${env.BYPASS_SECRET}/`
    if (env.BYPASS_SECRET && objectKey.includes(bypassInfix)) {
      isBypassed = true
      cleanObjectKey = objectKey.replace(bypassInfix, '/')
    }

    const bypassSuffix = `/bypass/${env.BYPASS_SECRET}`
    if (env.BYPASS_SECRET && objectKey.endsWith(bypassSuffix)) {
      isBypassed = true
      cleanObjectKey = objectKey.slice(0, -bypassSuffix.length)
    }

    const bypassParam = url.searchParams.get('bypass')
    if (bypassParam && bypassParam === env.BYPASS_SECRET) {
      isBypassed = true
    }

    const tenantId = isPlatformAsset ? 'platform' : cleanObjectKey.split('/')[0]
    const hasMultipleSegments = isPlatformAsset ? true : cleanObjectKey.includes('/')

    if (!tenantId || !cleanObjectKey || !hasMultipleSegments) {
      return new Response(JSON.stringify({ error: 'Incomplete path: Missing tenantId or objectKey' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // 1. Resolve tenant via direct Supabase REST API (Identity-First)
    const originHeader = request.headers.get('Origin') || request.headers.get('Referer') || request.url
    const hostname = getHostname(originHeader)

    // -- Edge Cache Lookup (GET requests only, exclude deliverables/private vault and dev/localhost) --
    // Only cache image/site assets at edge (videos are range-requested and excluded from caches.default inside workers)
    const isDev = hostname === 'localhost' || hostname === '127.0.0.1'
    const isCacheable = request.method === 'GET' && !isDev && (route.prefix === '/images/' || route.prefix === '/site/' || route.prefix === '/assets/');
    const cache = caches.default;
    if (isCacheable) {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // bypass checks performed during path extraction

    let tenantSettings
    if (isPlatformAsset || isBypassed) {
      tenantSettings = { data: { client_id: tenantId, features: { enable_watermark: false } } }
    } else {
      try {
        tenantSettings = await getTenantSettings(tenantId, hostname, env)
      } catch (err) {
        const isAuthError = ['UNAUTHORIZED_DOMAIN', 'TENANT_SUSPENDED', 'TENANT_NOT_FOUND'].includes(err.message)
        const debugHeaders = {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'X-Error-Reason': err.message,
          'X-Debug-Tenant-ID': tenantId || 'none',
          'X-Debug-Resolved-Host': hostname || 'unknown',
        }

        if (isAuthError) {
          return new Response(JSON.stringify({ error: err.message }), { status: 403, headers: debugHeaders })
        }
        Sentry.captureException(err, {
          extra: { tenantId, hostname }
        });
        return new Response(JSON.stringify({ error: 'Tenant verification failed', details: err.message }), {
          status: 406,
          headers: { ...debugHeaders, 'X-Error-Reason': 'SYSTEM_ERROR' },
        })
      }
    }

    // -- Handle PUT (Secure Upload Proxy) --
    // Only R2/SYSTEM_R2 currently supports proxy upload for images
    if (request.method === 'PUT' && (route.bucket === 'R2' || route.bucket === 'SYSTEM_R2')) {
      const bucketBinding = route.bucket === 'R2' ? env.BUCKET : env.SYSTEM_BUCKET;
      if (!bucketBinding) throw new Error('R2 Bucket binding is missing.')
      try {
        const contentType = request.headers.get('Content-Type') || 'image/jpeg'
        await bucketBinding.put(cleanObjectKey, request.body, {
          httpMetadata: { contentType },
          customMetadata: {
            tenant_id: tenantSettings.data.client_id,
            uploaded_at: new Date().toISOString(),
          }
        })
        return new Response(JSON.stringify({ success: true, key: cleanObjectKey }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      } catch (_err) {
        return new Response(JSON.stringify({ error: 'Upload failed' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
    }

    // -- Handle GET (Secure Retrieval) --
    try {
      let response
      if (route.bucket === 'R2' || route.bucket === 'SYSTEM_R2') {
        const bucketBinding = route.bucket === 'R2' ? env.BUCKET : env.SYSTEM_BUCKET;
        if (!bucketBinding) throw new Error('R2 Bucket binding is missing.')
        const object = await bucketBinding.get(cleanObjectKey)
        if (!object) {
          return new Response(JSON.stringify({ error: `Asset not found in R2: ${cleanObjectKey}` }), {
            status: 404,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }

        // Apply Image Resizing/Watermark if enabled (only for images)
        const { features, watermark } = tenantSettings.data
        const watermarkParam = url.searchParams.get('watermark') !== 'false'
        const widthParam = url.searchParams.get('w')

        const isWatermarked =
          route.type === 'image' &&
          features?.enable_watermark &&
          features?.enable_custom_watermark !== false &&
          watermark?.enabled &&
          watermark?.url &&
          watermarkParam

        const isResized = route.type === 'image' && widthParam

        if (isWatermarked || isResized) {
          const w = widthParam ? parseInt(widthParam, 10) || 1920 : 1920
          const cleanImageUrl = `https://${url.hostname}${route.prefix}${cleanObjectKey}?watermark=false&bypass=${env.BYPASS_SECRET}`
          
          const parts = cleanObjectKey.split('/')
          const filename = parts.pop()
          const dirPath = parts.join('/')
          const imageKitPath = `${route.prefix.slice(1)}${dirPath}/bypass/${env.BYPASS_SECRET || ''}/${filename}`
          
          let cdnResponse = null
          if (isWatermarked) {
            let authorizedWatermarkUrl = watermark.url
            try {
              const wmUrlObj = new URL(watermark.url)
              wmUrlObj.searchParams.set('bypass', env.BYPASS_SECRET)
              authorizedWatermarkUrl = wmUrlObj.toString()
            } catch (_e) {
              // fallback
            }

            const cloudinaryBase64Watermark = btoa(authorizedWatermarkUrl)
              .replace(/\//g, '_')
              .replace(/\+/g, '-')
              .replace(/=/g, '')

            let imageKitWatermarkPath = ''
            try {
              const wmUrlObj = new URL(watermark.url)
              const wmPathname = wmUrlObj.pathname
              const wmRelativePath = wmPathname.startsWith('/') ? wmPathname.slice(1) : wmPathname
              const wmParts = wmRelativePath.split('/')
              const wmFilename = wmParts.pop()
              const wmDirPath = wmParts.join('/')
              imageKitWatermarkPath = `${wmDirPath}/bypass/${env.BYPASS_SECRET || ''}/${wmFilename}`
            } catch (_e) {
              imageKitWatermarkPath = watermark.url
            }

            const imageKitBase64Watermark = encodeURIComponent(btoa(imageKitWatermarkPath))
            
            const wmWidth = Math.max(80, Math.round(w * 0.2))
            
            try {
              const imageKitUrl = `https://ik.imagekit.io/${env.IMAGEKIT_ID}/tr:w-${w},f-auto,l-image,ie-${imageKitBase64Watermark},w-${wmWidth},o-80,lfo-bottom_right,lx-15,ly-15,l-end/${imageKitPath}`
              cdnResponse = await fetch(imageKitUrl)
              if (!cdnResponse.ok) throw new Error(`ImageKit status ${cdnResponse.status}`)
            } catch (err) {
              console.error('ImageKit failed, falling back to Cloudinary:', err)
              try {
                const cloudinaryUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/fetch/w_${w},c_limit,l_fetch:${cloudinaryBase64Watermark},g_south_east,x_15,y_15,o_80/${encodeURIComponent(cleanImageUrl)}`
                cdnResponse = await fetch(cloudinaryUrl)
              } catch (clErr) {
                console.error('Cloudinary fallback failed:', clErr)
              }
            }
          } else {
            // Just resizing + f_auto / q_auto (AVIF/WebP auto optimization)
            try {
              const imageKitUrl = `https://ik.imagekit.io/${env.IMAGEKIT_ID}/tr:w-${w},f-auto/${imageKitPath}`
              cdnResponse = await fetch(imageKitUrl)
              if (!cdnResponse.ok) throw new Error(`ImageKit status ${cdnResponse.status}`)
            } catch (err) {
              console.error('ImageKit failed, falling back to Cloudinary:', err)
              try {
                const cloudinaryUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/fetch/w_${w},c_limit,f_auto,q_auto/${encodeURIComponent(cleanImageUrl)}`
                cdnResponse = await fetch(cloudinaryUrl)
              } catch (clErr) {
                console.error('Cloudinary fallback failed:', clErr)
              }
            }
          }

          if (cdnResponse && cdnResponse.ok) {
            response = new Response(cdnResponse.body, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Content-Type': cdnResponse.headers.get('Content-Type') || object.httpMetadata?.contentType || 'image/jpeg',
              },
            })
          } else {
            // Safe fallback: serve un-watermarked/un-resized image from R2 directly
            response = new Response(object.body, {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg' },
            })
          }
        } else {
          // Serve raw, full-resolution uncompressed asset directly from R2
          response = new Response(object.body, {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg' },
          })
        }
      } else if (route.bucket === 'SUPABASE_STORAGE') {
        const supabaseStorageUrl = `${env.SUPABASE_URL}/storage/v1/object/authenticated/zorvik-assets/${cleanObjectKey}`
        const supabaseHeaders = {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        }
        const supabaseResponse = await fetch(supabaseStorageUrl, { headers: supabaseHeaders })
        if (!supabaseResponse.ok) {
          return new Response(JSON.stringify({ error: `Asset not found in Supabase Storage: ${cleanObjectKey}` }), {
            status: supabaseResponse.status,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }

        const widthParam = url.searchParams.get('w')
        const isResized = route.type === 'image' && widthParam

        if (isResized) {
          const w = parseInt(widthParam, 10) || 1920
          const cleanImageUrl = `https://${url.hostname}${route.prefix}${cleanObjectKey}?bypass=${env.BYPASS_SECRET}`
          const parts = cleanObjectKey.split('/')
          const filename = parts.pop()
          const dirPath = parts.join('/')
          const imageKitPath = `${route.prefix.slice(1)}${dirPath}/bypass/${env.BYPASS_SECRET || ''}/${filename}`
          
          let cdnResponse = null
          try {
            const imageKitUrl = `https://ik.imagekit.io/${env.IMAGEKIT_ID}/tr:w-${w},f-auto/${imageKitPath}`
            cdnResponse = await fetch(imageKitUrl)
            if (!cdnResponse.ok) throw new Error(`ImageKit status ${cdnResponse.status}`)
          } catch (err) {
            console.error('ImageKit failed, falling back to Cloudinary:', err)
            try {
              const cloudinaryUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/fetch/w_${w},c_limit,f_auto,q_auto/${encodeURIComponent(cleanImageUrl)}`
              cdnResponse = await fetch(cloudinaryUrl)
            } catch (clErr) {
              console.error('Cloudinary fallback failed:', clErr)
            }
          }

          if (cdnResponse && cdnResponse.ok) {
            response = new Response(cdnResponse.body, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Content-Type': cdnResponse.headers.get('Content-Type') || supabaseResponse.headers.get('Content-Type') || 'image/jpeg',
              },
            })
          } else {
            response = new Response(supabaseResponse.body, {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': supabaseResponse.headers.get('Content-Type') || 'image/jpeg' },
            })
          }
        } else {
          response = new Response(supabaseResponse.body, {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': supabaseResponse.headers.get('Content-Type') || 'image/jpeg' },
          })
        }
      } else {
        // Backblaze B2 Retrieval
        const b2Response = await fetchFromB2(route.bucket, cleanObjectKey, env)
        if (!b2Response.ok) {
          return new Response(JSON.stringify({ error: `Asset not found in B2 (${route.bucket}): ${cleanObjectKey}` }), {
            status: b2Response.status,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
        const isPublicB2 = route.prefix === '/reels/' || route.prefix === '/films/';
        const headers = { 
          ...CORS_HEADERS, 
          'Content-Type': b2Response.headers.get('Content-Type') || 'video/mp4' 
        };
        if (isPublicB2) {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        }
        response = new Response(b2Response.body, {
          status: 200,
          headers: headers,
        })
      }

      // Add Cache-Control header and write to Cloudflare Edge Cache asynchronously
      if (isCacheable && response.ok) {
        const cacheResponse = new Response(response.body, response);
        cacheResponse.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        _ctx.waitUntil(cache.put(request, cacheResponse.clone()));
        if (url.pathname.startsWith('/images/')) {
          _ctx.waitUntil(logRequestToDb(request, cacheResponse.status, null, env))
        }
        return cacheResponse;
      }

      if (url.pathname.startsWith('/images/')) {
        _ctx.waitUntil(logRequestToDb(request, response.status, null, env))
      }
      return response;
    } catch (error) {
      Sentry.captureException(error);
      if (url.pathname.startsWith('/images/')) {
        _ctx.waitUntil(logRequestToDb(request, 500, error.message, env))
      }
      return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
  },
})
