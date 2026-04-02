/**
 * image-proxy Worker — Unit Test Suite
 *
 * Tests run in Node 20+ which provides native:
 *   Request, Response, URL, fetch — matching Cloudflare Workers runtime APIs.
 *
 * Fetch is globally stubbed via vi.stubGlobal() before each test to mock
 * the license API and bucket fetch calls without network I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../src/index.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock JSON Response for fetch interception.
 * @param {object} body - JSON-serializable response body
 * @param {number} status - HTTP status code
 */
function mockJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Creates a mock binary image Response.
 * @param {number} status - HTTP status code
 */
function mockImageResponse(status = 200) {
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer, {
    status,
    headers: { 'Content-Type': 'image/jpeg' },
  })
}

/** Default env bindings mirroring Cloudflare Worker Secrets */
const mockEnv = {
  BUCKET_ACCESS_TOKEN: 'test-token-abc123',
  LICENSE_API_BASE: 'https://api.zorvik.com/api/v1/verify',
}

/** License API: authorized tenant with watermark DISABLED */
const licenseNoWatermark = () => mockJsonResponse({
  data: { features: { enable_watermark: false, watermark_url: null } },
}, 200)

/** License API: authorized tenant with watermark ENABLED */
const licenseWithWatermark = () => mockJsonResponse({
  data: {
    features: {
      enable_watermark: true,
      watermark_url: 'https://cdn.example.com/wm.png',
    },
  },
}, 200)

/** License API: unauthorized domain — 403 */
const licenseUnauthorized = () => mockJsonResponse({ error: 'unauthorized' }, 403)

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
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
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })
})

describe('GET /health', () => {
  it('returns 200 with service metadata', async () => {
    const req = new Request('https://worker.dev/health')

    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.service).toBe('wedding-image-proxy')
    expect(body.version).toBeDefined()
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
    expect(body.status).toBe('active')
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
    const body = await res.json()
    expect(body.error).toMatch(/Missing/)
  })

  it('returns 400 when url param is not a valid URL', async () => {
    const req = new Request('https://worker.dev/images/photo?url=not-a-valid-url')
    const res = await worker.fetch(req, mockEnv, {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Invalid/)
  })
})

describe('GET /images/* — license validation', () => {
  it('returns 403 when license API rejects the domain', async () => {
    fetch.mockResolvedValueOnce(licenseUnauthorized())

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/[Uu]nauthorized/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns 403 when license API is unreachable (non-ok status)', async () => {
    fetch.mockResolvedValueOnce(mockJsonResponse({ error: 'service unavailable' }, 503))

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(403)
  })
})

describe('GET /images/* — image serving without watermark', () => {
  it('serves raw image when watermark is disabled', async () => {
    fetch
      .mockResolvedValueOnce(licenseNoWatermark())   // license API
      .mockResolvedValueOnce(mockImageResponse())   // bucket fetch

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('passes Authorization header to bucket when token is set', async () => {
    fetch
      .mockResolvedValueOnce(licenseNoWatermark())
      .mockResolvedValueOnce(mockImageResponse())

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    await worker.fetch(req, mockEnv, {})

    // Second fetch call is the bucket fetch
    const bucketCall = fetch.mock.calls[1]
    const bucketReq = bucketCall[0]
    expect(bucketReq.headers.get('Authorization')).toBe('Bearer test-token-abc123')
  })

  it('fetches bucket without Authorization when token is missing', async () => {
    fetch
      .mockResolvedValueOnce(licenseNoWatermark())
      .mockResolvedValueOnce(mockImageResponse())

    const envNoToken = { LICENSE_API_BASE: 'https://api.zorvik.com/api/v1/verify' }
    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    await worker.fetch(req, envNoToken, {})

    const bucketReq = fetch.mock.calls[1][0]
    expect(bucketReq.headers.get('Authorization')).toBeNull()
  })
})

describe('GET /images/* — image serving with watermark', () => {
  it('applies Cloudflare Image Resizing cf options when watermark is enabled', async () => {
    fetch
      .mockResolvedValueOnce(licenseWithWatermark())   // license API
      .mockResolvedValueOnce(mockImageResponse())    // CF image resizing fetch

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(200)
    // Verify that the second fetch was called with CF image options (second arg)
    const [_bucketReq, cfOptions] = fetch.mock.calls[1]
    expect(cfOptions).toBeDefined()
    expect(cfOptions.cf.image.draw[0].url).toBe('https://cdn.example.com/wm.png')
    expect(cfOptions.cf.image.draw[0].gravity).toBe('bottom-right')
  })
})

describe('GET /images/* — error handling', () => {
  it('returns 500 on unexpected errors without leaking internals', async () => {
    fetch.mockRejectedValueOnce(new Error('Network failure — simulated'))

    const req = new Request('https://worker.dev/images/photo?url=https://bucket.example.com/img.jpg')
    const res = await worker.fetch(req, mockEnv, {})

    expect(res.status).toBe(500)
    const body = await res.json()
    // Safe response — must not contain stack trace or internal error details
    expect(body.error).toBe('Internal Server Error')
    expect(JSON.stringify(body)).not.toContain('Network failure')
    expect(JSON.stringify(body)).not.toContain('stack')
  })
})
