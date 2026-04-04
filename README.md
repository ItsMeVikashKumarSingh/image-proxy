# wedding-image-proxy

[![CI — wedding-image-proxy](https://github.com/YOUR_ORG/wedding-image-proxy/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/YOUR_ORG/wedding-image-proxy/actions/workflows/ci.yml)

> **Cloudflare Worker** — Real-time image watermarking and secure asset delivery for the DreamlandStudiOz multi-tenant platform.

Receives image requests from the WEDDING frontend, validates the requesting studio's license via the **Zorvik License API**, fetches the original asset from **Cloudflare R2 / Backblaze B2**, and applies **dynamic watermarks** on-the-fly via Cloudflare Image Resizing — all at the edge, with zero origin server involvement.

---

## Architecture

```
WEDDING Frontend (Netlify)
        │
        │  GET /images/*?url=<bucket_asset_url>
        ▼
wedding-image-proxy.workers.dev   (this project)
        │
        ├── GET Supabase REST API ──► validate tenant & features
        │         ▼  authorized
        ├── GET private R2 / B2 URL
        │         ▼
        └── Cloudflare Image Resizing ──► apply watermark ──► return image
```

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Service welcome message & docs link |
| `/health` | `GET` | Health check — returns `{ status: "ok" }` |
| `/images/*?url=<full_url>` | `GET` | Fetch & conditionally watermark image |
| `*` | `OPTIONS` | CORS preflight — 204 |

### Request Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `url` | Query string | Yes | Fully-qualified URL of the asset in R2/B2 |

### Response

- `200 OK` — image bytes with correct `Content-Type`
- `400 Bad Request` — missing or invalid `url` query param
- `403 Forbidden` — domain not authorized by Zorvik License API
- `404 Not Found` — path not handled by this worker
- `500 Internal Server Error` — unexpected error (safe, no internals exposed)

All responses include `Access-Control-Allow-Origin: *`.

---

## Environment Variables & Secrets

| Name | Storage | Required | Description |
|---|---|---|---|
| `BUCKET_ACCESS_TOKEN` | Cloudflare Worker Secret | Yes | Bearer token for private R2 / B2 bucket |
| `SUPABASE_URL` | Cloudflare Worker Secret | Yes | Supabase project URL (`https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker Secret | Yes | Service role key for license verification |

> **Security rule**: No secrets may be stored in `wrangler.toml` or any committed file. Use `wrangler secret put` or the Cloudflare dashboard.

---

## Local Development

### 1. Clone & install

```bash
git clone https://github.com/YOUR_ORG/wedding-image-proxy.git
cd wedding-image-proxy
npm install
```

### 2. Configure local secrets

```bash
# Option A: Copy .dev.vars.example to .dev.vars (Cloudflare Native)
cp .dev.vars.example .dev.vars

# Option B: Use .env.example as a reference for your CI/CD setup
cp .env.example .dev.vars
```

`.dev.vars`:
```env
# REQUIRED: Bearer token for accessing private R2 or Backblaze B2 bucket
BUCKET_ACCESS_TOKEN=your_bucket_access_token_here

# REQUIRED: Supabase project URL & Service Role Key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

### 3. Start local dev server

```bash
npm run dev
# Wrangler starts on http://localhost:8787
```

### 4. Test endpoints locally

```bash
# Health check
curl http://localhost:8787/health

# Image request
curl "http://localhost:8787/images/test?url=https://your-r2-bucket.r2.dev/photo.jpg"
```

---

## Running Tests

```bash
npm test           # Single run (vitest)
npm run test:watch # Watch mode
```

Tests run in Node 20+ using **Vitest** with `vi.stubGlobal('fetch', ...)` to mock all network calls. No internet connection required.

### Test coverage

| Suite | Tests |
|---|---|
| CORS preflight | OPTIONS → 204 + headers |
| Health check | GET /health → 200 + metadata |
| 404 routing | Unknown paths → 404 |
| Request validation | Missing url → 400, Invalid url → 400 |
| License validation | 403 from API → 403 returned, 503 from API → 403 returned |
| Image serving (no watermark) | Correct 200 + auth header forwarding |
| Image serving (with watermark) | CF image options passed correctly |
| Error safety | Network failure → 500, no internal details leaked |

---

## Linting

```bash
npm run lint        # Check (zero warnings policy)
npm run lint:fix    # Auto-fix
```

Uses **ESLint 9 Flat Config** (`eslint.config.js`) with separate rule sets for `src/` (Cloudflare Workers runtime) and `test/` (Node.js + Vitest).

---

## Deployment

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 2. Add Worker Secrets (one-time setup)

```bash
wrangler secret put BUCKET_ACCESS_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

### 3. Deploy

```bash
npm run deploy
```

Wrangler outputs your worker URL:
```
https://wedding-image-proxy.your-account.workers.dev
```

### 4. Update wedding-server config

Add the URL to **`wedding-server/.env.local`** and Vercel dashboard:

```env
R2_PUBLIC_CUSTOM_DOMAIN=https://wedding-image-proxy.your-account.workers.dev
```

---

## CI/CD (GitHub Actions)

The **`ci.yml`** workflow runs on every push to `master` and all PRs:

| Job | Tool | What it checks |
|---|---|---|
| `lint` | ESLint 9 | Zero warning policy on `src/` and `test/` |
| `test` | Vitest | All unit tests must pass |
| `build` | Wrangler dry-run | Bundle validates without actual deploy |

> **Production deploys are manual** via `npm run deploy` after secrets are confirmed.  
> To enable auto-deploy from CI, add a `CLOUDFLARE_API_TOKEN` secret to the GitHub repo and use `cloudflare/wrangler-action@v3`.

---

## Monitoring (Live Logs)

```bash
npm run tail
# Streams real-time logs from the deployed worker
```

---

## Project Structure

```
image-proxy/
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions — lint + test + build
├── .husky/
│   └── pre-commit              # Husky hook — runs lint-staged before commit
├── src/
│   └── index.js                # Worker entrypoint
├── test/
│   └── index.test.js           # Vitest unit tests
├── .coderabbit.yaml            # CodeRabbit review configuration
├── .dev.vars.example           # Local dev secrets template (safe to commit)
├── .gitignore
├── eslint.config.js            # ESLint 9 Flat Config
├── package.json
├── README.md
├── VERSION.md
├── vitest.config.js
└── wrangler.toml               # Cloudflare Worker deploy config
```

---

## GitHub Repository Description

> Cloudflare Worker for secure, real-time image watermarking — validates studio tenants directly via **Supabase Database (Edge REST API)** and serves assets from R2/B2 with Cloudflare Image Resizing.

**Topics to add:** `cloudflare-workers`, `wrangler`, `image-watermarking`, `edge-computing`, `cloudflare-r2`, `multi-tenant`
