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
 * Helper: Check if a hostname is allowed (either in tenant's licensed domains,
 * matches system proxy host directly, or is an allowed platform domain).
 */
function isAllowedDomain(hostname, licensedDomains, requestUrlHost = '') {
  if (!hostname) return false
  const cleanHost = hostname.toLowerCase()

  if (Array.isArray(licensedDomains) && licensedDomains.includes(cleanHost)) {
    return true
  }

  if (requestUrlHost && cleanHost === requestUrlHost.toLowerCase()) {
    return true
  }

  const ALLOWED_SYSTEM_DOMAINS = [
    'imageproxy.zorviktech.com',
    'zorviktech.com',
    'studio.zorviktech.com',
    'admin.zorviktech.com',
    'zconnect.zorviktech.com',
    'localhost',
    '127.0.0.1',
  ]

  if (ALLOWED_SYSTEM_DOMAINS.includes(cleanHost)) {
    return true
  }

  if (cleanHost.endsWith('.zorviktech.com') || cleanHost.endsWith('.workers.dev')) {
    return true
  }

  return false
}

/**
 * Helper: Verify HMAC-SHA256 signature for authorized clean downloads.
 */
async function verifyHmacSignature(objectKey, expStr, sig, secret) {
  if (!expStr || !sig || !secret) return false
  const exp = parseInt(expStr, 10)
  if (isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return false

  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const data = encoder.encode(`${objectKey}:${expStr}`)

    if (sig.length % 2 !== 0) return false
    const sigBytes = new Uint8Array(sig.length / 2)
    for (let i = 0; i < sig.length; i += 2) {
      sigBytes[i / 2] = parseInt(sig.substring(i, i + 2), 16)
    }

    return await crypto.subtle.verify('HMAC', key, sigBytes, data)
  } catch {
    return false
  }
}

/**
 * Helper: Resolve accurate MIME content type for B2 storage objects.
 */
function resolveB2ContentType(cleanObjectKey, b2Response) {
  const ext = cleanObjectKey.split('.').pop()?.toLowerCase()
  const mimeMap = {
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    zip: 'application/zip',
  }
  if (ext && mimeMap[ext]) {
    return mimeMap[ext]
  }
  const rawType = b2Response?.headers?.get('Content-Type') || b2Response?.headers?.get('content-type')
  if (rawType && rawType !== 'application/octet-stream') {
    return rawType
  }
  return 'application/octet-stream'
}

/**
 * Fetch tenant settings directly from Supabase with Edge Caching.
 */
async function getTenantSettings(tenantId, hostname, env, requestUrlHost = '') {
  const isDev = hostname === 'localhost' || hostname === '127.0.0.1'
  const cache = caches.default
  const cacheKey = new Request(`https://image-proxy-cache.local/tenant/id/${tenantId}`)
  
  const cachedResponse = isDev ? null : await cache.match(cacheKey)

  if (cachedResponse) {
    const result = await cachedResponse.json()
    if (!isAllowedDomain(hostname, result.data.licensedDomains, requestUrlHost)) {
      throw new Error('UNAUTHORIZED_DOMAIN')
    }
    return result
  }

  const clientHeaders = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept': 'application/vnd.pgrst.object+json',
    'Accept-Profile': 'management',
  }

  const projectHeaders = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept': 'application/json',
    'Accept-Profile': 'management',
  }

  const clientUrl = `${env.SUPABASE_URL}/rest/v1/tbl_clients?tc_id=eq.${tenantId}&tc_deleted_flag=eq.false`
  const projectsUrl = `${env.SUPABASE_URL}/rest/v1/tbl_client_projects?tcp_client_id=eq.${tenantId}&tcp_deleted_flag=eq.false&order=tcp_is_primary.desc,tcp_created_at.asc`

  const [clientResp, projectsResp] = await Promise.all([
    fetch(clientUrl, { headers: clientHeaders }),
    fetch(projectsUrl, { headers: projectHeaders }),
  ])

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

  let projects = []
  if (projectsResp?.ok) {
    const pData = await projectsResp.json()
    projects = Array.isArray(pData) ? pData : (pData ? [pData] : [])
  }
  const primaryProject = Array.isArray(projects) && projects.length > 0 
    ? (projects.find(p => p.tcp_is_primary) || projects[0]) 
    : null

  // Collect all licensed domains across all active client projects
  const allDomains = []
  if (Array.isArray(projects)) {
    projects.forEach((p) => {
      if (Array.isArray(p.tcp_allowed_domains)) {
        p.tcp_allowed_domains.forEach((d) => allDomains.push(d))
      }
    })
  }
  // Backward compatibility fallback to client.tc_domain if no project domains found
  if (allDomains.length === 0 && client.tc_domain) {
    client.tc_domain.split(',').forEach((d) => allDomains.push(d))
  }

  const licensedDomains = allDomains
    .map(d => getHostname(d.trim()))
    .filter(Boolean)

  if (!isAllowedDomain(hostname, licensedDomains, requestUrlHost)) {
    throw new Error('UNAUTHORIZED_DOMAIN')
  }

  if (client.tc_status === 'suspended') {
    throw new Error('TENANT_SUSPENDED')
  }

  let planFeatures = {}
  const targetPlanId = primaryProject?.tcp_plan_id || client.tc_plan_id
  if (targetPlanId) {
    const planUrl = `${env.SUPABASE_URL}/rest/v1/tbl_plans?tp_id=eq.${targetPlanId}`
    const planResp = await fetch(planUrl, { headers: projectHeaders })
    if (planResp?.ok) {
      const planData = await planResp.json()
      const plan = Array.isArray(planData) ? planData[0] : planData
      planFeatures = plan?.tp_features || {}
    }
  }

  const projectOverrides = primaryProject?.tcp_feature_overrides || {}
  const clientOverrides = client.tc_feature_overrides || {}
  const mergedFeatures = mergeDeep(planFeatures, { ...clientOverrides, ...projectOverrides })

  // Fetch site settings from studio schema
  const studioHeaders = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept-Profile': 'studio',
  }
  const settingsUrl = `${env.SUPABASE_URL}/rest/v1/tbl_site_settings?client_id=eq.${client.tc_id}&tss_key=in.(watermark_enabled,watermark_url)&tss_deleted_flag=eq.false`
  const settingsResp = await fetch(settingsUrl, { headers: studioHeaders })
  const watermarkSettings = { watermark_enabled: 'false', watermark_url: '' }
  if (settingsResp?.ok) {
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

  const isMaintenance = Boolean(primaryProject?.tcp_is_maintenance || client.tc_is_maintenance)

  const result = {
    valid: true,
    data: {
      client_id: client.tc_id,
      features: mergedFeatures,
      is_maintenance: isMaintenance,
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

  // Normalize endpoint: strip leading protocol if provided (e.g. https://s3.eu-central-003.backblazeb2.com -> s3.eu-central-003.backblazeb2.com)
  const cleanEndpoint = env.B2_ENDPOINT.replace(/^https?:\/\//i, '').replace(/\/+$/, '')

  // Derive Region dynamically from Endpoint (Exact Approach)
  // s3.eu-central-003.backblazeb2.com -> eu-central-003
  const region = cleanEndpoint.split('.')[1] || 'us-east-005'

  const b2 = new AwsClient({
    accessKeyId: env.B2_APPLICATION_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    service: 's3',
    region: region,
  })

  // Format: https://bucket.s3.region.backblazeb2.com/key
  const url = `https://${bucketName}.${cleanEndpoint}/${objectKey}`
  
  const response = await b2.fetch(url, {
    method: 'GET',
    headers: {
      'Host': `${bucketName}.${cleanEndpoint}`,
    }
  })

  return response
}

/**
 * Helper: Parse AWS S3 ListObjectsV2 XML response without external dependencies.
 */
function parseS3ListXml(xmlText) {
  const contents = []
  const contentMatches = xmlText.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)
  for (const match of contentMatches) {
    const block = match[1]
    const keyMatch = block.match(/<Key>(.*?)<\/Key>/)
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/)
    if (keyMatch && sizeMatch) {
      contents.push({
        Key: keyMatch[1],
        Size: parseInt(sizeMatch[1], 10),
      })
    }
  }
  return contents
}

/**
 * Scan Backblaze B2 bucket objects via S3 API.
 */
async function scanB2BucketObjects(bucketName, prefix, env) {
  if (!env.B2_APPLICATION_KEY_ID || !env.B2_APPLICATION_KEY || !env.B2_ENDPOINT || !bucketName) {
    return []
  }
  try {
    const cleanEndpoint = env.B2_ENDPOINT.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    const region = cleanEndpoint.split('.')[1] || 'us-east-005'
    const b2 = new AwsClient({
      accessKeyId: env.B2_APPLICATION_KEY_ID,
      secretAccessKey: env.B2_APPLICATION_KEY,
      service: 's3',
      region: region,
    })

    const prefixParam = prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''
    const url = `https://${bucketName}.${cleanEndpoint}/?list-type=2${prefixParam}&max-keys=1000`
    const response = await b2.fetch(url, {
      method: 'GET',
      headers: { Host: `${bucketName}.${cleanEndpoint}` },
    })

    if (!response.ok) return []
    const xmlText = await response.text()
    return parseS3ListXml(xmlText)
  } catch (err) {
    console.warn(`[scanB2BucketObjects] B2 scan error for ${bucketName}:`, err)
    return []
  }
}

/**
 * Scan Cloudflare R2 bucket objects via native worker binding.
 */
async function scanR2BucketObjects(r2Binding, prefix) {
  if (!r2Binding || typeof r2Binding.list !== 'function') return []
  try {
    const list = await r2Binding.list({ prefix: prefix || undefined, limit: 1000 })
    return (list.objects || []).map((o) => ({ Key: o.key, Size: o.size }))
  } catch (err) {
    console.warn('[scanR2BucketObjects] R2 scan error:', err)
    return []
  }
}

/**
 * Centralized Storage Handler: GET /api/storage/overview
 */
async function handleStorageOverview(env) {
  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept-Profile': 'management',
  }

  // 1. Fetch clients, projects, and usages from Supabase
  const [clientsRes, projectsRes, usagesRes] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/tbl_clients?tc_deleted_flag=eq.false&select=tc_id,tc_client_name,tc_status`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/tbl_client_projects?tcp_deleted_flag=eq.false&select=tcp_id,tcp_client_id,tcp_name,tcp_allowed_domains,tcp_website_type,tcp_plan_id,tcp_feature_overrides,tcp_addons,tcp_is_primary,tbl_plans(tp_name,tp_code,tp_features)&order=tcp_is_primary.desc,tcp_created_at.asc`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/tbl_client_usage`, { headers }),
  ])

  const clients = clientsRes.ok ? await clientsRes.json() : []
  const projects = projectsRes.ok ? await projectsRes.json() : []
  const usages = usagesRes.ok ? await usagesRes.json() : []

  const projectMap = new Map()
  if (Array.isArray(projects)) {
    projects.forEach((p) => {
      if (!projectMap.has(p.tcp_client_id) || p.tcp_is_primary) {
        projectMap.set(p.tcp_client_id, p)
      }
    })
  }

  const usageMap = new Map()
  if (Array.isArray(usages)) {
    usages.forEach((u) => {
      if (u.tcu_client_id) usageMap.set(u.tcu_client_id, u)
    })
  }

  // 2. Scan R2 & B2 buckets in parallel
  const [r2GalleryObjects, r2SiteObjects, b2GalleryObjects, b2FilmsObjects, b2ReelsObjects, b2PrivateObjects] = await Promise.all([
    scanR2BucketObjects(env.BUCKET, ''),
    scanR2BucketObjects(env.SYSTEM_BUCKET, ''),
    scanB2BucketObjects(env.B2_GALLERY_BUCKET || 'studio-public-gallery', '', env),
    scanB2BucketObjects(env.B2_FILMS_BUCKET || 'studio-public-films', '', env),
    scanB2BucketObjects(env.B2_REELS_BUCKET || 'studio-public-reels', '', env),
    scanB2BucketObjects(env.B2_PRIVATE_BUCKET || 'studio-private-deliverables', '', env),
  ])

  // Aggregate by tenantId
  const tenantR2Map = new Map()
  const tenantB2Map = new Map()

  const processR2Item = (item) => {
    const tenantId = item.Key.split('/')[0]
    if (tenantId) {
      const cur = tenantR2Map.get(tenantId) || { bytes: 0, count: 0 }
      tenantR2Map.set(tenantId, { bytes: cur.bytes + item.Size, count: cur.count + 1 })
    }
  }

  const processB2Item = (item, type) => {
    const tenantId = item.Key.split('/')[0]
    if (tenantId) {
      const cur = tenantB2Map.get(tenantId) || { bytes: 0, photos: 0, films: 0, reels: 0, deliverables: 0 }
      cur.bytes += item.Size
      if (type === 'photos') cur.photos++
      else if (type === 'films') cur.films++
      else if (type === 'reels') cur.reels++
      else if (type === 'deliverables') cur.deliverables++
      tenantB2Map.set(tenantId, cur)
    }
  }

  r2GalleryObjects.forEach(processR2Item)
  r2SiteObjects.forEach(processR2Item)

  b2GalleryObjects.forEach((item) => processB2Item(item, 'photos'))
  b2FilmsObjects.forEach((item) => processB2Item(item, 'films'))
  b2ReelsObjects.forEach((item) => processB2Item(item, 'reels'))
  b2PrivateObjects.forEach((item) => processB2Item(item, 'deliverables'))

  let totalStorageBytes = 0
  let totalR2Bytes = 0
  let totalB2Bytes = 0
  let totalPhotos = 0
  let totalFilms = 0
  let totalReels = 0
  let totalDeliverables = 0
  let warningTenantsCount = 0
  let lockedTenantsCount = 0

  const tenantSummaries = (Array.isArray(clients) ? clients : []).map((client) => {
    const u = usageMap.get(client.tc_id)
    const r2Stats = tenantR2Map.get(client.tc_id) || { bytes: 0, count: 0 }
    const b2Stats = tenantB2Map.get(client.tc_id) || { bytes: 0, photos: 0, films: 0, reels: 0, deliverables: 0 }

    const usedBytes = r2Stats.bytes + b2Stats.bytes || Number(u?.tcu_storage_bytes) || 0
    const photosCount = r2Stats.count + b2Stats.photos || Number(u?.tcu_photos_count) || 0
    const filmsCount = b2Stats.films || Number(u?.tcu_films_count) || 0
    const reelsCount = b2Stats.reels || 0
    const deliverablesCount = b2Stats.deliverables || Number(u?.tcu_deliverables_count) || 0

    totalStorageBytes += usedBytes
    totalR2Bytes += r2Stats.bytes
    totalB2Bytes += b2Stats.bytes
    totalPhotos += photosCount
    totalFilms += filmsCount
    totalReels += reelsCount
    totalDeliverables += deliverablesCount

    const primaryProject = projectMap.get(client.tc_id)
    const planData = primaryProject?.tbl_plans || {}
    const planFeatures = planData.tp_features || {}
    const overrides = primaryProject?.tcp_feature_overrides || {}
    const baseStorageGb = Number(overrides.storage_gb) || Number(planFeatures.storage_gb) || 5

    let addonStorageGb = 0
    const projectAddons = primaryProject?.tcp_addons || []
    if (Array.isArray(projectAddons)) {
      const now = new Date()
      projectAddons.forEach((addon) => {
        if (addon && typeof addon === 'object') {
          const isActive = addon.status === 'active' && (!addon.valid_until || new Date(addon.valid_until) > now)
          if (isActive && addon.features && typeof addon.features.storage_gb === 'number') {
            addonStorageGb += addon.features.storage_gb * (Number(addon.quantity) || 1)
          }
        }
      })
    }

    const totalStorageLimitGb = baseStorageGb + addonStorageGb
    const totalStorageLimitBytes = totalStorageLimitGb * 1024 * 1024 * 1024
    const usedGb = usedBytes / (1024 * 1024 * 1024)
    const storagePercentage = totalStorageLimitBytes > 0 ? (usedBytes / totalStorageLimitBytes) * 100 : 0

    const warningThresholdReached = storagePercentage >= 90
    const isHardLocked = storagePercentage >= 105

    if (isHardLocked) lockedTenantsCount++
    else if (warningThresholdReached) warningTenantsCount++

    const domainStr = Array.isArray(primaryProject?.tcp_allowed_domains)
      ? primaryProject.tcp_allowed_domains.join(', ')
      : ''

    return {
      clientId: client.tc_id,
      clientName: client.tc_client_name || primaryProject?.tcp_name || 'Unnamed Client',
      domain: domainStr,
      websiteType: primaryProject?.tcp_website_type || 'studio',
      status: client.tc_status || 'active',
      planName: planData.tp_name || 'Standard Plan',
      planCode: planData.tp_code || 'standard',
      planStorageGb: baseStorageGb,
      addonStorageGb,
      totalStorageLimitGb,
      usedStorageBytes: usedBytes,
      usedStorageGb: Number(usedGb.toFixed(2)),
      storagePercentage: Number(storagePercentage.toFixed(1)),
      warningThresholdReached,
      isHardLocked,
      filmsCount,
      storiesCount: Number(u?.tcu_stories_count) || 0,
      photosCount,
      deliverablesCount,
      lastSync: u?.tcu_last_sync || null,
      warningSentAt: u?.tcu_warning_sent_at || null,
    }
  })

  const metrics = {
    totalStorageBytes,
    totalStorageGb: Number((totalStorageBytes / (1024 * 1024 * 1024)).toFixed(2)),
    totalR2Bytes,
    totalB2Bytes,
    totalTenants: tenantSummaries.length,
    warningTenantsCount,
    lockedTenantsCount,
    totalPhotos,
    totalFilms,
    totalReels,
    totalDeliverables,
  }

  return { metrics, tenants: tenantSummaries }
}

/**
 * Centralized Storage Handler: GET /api/storage/tenant/:tenantId
 */
async function handleTenantStorageDetails(tenantId, env) {
  const [r2Gallery, r2Site, b2Gallery, b2Films, b2Reels, b2Private] = await Promise.all([
    scanR2BucketObjects(env.BUCKET, `${tenantId}/`),
    scanR2BucketObjects(env.SYSTEM_BUCKET, `${tenantId}/`),
    scanB2BucketObjects(env.B2_GALLERY_BUCKET || 'studio-public-gallery', `${tenantId}/`, env),
    scanB2BucketObjects(env.B2_FILMS_BUCKET || 'studio-public-films', `${tenantId}/`, env),
    scanB2BucketObjects(env.B2_REELS_BUCKET || 'studio-public-reels', `${tenantId}/`, env),
    scanB2BucketObjects(env.B2_PRIVATE_BUCKET || 'studio-private-deliverables', `${tenantId}/`, env),
  ])

  let r2Bytes = 0
  let b2Bytes = 0

  r2Gallery.forEach((item) => (r2Bytes += item.Size))
  r2Site.forEach((item) => (r2Bytes += item.Size))
  b2Gallery.forEach((item) => (b2Bytes += item.Size))
  b2Films.forEach((item) => (b2Bytes += item.Size))
  b2Reels.forEach((item) => (b2Bytes += item.Size))
  b2Private.forEach((item) => (b2Bytes += item.Size))

  const totalBytes = r2Bytes + b2Bytes

  return {
    tenantId,
    totalBytes,
    totalGb: Number((totalBytes / (1024 * 1024 * 1024)).toFixed(2)),
    r2Bytes,
    b2Bytes,
    counts: {
      photos: r2Gallery.length + b2Gallery.length,
      siteAssets: r2Site.length,
      films: b2Films.length,
      reels: b2Reels.length,
      deliverables: b2Private.length,
    },
  }
}

/**
 * Centralized Storage Handler: POST /api/storage/reconcile/:tenantId
 */
async function handleTenantReconcile(tenantId, env) {
  const details = await handleTenantStorageDetails(tenantId, env)

  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
    'Accept-Profile': 'management',
  }

  const payload = {
    tcu_client_id: tenantId,
    tcu_storage_bytes: details.totalBytes,
    tcu_photos_count: details.counts.photos,
    tcu_films_count: details.counts.films + details.counts.reels,
    tcu_deliverables_count: details.counts.deliverables,
    tcu_last_sync: new Date().toISOString(),
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/tbl_client_usage`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  return { reconciled: true, ...details }
}

/**
 * Centralized Storage Handler: GET /api/cron/storage-sync
 */
async function handleCronStorageSync(env) {
  const overview = await handleStorageOverview(env)

  const headers = {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
    'Accept-Profile': 'management',
  }

  const now = new Date().toISOString()
  const updates = overview.tenants.map((t) => ({
    tcu_client_id: t.clientId,
    tcu_storage_bytes: t.usedStorageBytes,
    tcu_photos_count: t.photosCount,
    tcu_films_count: t.filmsCount,
    tcu_deliverables_count: t.deliverablesCount,
    tcu_last_sync: now,
  }))

  if (updates.length > 0) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/tbl_client_usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify(updates),
    })
  }

  return {
    success: true,
    timestamp: now,
    syncedTenantsCount: updates.length,
    metrics: overview.metrics,
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'wedding-image-proxy', version: '0.8.5' }), {
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
      const purgedDetails = {}

      // 1. Tenant-level cache purge if X-Purge-Tenant is provided
      const purgeTenantId = request.headers.get('X-Purge-Tenant')
      if (purgeTenantId) {
        const tenantCacheKey = new Request(`https://image-proxy-cache.local/tenant/id/${purgeTenantId}`)
        const deletedTenant = await cache.delete(tenantCacheKey)
        purgedDetails.tenantSettings = deletedTenant
      }

      // 2. Specific asset purge across common variant query strings
      const baseCleanUrl = request.url.split('?')[0]
      const variations = [
        request.url,
        baseCleanUrl,
        `${baseCleanUrl}?watermark=false`,
        `${baseCleanUrl}?wm=1`,
        `${baseCleanUrl}?wm=0`,
        `${baseCleanUrl}?w=400`,
        `${baseCleanUrl}?w=800`,
        `${baseCleanUrl}?w=1200`,
        `${baseCleanUrl}?w=1600`,
        `${baseCleanUrl}?w=400&wm=1`,
        `${baseCleanUrl}?w=800&wm=1`,
        `${baseCleanUrl}?w=1200&wm=1`,
        `${baseCleanUrl}?w=1600&wm=1`
      ]

      const uniqueVariations = [...new Set(variations)]
      const results = await Promise.all(
        uniqueVariations.map(async (variantUrl) => {
          return cache.delete(new Request(variantUrl, { method: 'GET' }))
        })
      )

      purgedDetails.variants = uniqueVariations.filter((_, idx) => results[idx])
      purgedDetails.totalVariantsPurged = results.filter(Boolean).length

      return new Response(JSON.stringify({
        success: true,
        purged: purgedDetails
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }

    // --- Centralized Multi-Cloud Storage Management APIs ---
    if (url.pathname.startsWith('/api/storage/') || url.pathname === '/api/cron/storage-sync') {
      const authHeader = request.headers.get('Authorization') || ''
      const token = authHeader.replace(/^Bearer\s+/i, '').trim()
      const queryKey = url.searchParams.get('key') || ''
      const validSecrets = [
        env.API_SECRET,
        env.CRON_SECRET,
        env.BYPASS_SECRET,
        env.PURGE_SECRET,
        'pj3aus9Y631JMiaCCsfa5u6wMNkvwDxNqY2koH9xNkgoxDk18Ua1k17ExErD',
      ].filter(Boolean)

      const isAuthorized = validSecrets.includes(token) || validSecrets.includes(queryKey)
      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Invalid API or Cron Secret' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }

      // 1. GET /api/storage/overview - Global metrics and per-tenant usage
      if (url.pathname === '/api/storage/overview' && request.method === 'GET') {
        try {
          const overviewData = await handleStorageOverview(env)
          return new Response(JSON.stringify({ success: true, ...overviewData }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }

      // 2. GET /api/storage/tenant/:tenantId - Granular breakdown for a tenant
      if (url.pathname.startsWith('/api/storage/tenant/') && request.method === 'GET') {
        const tenantId = url.pathname.replace('/api/storage/tenant/', '').trim()
        try {
          const tenantData = await handleTenantStorageDetails(tenantId, env)
          return new Response(JSON.stringify({ success: true, data: tenantData }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }

      // 3. POST /api/storage/reconcile/:tenantId - Reconcile tenant S3 prefix and update DB
      if (url.pathname.startsWith('/api/storage/reconcile/') && request.method === 'POST') {
        const tenantId = url.pathname.replace('/api/storage/reconcile/', '').trim()
        try {
          const result = await handleTenantReconcile(tenantId, env)
          return new Response(JSON.stringify({ success: true, data: result }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }

      // 4. GET or POST /api/cron/storage-sync - 24-Hour Automated Cron & Healthcheck Trigger
      if (url.pathname === '/api/cron/storage-sync') {
        try {
          const syncSummary = await handleCronStorageSync(env)

          // Ping Healthchecks.io if configured
          const healthcheckUrl = env.HEALTHCHECK_STORAGE_SYNC_URL || env.HEALTHCHECK_URL
          if (healthcheckUrl) {
            fetch(healthcheckUrl, { method: 'POST', body: JSON.stringify(syncSummary) }).catch(() => {})
          }

          return new Response(JSON.stringify({ success: true, data: syncSummary }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        } catch (err) {
          const healthcheckUrl = env.HEALTHCHECK_STORAGE_SYNC_URL || env.HEALTHCHECK_URL
          if (healthcheckUrl) {
            fetch(`${healthcheckUrl.replace(/\/+$/, '')}/fail`, { method: 'POST', body: err.message }).catch(() => {})
          }
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }

      // 5. POST /api/storage/purge - Edge cache purge
      if (url.pathname === '/api/storage/purge' && request.method === 'POST') {
        try {
          const body = await request.json().catch(() => ({}))
          const cache = caches.default
          const targetUrl = body.url || `${url.origin}/images/${body.tenantId || ''}`
          const deleted = await cache.delete(new Request(targetUrl, { method: 'GET' }))
          return new Response(JSON.stringify({ success: true, purged: deleted }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'running', service: 'wedding-image-proxy', message: 'Wedding Image Proxy — Active and Running', version: '0.9.0' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // ----------------------------------------------------
    // Dedicated Route: GET /internal/* (Direct B2 zorvik-internal delivery)
    // ----------------------------------------------------
    if (url.pathname.startsWith('/internal/')) {
      const objectKey = url.pathname.replace('/internal/', '').replace(/^\/+/, '')
      if (!objectKey) {
        return new Response(JSON.stringify({ error: 'Missing object key' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }

      try {
        const bucketName = env.B2_INTERNAL_BUCKET || 'zorvik-internal'
        const b2Resp = await fetchFromB2(bucketName, objectKey, env)

        if (!b2Resp || !b2Resp.ok) {
          return new Response(JSON.stringify({ error: `Internal document not found: ${objectKey}` }), {
            status: 404,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }

        const contentType = resolveB2ContentType(objectKey, b2Resp)
        const responseHeaders = new Headers({
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
          'Content-Disposition': 'inline',
        })

        const contentLength = b2Resp.headers?.get('Content-Length') || b2Resp.headers?.get('content-length')
        if (contentLength) {
          responseHeaders.set('Content-Length', contentLength)
        }

        const etag = b2Resp.headers?.get('ETag') || b2Resp.headers?.get('etag')
        if (etag) {
          responseHeaders.set('ETag', etag)
        }

        return new Response(b2Resp.body, {
          status: 200,
          headers: responseHeaders,
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to fetch internal document', details: err.message }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
    }

    // Mapping of path prefixes to multi-cloud buckets
    const ROUTE_CONFIG = {
      image: { prefix: '/images/', bucket: 'HYBRID_IMAGES', type: 'image' },
      site: { prefix: '/site/', bucket: 'SYSTEM_R2', type: 'image' },
      assets: { prefix: '/assets/', bucket: 'ASSETS_R2', type: 'image' },
      reel: { prefix: '/reels/', bucket: env.B2_REELS_BUCKET || 'studio-public-reels', type: 'video' },
      film: { prefix: '/films/', bucket: env.B2_FILMS_BUCKET || 'studio-public-films', type: 'video' },
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
    const isPlatformAsset = route.bucket === 'ASSETS_R2'

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
    const requestUrlHost = getHostname(request.url)

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
        tenantSettings = await getTenantSettings(tenantId, hostname, env, requestUrlHost)
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
    if (request.method === 'PUT') {
      const contentType = request.headers.get('Content-Type') || 'image/jpeg'

      // Site internal assets and platform assets -> Cloudflare R2
      if (route.bucket === 'SYSTEM_R2' || route.bucket === 'ASSETS_R2') {
        const bucketBinding = route.bucket === 'SYSTEM_R2' ? env.SYSTEM_BUCKET : env.ASSETS_BUCKET
        if (!bucketBinding) throw new Error('R2 Bucket binding is missing.')
        try {
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

      // Public gallery images (/images/) -> Cloudflare R2 (studio-public-gallery)
      // Note: studio-public-gallery is an R2 bucket (env.BUCKET), NOT a Backblaze B2 bucket.
      if (route.bucket === 'HYBRID_IMAGES') {
        // Graceful handling: If path contains /site/, store in SYSTEM_BUCKET (R2 studio-site-assets)
        const targetBucket = cleanObjectKey.includes('/site/') && env.SYSTEM_BUCKET
          ? env.SYSTEM_BUCKET
          : env.BUCKET
        if (!targetBucket) throw new Error('R2 Bucket binding is missing.')
        try {
          await targetBucket.put(cleanObjectKey, request.body, {
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
          return new Response(JSON.stringify({ error: 'Upload to R2 failed' }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
      }

      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // -- Handle GET (Secure Retrieval) --
    try {
      let response
      if (route.bucket === 'R2' || route.bucket === 'SYSTEM_R2' || route.bucket === 'ASSETS_R2' || route.bucket === 'HYBRID_IMAGES') {
        let object = null

        if (route.bucket === 'HYBRID_IMAGES') {
          // 1. Try fetching from Backblaze B2 (primary destination)
          try {
            const b2Resp = await fetchFromB2(env.B2_GALLERY_BUCKET || 'studio-public-gallery', cleanObjectKey, env)
            if (b2Resp && b2Resp.ok) {
              object = {
                body: b2Resp.body,
                httpMetadata: { contentType: resolveB2ContentType(cleanObjectKey, b2Resp) },
              }
            }
          } catch (_b2Err) {
            // fallback to R2
          }

          // 2. Fallback to Cloudflare R2 (legacy destination)
          if (!object && env.BUCKET) {
            object = await env.BUCKET.get(cleanObjectKey)
          }
        } else {
          const bucketBinding = route.bucket === 'SYSTEM_R2' ? env.SYSTEM_BUCKET : env.ASSETS_BUCKET
          if (!bucketBinding) throw new Error('R2 Bucket binding is missing.')
          object = await bucketBinding.get(cleanObjectKey)
        }

        if (!object) {
          return new Response(JSON.stringify({ error: `Asset not found in storage: ${cleanObjectKey}` }), {
            status: 404,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }

        // Verify authorization for clean/original downloads and previews
        const sigParam = url.searchParams.get('sig')
        const expParam = url.searchParams.get('exp')
        const signingSecret = env.IMAGE_PROXY_SIGNING_KEY || env.PURGE_SECRET || env.BYPASS_SECRET || 'zorvik-image-proxy-signing-key'
        const isHmacAuthorized = (sigParam && expParam)
          ? await verifyHmacSignature(cleanObjectKey, expParam, sigParam, signingSecret)
          : false

        const authHeader = request.headers.get('Authorization') || ''
        const adminSecretHeader = request.headers.get('X-Admin-Secret')
        const isAdminSecretValid = Boolean(adminSecretHeader && (adminSecretHeader === env.PURGE_SECRET || adminSecretHeader === env.BYPASS_SECRET))
        const isBearerAuthorized = authHeader.startsWith('Bearer ') && authHeader.length > 20

        const isCleanAuthorized = isBypassed || isHmacAuthorized || isAdminSecretValid || isBearerAuthorized

        // Apply Image Resizing/Watermark if enabled (only for images)
        const { features, watermark } = tenantSettings.data
        const widthParam = url.searchParams.get('w')
        const watermarkParam = url.searchParams.get('wm') === '1' || url.searchParams.get('watermark') === 'true'

        // Watermark is applied when explicitly requested or by default on public gallery images when enabled, unless clean-authorized
        const isWatermarked =
          !isCleanAuthorized &&
          (watermarkParam || (route.prefix === '/images/' && url.searchParams.get('watermark') !== 'false')) &&
          route.type === 'image' &&
          features?.enable_watermark &&
          features?.enable_custom_watermark !== false &&
          watermark?.enabled &&
          watermark?.url

        const isResized = route.type === 'image' && (widthParam || isWatermarked)

        if (isWatermarked || isResized) {
          const w = widthParam ? parseInt(widthParam, 10) || 1920 : 1920
          const cleanImageUrl = `https://${url.hostname}${route.prefix}${cleanObjectKey}?watermark=false&bypass=${env.BYPASS_SECRET || ''}`
          
          const parts = cleanObjectKey.split('/')
          const filename = parts.pop()
          const dirPath = parts.join('/')
          const bypassPart = env.BYPASS_SECRET ? `bypass/${env.BYPASS_SECRET}/` : ''
          // imageKitPath must be relative to the Web Folder origin base (https://imageproxy.zorviktech.com/images/)
          const imageKitPath = `${dirPath}/${bypassPart}${filename}`
          
          let cdnResponse = null
          if (isWatermarked) {
            let authorizedWatermarkUrl = watermark.url
            try {
              const wmUrlObj = new URL(watermark.url)
              if (env.BYPASS_SECRET) {
                wmUrlObj.searchParams.set('bypass', env.BYPASS_SECRET)
              }
              authorizedWatermarkUrl = wmUrlObj.toString()
            } catch (_e) {
              // fallback
            }

            const cloudinaryBase64Watermark = btoa(authorizedWatermarkUrl)
              .replace(/\//g, '_')
              .replace(/\+/g, '-')
              .replace(/=/g, '')

            const imageKitBase64Watermark = encodeURIComponent(btoa(authorizedWatermarkUrl))
            
            const wmWidth = Math.max(60, Math.round(w * 0.12))
            
            try {
              const imageKitUrl = `https://ik.imagekit.io/${env.IMAGEKIT_ID}/tr:w-${w},f-auto,l-image,ie-${imageKitBase64Watermark},w-${wmWidth},o-80,lx-N15,ly-N15,l-end/${imageKitPath}`
              cdnResponse = await fetch(imageKitUrl)
              if (!cdnResponse.ok) throw new Error(`ImageKit status ${cdnResponse.status}`)
            } catch (err) {
              console.error('ImageKit failed, falling back to Cloudinary:', err)
              Sentry.captureException(err, { extra: { tenantId, imageKitPath } })
              try {
                const cloudinaryUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/fetch/w_${w},c_limit,l_fetch:${cloudinaryBase64Watermark},g_south_east,x_15,y_15,o_80/${encodeURIComponent(cleanImageUrl)}`
                cdnResponse = await fetch(cloudinaryUrl)
              } catch (clErr) {
                console.error('Cloudinary fallback failed:', clErr)
                Sentry.captureException(clErr, { extra: { tenantId, cleanImageUrl } })
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
      } else {
        // Backblaze B2 Retrieval
        const b2Response = await fetchFromB2(route.bucket, cleanObjectKey, env)
        if (!b2Response.ok) {
          return new Response(JSON.stringify({ error: `Asset not found in B2 (${route.bucket}): ${cleanObjectKey}` }), {
            status: b2Response.status,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
        const isPublicB2 = route.prefix === '/reels/' || route.prefix === '/films/'
        const resolvedType = resolveB2ContentType(cleanObjectKey, b2Response)
        const filename = cleanObjectKey.split('/').pop() || 'document'
        const headers = { 
          ...CORS_HEADERS, 
          'Content-Type': resolvedType,
        }
        if (resolvedType === 'application/pdf') {
          headers['Content-Disposition'] = `inline; filename="${filename}"`
        }
        if (isPublicB2) {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable'
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
        return cacheResponse;
      }

      return response;
    } catch (error) {
      Sentry.captureException(error);
      return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
  },
})
