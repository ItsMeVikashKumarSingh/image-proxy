/**
 * image-proxy Worker — Unit Test Suite (v0.5.0)
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
  BYPASS_SECRET: 'test-bypass-secret',
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
    expect(body.version).toBe('0.6.0')
  })

  it('GET /: returns 200 simple status message', async () => {
    const req = new Request('https://worker.dev/')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('0.6.0')
  })
})

describe('Identity-First Verification (PUT)', () => {
  it('successfully uploads to R2 when tenantId and Origin are valid', async () => {
    fetch
      .mockResolvedValueOnce(supabaseClientActive('tenant-123'))
      .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: {} }))
      .mockResolvedValueOnce(mockJsonResponse([]))
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

  it('rejects upload (403) when Origin is unauthorized for that tenantId', async () => {
    // Tenant-123 is ONLY authorized for worker.dev, not malicious.com
    fetch.mockResolvedValueOnce(supabaseClientActive('tenant-123'))
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
    fetch
      .mockResolvedValueOnce(supabaseClientActive('tenant-123'))
      .mockResolvedValueOnce(mockJsonResponse({ tp_id: 'plan-basic', tp_features: {} }))
      .mockResolvedValueOnce(mockJsonResponse([]))
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
    // Verify it retrieves standard cleaned object key without standard suffix
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
    // Verify it retrieves standard cleaned object key with standard infix removed
    expect(mockBucket.get).toHaveBeenCalledWith('tenant-123/photo.jpg')
  })
})
