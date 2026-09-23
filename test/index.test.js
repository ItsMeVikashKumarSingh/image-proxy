/**
 * image-proxy Worker — Unit Test Suite (v0.8.4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../src/index.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const mockBucket = {
  get: vi.fn(),
  put: vi.fn(),
}

const mockSystemBucket = {
  get: vi.fn(),
  put: vi.fn(),
}

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  BUCKET: mockBucket,
  SYSTEM_BUCKET: mockSystemBucket,
  BYPASS_SECRET: 'test-bypass-secret',
  B2_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
  B2_APPLICATION_KEY_ID: 'test-key-id',
  B2_APPLICATION_KEY: 'test-key-secret',
  B2_GALLERY_BUCKET: 'studio-public-gallery',
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
}

const supabaseClientActive = (id = 'tenant-123') => mockJsonResponse({
  tc_id: id,
  tc_domain: 'worker.dev, localhost',
  tc_status: 'active',
  tc_plan_id: 'plan-basic',
  tc_feature_overrides: { enable_watermark: false }
})

function mockTenantLookupSuccess(tenantId = 'tenant-123', domains = ['worker.dev', 'localhost'], features = {}) {
  fetch
    .mockResolvedValueOnce(supabaseClientActive(tenantId))
    .mockResolvedValueOnce(mockJsonResponse([{
      tcp_id: 'proj-1',
      tcp_client_id: tenantId,
      tcp_is_primary: true,
      tcp_allowed_domains: domains,
      tcp_plan_id: 'plan-basic',
    }]))
    .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: features }))
    .mockResolvedValueOnce(mockJsonResponse([]))
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    }
  })
  mockBucket.get.mockReset()
  mockBucket.put.mockReset()
  mockSystemBucket.get.mockReset()
  mockSystemBucket.put.mockReset()
  mockCtx.waitUntil.mockReset()
  mockCtx.passThroughOnException.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('Basic Routing', () => {
  it('GET /health: returns 200 with service metadata', async () => {
    const req = new Request('https://worker.dev/health')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.service).toBe('zmedia')
    expect(body.version).toBe('0.9.0')
  })

  it('GET /: returns 200 simple status message', async () => {
    const req = new Request('https://worker.dev/')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toMatch(/^\d+\.\d+(\.\d+)?$/)
  })
})

describe('Identity-First Verification (PUT)', () => {
  it('successfully uploads site assets to R2 when tenantId and Origin are valid', async () => {
    mockTenantLookupSuccess('tenant-123')
    mockSystemBucket.put.mockResolvedValueOnce(undefined)

    const req = new Request('https://worker.dev/site/tenant-123/logo.png', {
      method: 'PUT',
      headers: { 'Origin': 'http://localhost:5173', 'Content-Type': 'image/png' },
      body: new Uint8Array([0x00])
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockSystemBucket.put).toHaveBeenCalledWith('tenant-123/logo.png', expect.anything(), expect.objectContaining({
      customMetadata: expect.objectContaining({ tenant_id: 'tenant-123' })
    }))
  })

  it('successfully uploads gallery images to Cloudflare R2 bucket', async () => {
    mockTenantLookupSuccess('tenant-123')
    mockBucket.put.mockResolvedValueOnce(undefined)

    const req = new Request('https://worker.dev/images/tenant-123/test.jpg', {
      method: 'PUT',
      headers: { 'Origin': 'http://localhost:5173', 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([0x00])
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.put).toHaveBeenCalledWith('tenant-123/test.jpg', expect.anything(), expect.objectContaining({
      customMetadata: expect.objectContaining({ tenant_id: 'tenant-123' })
    }))
  })

  it('gracefully routes /images/.../site/... uploads to SYSTEM_BUCKET in R2', async () => {
    mockTenantLookupSuccess('tenant-123')
    mockSystemBucket.put.mockResolvedValueOnce(undefined)

    const req = new Request('https://worker.dev/images/tenant-123/site/watermark.png', {
      method: 'PUT',
      headers: { 'Origin': 'http://localhost:5173', 'Content-Type': 'image/png' },
      body: new Uint8Array([0x00])
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockSystemBucket.put).toHaveBeenCalledWith('tenant-123/site/watermark.png', expect.anything(), expect.objectContaining({
      customMetadata: expect.objectContaining({ tenant_id: 'tenant-123' })
    }))
  })

  it('rejects upload (403) when Origin is unauthorized for that tenantId', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientActive('tenant-123'))
      .mockResolvedValueOnce(mockJsonResponse([{
        tcp_id: 'proj-1',
        tcp_client_id: 'tenant-123',
        tcp_is_primary: true,
        tcp_allowed_domains: ['worker.dev'],
        tcp_plan_id: 'plan-basic',
      }]))
      .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: {} }))
      .mockResolvedValueOnce(mockJsonResponse([]))

    const req = new Request('https://worker.dev/images/tenant-123/test.jpg', {
      method: 'PUT',
      headers: { 'Origin': 'https://malicious.com' }
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHORIZED_DOMAIN')
  })

  it('rejects request (400) when tenantId is missing in path', async () => {
    const req = new Request('https://worker.dev/images/photo.jpg') // No ID segment
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Incomplete path/)
  })
})

describe('Identity-First Verification (GET)', () => {
  it('serves image when tenantId and Host match', async () => {
    mockTenantLookupSuccess('tenant-123')
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const req = new Request('https://worker.dev/images/tenant-123/photo.jpg', {
      headers: { 'Origin': 'https://worker.dev' }
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/photo.jpg')
  })

  it('serves image when path-based bypass token is present', async () => {
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    // Request path contains standard /bypass/test-bypass-secret suffix
    const req = new Request('https://worker.dev/images/tenant-123/photo.jpg/bypass/test-bypass-secret')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/photo.jpg')
  })

  it('serves image when path-based bypass token is present as infix', async () => {
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    // Request path contains standard /bypass/test-bypass-secret/ infix
    const req = new Request('https://worker.dev/images/tenant-123/bypass/test-bypass-secret/photo.jpg')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/photo.jpg')
  })

  it('serves PDF contract on direct link navigation without Origin/Referer headers', async () => {
    mockTenantLookupSuccess('tenant-123', ['clientcustomdomain.com'])
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'application/pdf' }
    })

    // Direct link click or navigation: request has no Origin or Referer
    const req = new Request('https://imageproxy.zorviktech.com/images/tenant-123/contracts/signed_contract.pdf')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/contracts/signed_contract.pdf')
  })

  it('allows requests from system platform subdomains (*.zorviktech.com)', async () => {
    mockTenantLookupSuccess('tenant-123', ['clientcustomdomain.com'])
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'application/pdf' }
    })

    const req = new Request('https://imageproxy.zorviktech.com/images/tenant-123/contracts/signed_contract.pdf', {
      headers: { 'Origin': 'https://studio.zorviktech.com' }
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
  })

  it('fetches deliverable from Backblaze B2 with protocol-prefixed B2_ENDPOINT', async () => {
    const b2Env = {
      ...mockEnv,
      B2_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
      B2_APPLICATION_KEY_ID: 'test-key-id',
      B2_APPLICATION_KEY: 'test-key-secret',
      B2_PRIVATE_BUCKET: 'studio-private-deliverables',
    }

    mockTenantLookupSuccess('tenant-123')
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    }))

    const req = new Request('https://worker.dev/deliverables/tenant-123/contracts/signed_contract.pdf', {
      headers: { 'Origin': 'http://localhost:5173' },
    })

    const res = await worker.fetch(req, b2Env, mockCtx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')

    // Verify fetch was called with cleaned S3 URL (without duplicate https://)
    const b2Call = fetch.mock.calls[4]
    const fetchedUrl = typeof b2Call[0] === 'string' ? b2Call[0] : b2Call[0].url
    expect(fetchedUrl).toBe('https://studio-private-deliverables.s3.eu-central-003.backblazeb2.com/tenant-123/contracts/signed_contract.pdf')
  })

  it('serves clean original asset when valid HMAC signature is provided', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientActive('tenant-123'))
      .mockResolvedValueOnce(mockJsonResponse([{
        tcp_id: 'proj-1',
        tcp_client_id: 'tenant-123',
        tcp_is_primary: true,
        tcp_allowed_domains: ['worker.dev'],
        tcp_plan_id: 'plan-basic',
      }]))
      .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: { enable_watermark: true } }))
      .mockResolvedValueOnce(mockJsonResponse([
        { tss_key: 'watermark_enabled', tss_value: 'true' },
        { tss_key: 'watermark_url', tss_value: 'https://imageproxy.zorviktech.com/images/tenant-123/watermark.png' }
      ]))
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x01, 0x02, 0x03]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const exp = Math.floor(Date.now() / 1000) + 3600
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('test-bypass-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`tenant-123/photo.jpg:${exp}`))
    const sig = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

    const req = new Request(`https://worker.dev/images/tenant-123/photo.jpg?exp=${exp}&sig=${sig}`, {
      headers: { 'Origin': 'https://worker.dev' }
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/photo.jpg')
  })

  it('successfully fetches and serves external Google Drive media via /external/', async () => {
    mockTenantLookupSuccess('tenant-123')
    const externalUrl = 'https://lh3.googleusercontent.com/d/mock-file-id=w1600'
    const b64Url = Buffer.from(externalUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    // Mock fetch for external image
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([0x01, 0x02]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' }
    }))

    const req = new Request(`https://worker.dev/images/tenant-123/external/${b64Url}?watermark=false`, {
      headers: { 'Origin': 'https://worker.dev' }
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })
})
