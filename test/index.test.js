/**
 * image-proxy Worker — Unit Test Suite (v1.4.0)
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

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  BUCKET: mockBucket,
}

const supabaseClientActive = () => mockJsonResponse({
  tc_id: 'tenant-123',
  tc_domain: 'worker.dev, localhost',
  tc_status: 'active',
  tc_plan_id: 'plan-basic',
  tc_feature_overrides: { enable_watermark: false }
})

const supabaseClientSuspended = () => mockJsonResponse({
  tc_id: 'tenant-123',
  tc_domain: 'worker.dev',
  tc_status: 'suspended'
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
  mockBucket.put.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('Basic Routing', () => {
  it('GET /health: returns 200 with service metadata', async () => {
    const req = new Request('https://worker.dev/health')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('1.4.0')
  })

  it('GET /: returns 200 simple status message', async () => {
    const req = new Request('https://worker.dev/')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('running')
  })

  it('GET /unknown: returns 404', async () => {
    const req = new Request('https://worker.dev/non-existent')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(404)
  })
})

describe('Secure Upload Proxy (PUT)', () => {
  it('successfully uploads to R2 when origin is authorized', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientActive())
      .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: {} }))
    mockBucket.put.mockResolvedValueOnce(undefined)

    const req = new Request('https://worker.dev/images/test.jpg', {
      method: 'PUT',
      headers: { 'Origin': 'http://localhost:5173', 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([0x00])
    })
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    expect(mockBucket.put).toHaveBeenCalledWith('test.jpg', expect.anything(), expect.objectContaining({
      customMetadata: expect.objectContaining({ tenant_id: 'tenant-123' })
    }))
  })

  it('rejects upload (403) when domain is unauthorized', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Not authorized' }, 406))
    const req = new Request('https://worker.dev/images/test.jpg', {
      method: 'PUT',
      headers: { 'Origin': 'https://malicious.com' }
    })
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHORIZED_DOMAIN')
  })

  it('rejects upload (403) when tenant is suspended', async () => {
    fetch.mockResolvedValueOnce(supabaseClientSuspended())
    const req = new Request('https://worker.dev/images/test.jpg', {
      method: 'PUT',
      headers: { 'Origin': 'https://worker.dev' }
    })
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('TENANT_SUSPENDED')
  })
})

describe('Image Serving (GET /images/*)', () => {
  it('serves image when authorized', async () => {
    fetch.mockResolvedValueOnce(supabaseClientActive())
    mockBucket.get.mockResolvedValueOnce({
      body: new Uint8Array([0x00]).buffer,
      httpMetadata: { contentType: 'image/jpeg' }
    })

    const req = new Request('https://worker.dev/images/photo.jpg', {
        headers: { 'Origin': 'https://worker.dev' }
    })
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(200)
    expect(mockBucket.get).toHaveBeenCalledWith('photo.jpg')
  })
})
