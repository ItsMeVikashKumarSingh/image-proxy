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

function mockImageResponse(status = 200) {
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer, {
    status,
    headers: { 'Content-Type': 'image/jpeg' },
  })
}

const mockEnv = {
  BUCKET_ACCESS_TOKEN: 'test-token-abc123',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('OPTIONS — CORS preflight', () => {
  it('returns 204 with correct CORS headers', async () => {
    const req = new Request('https://worker.dev/images/test?url=https://bucket.example.com/img.jpg', {
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
  it('returns 400 when url param is missing', async () => {
    const req = new Request('https://worker.dev/images/photo')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing/)
  })

  it('returns 400 when url param is invalid', async () => {
    const req = new Request('https://worker.dev/images/photo?url=invalid')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(400)
  })
})

describe('GET /images/* — license validation', () => {
  it('returns 403 when domain is not found in Supabase', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ error: 'not found' }, 406))
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHORIZED_DOMAIN')
  })

  it('returns 403 when tenant is suspended', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ tc_id: 't1', tc_domain: 'worker.dev', tc_status: 'suspended' }))
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
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
      .mockResolvedValueOnce(mockImageResponse())
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('applies CF resizing drawing when watermark is enabled', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientWithWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
      .mockResolvedValueOnce(mockImageResponse())
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    await worker.fetch(req, mockEnv, {})
    const cfOptions = fetch.mock.calls[2][1]
    expect(cfOptions.cf.image.draw[0].url).toBe('https://cdn.example.com/wm.png')
  })

  it('passes Authorization header to bucket fetch', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientNoWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
      .mockResolvedValueOnce(mockImageResponse())

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    await worker.fetch(req, mockEnv, {})

    const bucketReq = fetch.mock.calls[2][0]
    expect(bucketReq.headers.get('Authorization')).toBe('Bearer test-token-abc123')
  })

  it('fetches bucket without Authorization when token is missing', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientNoWatermark())
      .mockResolvedValueOnce(supabasePlanBasic())
      .mockResolvedValueOnce(mockImageResponse())

    const envNoToken = { 
      SUPABASE_URL: 'https://test.supabase.co', 
      SUPABASE_SERVICE_ROLE_KEY: 'test-key' 
    }
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    await worker.fetch(req, envNoToken, {})

    const bucketReq = fetch.mock.calls[2][0]
    expect(bucketReq.headers.get('Authorization')).toBeNull()
  })
})

describe('GET /images/* — caching', () => {
  it('uses Cloudflare Cache API for tenant settings', async () => {
    caches.default.match.mockResolvedValueOnce(mockJsonResponse({ data: { features: { enable_watermark: false } } }))
    fetch.mockResolvedValueOnce(mockImageResponse())
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1) // Only bucket fetch, no Supabase fetch
  })
})

describe('GET /images/* — error handling', () => {
  it('returns 500 on unexpected network errors', async () => {
    fetch.mockRejectedValueOnce(new Error('DB failure'))
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Internal Server Error')
  })
})
