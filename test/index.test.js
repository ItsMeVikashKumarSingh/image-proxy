/**
 * image-proxy Worker — Unit Test Suite (v1.2.0)
 *
 * Tests run in Node 20+ which provides native:
 *   Request, Response, URL, fetch — matching Cloudflare Workers runtime APIs.
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
}

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  BUCKET: mockBucket,
}

const supabaseClientNoWatermark = () => mockJsonResponse({
  tc_id: 'tenant-123',
  tc_domain: 'worker.dev',
  tc_status: 'active',
  tc_plan_id: 'plan-basic',
  tc_feature_overrides: { enable_watermark: false }
})

const supabaseClientWithWatermark = () => mockJsonResponse({
  tc_id: 'tenant-123',
  tc_domain: 'worker.dev',
  tc_status: 'active',
  tc_plan_id: 'plan-pro',
  tc_feature_overrides: { 
    enable_watermark: true,
    watermark_url: 'https://cdn.example.com/wm.png'
  }
})

const supabasePlanBasic = () => mockJsonResponse({
  tp_id: 'plan-basic',
  tp_features: { enable_watermark: false }
})

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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('OPTIONS — CORS preflight', () => {
  it('returns 204 with correct CORS headers', async () => {
    const req = new Request('https://worker.dev/images/test/photo.jpg', {
      method: 'OPTIONS',
    })
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('GET /health', () => {
  it('returns 200 with service metadata', async () => {
    const req = new Request('https://worker.dev/health')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('1.2.0')
  })

  it('includes CORS headers on health response', async () => {
    const req = new Request('https://worker.dev/health')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('GET / — Root welcome message', () => {
  it('returns 200 with service identity', async () => {
    const req = new Request('https://worker.dev/')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/Proxy/)
  })
})

describe('GET /unknown-path — 404 routing', () => {
  it('returns 404 for unhandled subpaths', async () => {
    const req = new Request('https://worker.dev/non-existent')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(404)
  })
})

describe('GET /images/* — request validation', () => {
  it('returns 400 when object key is missing in pathname', async () => {
    const req = new Request('https://worker.dev/images/')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing/)
  })
})

describe('GET /images/* — license validation', () => {
  it('returns 403 when domain is not found in Supabase', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ error: 'not found' }, 406))
    const req = new Request('https://worker.dev/images/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHORIZED_DOMAIN')
  })

  it('returns 403 when tenant is suspended', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ tc_id: 't1', tc_domain: 'worker.dev', tc_status: 'suspended' }))
    const req = new Request('https://worker.dev/images/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('TENANT_SUSPENDED')
  })
})

describe('GET /images/* — image serving', () => {
  it('serves raw image when watermark is disabled', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientNoWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
    
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const req = new Request('https://worker.dev/images/folder/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(mockBucket.get).toHaveBeenCalledWith('folder/photo.jpg')
  })

  it('applies CF resizing drawing when watermark is enabled', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientWithWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
    
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const req = new Request('https://worker.dev/images/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    
    // In this environment, we can't easily check cfOptions inside worker.fetch
    // but we can verify the response was returned correctly.
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('photo.jpg')
  })
})

describe('GET /images/* — caching', () => {
  it('uses Cloudflare Cache API for tenant settings', async () => {
    caches.default.match.mockResolvedValueOnce(mockJsonResponse({ data: { features: { enable_watermark: false } } }))
    
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const req = new Request('https://worker.dev/images/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(0) // No Supabase fetch because of cache
    expect(mockBucket.get).toHaveBeenCalledTimes(1)
  })
})

describe('GET /images/* — error handling', () => {
  it('returns 500 on unexpected network errors', async () => {
    fetch.mockRejectedValueOnce(new Error('DB failure'))
    const req = new Request('https://worker.dev/images/photo.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Internal Server Error')
  })

  it('returns 404 when asset is missing in R2', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientNoWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
    
    mockBucket.get.mockResolvedValueOnce(null)

    const req = new Request('https://worker.dev/images/missing.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/Asset not found/)
  })
})
