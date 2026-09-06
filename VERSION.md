# image-proxy — Version History

## VERSION 0.8.2 (2026-09-06) - Multi-Project Architecture Alignment & Legacy Column Elimination
- **Native Multi-Project Lookup**: Updated `getTenantSettings` to query `management.tbl_client_projects` alongside `tbl_clients`, dynamically collecting licensed domains across all active client projects (`tcp_allowed_domains`) and applying primary project plan features and overrides.
- **Eliminated Deprecated `tc_domain` Queries**: Permanently replaced direct queries on `management.tbl_clients.tc_domain` in domain authorization checks and `/api/storage/overview` reporting with `tbl_client_projects`.
- **Primary Project Storage Quota Aggregation**: Updated `handleStorageOverview` to map tenant domain, website type, plan tiers, and storage add-ons directly from the client's primary project.

## VERSION 0.8.1 (2026-09-01) - Dedicated zorvik-internal Document CDN Delivery Endpoint
- **Dedicated Route (`GET /internal/*`)**: Added pure document streaming directly from the Backblaze B2 `zorvik-internal` bucket via AWS SigV4.
- **Zero Image Manipulation Overhead**: Internal invoices, agreements, and receipts are delivered verbatim with `Content-Type: application/pdf`, `Content-Disposition: inline`, and Cloudflare Edge caching (`Cache-Control: public, max-age=86400, s-maxage=604800`).
- **Domain Privacy & $0 Egress**: Eliminates direct exposure of Backblaze S3 bucket URLs and serves documents under the official Zorvik CDN domain.

## VERSION 0.8.0 (2026-08-29) - Migrate Platform Assets to Cloudflare R2 & Decommission Supabase Storage
- **Dedicated R2 Assets Binding (`ASSETS_BUCKET`)**: Mapped the `/assets/` route prefix directly to the dedicated `zorvik-assets` Cloudflare R2 bucket.
- **Decommissioned Supabase Storage**: Removed all authenticated Supabase Storage HTTP fetches and dependencies from the Edge Gateway.
- **Edge Caching & Performance**: Enabled full Cloudflare Edge Worker caching and ImageKit/Cloudinary optimization on R2 platform assets.

## VERSION 0.7.21 (2026-08-25) - Backblaze B2 PDF & Deliverable MIME Type Resolution
- **Accurate MIME Type Handling (`resolveB2ContentType`)**: Added dynamic extension-based MIME type inference for Backblaze B2 objects (`.pdf` -> `application/pdf`, `.zip` -> `application/zip`, `.mp4` -> `video/mp4`, images), eliminating incorrect video fallback on PDF files.
- **Inline PDF Browser Viewing**: Added `Content-Disposition: inline` for PDF documents, allowing signed contracts and PDF deliverables to render directly in browser tabs without corruption.

## VERSION 0.7.20 (2026-08-23) - Scope Watermarking Exclusively to Marketing/Public Assets
- **Scoping Fix**: Scoped watermarking overlay processing specifically to marketing/site assets requesting watermarking (`wm=1` / `watermark=true`).
- **Clean Deliverables & Previews**: Ensured shared galleries, client deliverables, and admin dashboard panels view cleanly without watermarks while still enforcing HMAC signature verification for original master downloads.

## VERSION 0.7.19 (2026-08-23) - Secure Watermarking & HMAC Signature Authorization
- **Eliminated Parameter Bypass**: Removed client-controlled `watermark=false` query parameter bypass. Watermarks are now strictly enforced by the Edge Worker based on tenant database configuration.
- **HMAC-SHA256 Signed URLs**: Added edge verification (`verifyHmacSignature`) for authorized clean full-resolution asset downloads using signed `sig` and `exp` tokens.
- **Admin Authorization**: Supported Bearer and Admin secret authorization at the edge for clean dashboard previews and management.
- **Web Resolution Optimization**: Capped and auto-optimized public web viewing requests with automatic AVIF/WebP conversion while safeguarding original full-resolution master files.

## VERSION 0.7.18 (2026-08-16) - Fix Backblaze B2 Endpoint URL Normalization
- **Endpoint Protocol Normalization**: Stripped leading `https://` / `http://` protocols from `env.B2_ENDPOINT` inside `fetchFromB2`. This fixes malformed S3 endpoint and Host headers (`https://<bucket>.https://...`) that previously caused 404 `Asset not found in B2` responses when downloading signed contract PDFs and private vault deliverables from Backblaze B2.
- **Unit Tests**: Added automated unit test verifying B2 deliverable asset retrieval with full protocol-prefixed `B2_ENDPOINT`.

## VERSION 0.7.17 (2026-07-26) - B2 Private Vault Fallback Alignment (studio-private)
- **Bucket Alignment**: Updated default fallback bucket for `/deliverables/` route prefix in `ROUTE_CONFIG` from `studio-private-deliverables` to `studio-private` to match the Backblaze B2 vault configuration.

## VERSION 0.7.16 (2026-07-26) - Authorize System Platform Domains for Direct Links & PDF Downloads
- **Domain Authorization**: Updated domain verification logic (`isAllowedDomain`) in `getTenantSettings` to permit system platform domains (such as `imageproxy.zorviktech.com`, `*.zorviktech.com`, and requests directly hitting the proxy URL host). This resolves `UNAUTHORIZED_DOMAIN` 403 errors when users download contract PDFs or visit proxy links directly without browser `Origin`/`Referer` headers.

## VERSION 0.7.15 (2026-07-17) - Reduce Watermark Scale to 12%
- **Watermark Scaling**: Reduced standard watermark size scaling from 20% of standard base width (minimum 80px) to 12% of standard base width (minimum 60px) to make standard watermark less obtrusive and more premium in look and feel.

## VERSION 0.7.14 (2026-07-17) - Revert Worker Name in wrangler.toml to image-proxy
- **Worker Naming**: Reverted worker name in `wrangler.toml` back to `image-proxy` to maintain standard repository consistency.

## VERSION 0.7.13 (2026-07-17) - Fix Watermark Positioning to Bottom-Right
- **Watermark Positioning**: Switched standard overlay position parameters to ImageKit's native negative offset format (`lx-N15,ly-N15`). This prevents the watermark from rendering in standard top-left corner (which occurred because ImageKit's parser was overriding `lfo-bottom_right` with standard absolute positive coordinates `lx-15,ly-15`).

## VERSION 0.7.12 (2026-07-17) - Remove Temporary Debug Logger
- **Cleanup**: Removed temporary `logRequestToDb` debug helper and all its call sites added in v0.7.7–0.7.9 for diagnosing the ImageKit origin issue. The issue is fully resolved.
- **Version String**: Updated `/health` endpoint to report `0.7.12`.

## VERSION 0.7.11 (2026-07-17) - Fix ImageKit Double images/ Prefix Bug
- **Root Cause Fixed**: Removed `images/` prefix from `imageKitPath` construction. ImageKit's Web Folder origin is already `https://imageproxy.zorviktech.com/images/`, so appending `images/` again caused a `404` at the CDN.
- **Watermark Path Fixed**: Also stripped `/images/` prefix from the watermark URL pathname before sending as the `i-` layer path.

## VERSION 0.7.10 (2026-07-12) - Rename Worker Back to wedding-image-proxy
- **Worker Name Restoration**: Changed standard worker name back to `wedding-image-proxy` in `wrangler.toml` to restore DNS mapping for standard ImageKit CDN origin.

## VERSION 0.7.9 (2026-07-12) - Log IMAGEKIT_ID environment variable
- **Log Environment Variable**: Added standard env.IMAGEKIT_ID variable to the temporary database logs to verify standard production value.

## VERSION 0.7.8 (2026-07-12) - Move Temporary Logger to Public Schema
- **Public Schema Logging**: Moved the temporary debug logging endpoint to the public schema to ensure successful POST queries. Added standard error logging for diagnostics.

## VERSION 0.7.7 (2026-07-12) - Temporary Debug Logger for ImageKit Requests
- **Incoming Request Logging**: Added temporary database logging of incoming requests to `/images/` paths to troubleshoot CDN routing in production.

## VERSION 0.7.6 (2026-07-12) - Infix Path-Based Bypass & Extension Preservation
- **Infix Path-Based Bypass**: Relocated standard bypass token to standard middle of standard path as standard directory segment (`/bypass/SECRET/filename.ext`). This ensures standard path always ends with standard correct image file extension (e.g., `.png`, `.jpg`), preventing CDNs like ImageKit from returning 404 due to extension parsing failures.
- **Relative Path Watermark Overlay**: Modified ImageKit watermark overlay syntax to reference standard relative path of standard watermark image instead of an absolute external URL, complying with ImageKit's connected origin policy.

## VERSION 0.7.5 (2026-07-12) - Secure Path-Based Bypass & Corrected ImageKit Syntax
- **Path-Based Bypass Security**: Implemented standard secure path-based bypass mechanism for ImageKit (`/bypass/SECRET` suffix). This avoids query parameter stripping issues while remaining completely secure against User-Agent spoofing.
- **Corrected ImageKit Transformations**: Fixed standard watermark transformation properties (`ie-`, `lfo-bottom_right`, `lx-15,ly-15`, and standard mandatory `l-end` closing tag).

## VERSION 0.7.4 (2026-07-12) - URL Encoding & Environment Preservation
- **ImageKit URL Encoding**: URL-encoded the `cleanImageUrl` in all `ik.imagekit.io` fetch requests. This ensures query parameters (such as `bypass` and `watermark`) are passed correctly in the path segment instead of being parsed as ImageKit query parameters, preventing ImageKit `status 400` errors.
- **Environment Variables Preservation**: Configured `keep_vars = true` in `wrangler.toml` to prevent wrangler deployments from resetting or overwriting environment variables configured manually on the Cloudflare dashboard.

## VERSION 0.7.3 (2026-07-12) - Authorize Watermark URL Fetches
- **Watermark Fetch Authorization**: Appended standard `bypass` query token to standard `watermark.url` before encoding it for ImageKit/Cloudinary. This authorizes the subsequent GET requests made by standard image transformation CDNs back to standard image proxy to fetch standard watermark overlay, avoiding `403 Unauthorized` failures.

## VERSION 0.7.2 (2026-07-11) - Fix Tenant Lookup Status Parsing
- **Status Type Parsing**: Cast `clientResp.status` to a number in `getTenantSettings()` to avoid comparison failures against numeric `406`/`404` values due to potential string status wrapping (e.g. from `@sentry/cloudflare` instrumentation).

## VERSION 0.7.1 (2026-07-10) - Production Supabase URL & Public Variables Config
- **Public Environment Variables**: Declared all public variables under the `[vars]` block in `wrangler.toml` (including production `SUPABASE_URL`, `B2_ENDPOINT`, bucket names, and CDNs) to ensure they are automatically deployed and prevent 500 retrieval errors.
- **Local Dev Variables**: Updated local `.dev.vars` file to target the production Supabase project (`ebdqpcankdxjoasvksbx`).

## VERSION 0.7.0 (2026-07-08) - Plan-based Custom Watermark Restrictions
- **Custom Watermark Plan Restrictions**: Ignore settings custom watermark URL if `enable_custom_watermark` is false in the tenant features, serving raw images instead of custom watermarked ones.

## VERSION 0.6.11 (2026-07-05) - Supabase Storage Platform Assets Caching & Bypass
- **Platform Assets Caching**: Added the `/assets/` route prefix to cache Zorvik Tech platform assets from the `zorvik-assets` Supabase Storage bucket.
- **Tenant Validation Bypass**: Configured platform assets to bypass multi-tenant domain and license authorization checks, permitting platform-wide asset retrieval and Edge caching.

## VERSION 0.6.10 (2026-07-04) - AVIF/WebP Image Optimization & Dynamic Resizing
- **AVIF/WebP Auto-Conversion**: Integrated CDN auto-formatting (`f_auto` and `q_auto` compression quality options) to serve files in modern lightweight formats (AVIF/WebP) automatically depending on client browser capabilities.
- **Dynamic Width Resizing**: Added support for the `w` query parameter (e.g. `?w=400`) to let the frontend request size-optimized grid/thumbnail assets, reducing load times.
- **Original Quality Downloads**: Configured retrieval logic to bypass CDNs and serve the original high-resolution, uncompressed R2 file when no width parameter is requested, ensuring original files are preserved.

## VERSION 0.6.9 (2026-07-04) - Watermark CDN Caching & PURGE Cache Purging
- **Dynamic Watermarking Overlays**: Replaced paid Cloudflare dynamic resizing with fetch routing to ImageKit (primary) and Cloudinary (fallback) for free-tier watermark overlay processing, with automatic fallback to raw R2 images to guarantee availability.
- **Bypass Authentication**: Added a `BYPASS_SECRET` verification flow to serve unwatermarked R2 clean assets to CDNs on cache misses.
- **Cache PURGE Route**: Implemented a `PURGE` HTTP method route to invalidate Cloudflare Edge cache entries for both watermarked and clean versions.

## VERSION 0.6.8 (2026-06-14) - R2 System Bucket Separation & Caching
- **Site Assets Separation**: Added support for the `/site/` path prefix routing to a dedicated `SYSTEM_BUCKET` R2 binding (`studio-site-assets`) for system assets (logos, package covers, testimonials).
- **Edge Cache Ingestion**: Configured Worker Cache API (`caches.default`) to cache all public `/images/` and `/site/` GET requests directly at Cloudflare's global edge to reduce B2/R2 usage. Excluded localhost/development environments and private `/deliverables/` vault requests from caching.

## VERSION 0.6.7 (2026-06-07) - Test & Build Stabilization
- **Test Fix**: Mocked execution context (`ctx`) with `waitUntil` and `passThroughOnException` in unit tests to accommodate Sentry's wrapper requirement.
- **Build Hardening**: Updated the `prepare` lifecycle hook in `package.json` to fallback gracefully (`husky || true`) in CI/CD build environments.

## VERSION 0.6.6 (2026-06-07) - Sentry Error Monitoring Integration
- **Sentry Integration**: Added `@sentry/cloudflare` SDK to capture unhandled exceptions, fetch failures, and tenant lookup errors in production.
- **Dynamic Credentials**: Configured Sentry to initialize using the `SENTRY_DSN` Cloudflare Workers secret variable.

## VERSION 0.6.5 (2026-04-06) - Secure Sync (Exact Approach)
- **Hardening**: Automatically deriving `B2_REGION` from `B2_ENDPOINT`.
- **Simplification**: Removed `B2_REGION` from mandatory secrets.
- **Security**: Generic error masking for Vault Configuration errors.

## VERSION 0.6.4 (2026-04-06) - Zero-Fallback Policy
- **Hardening**: Removed all hardcoded default regions (e.g., `eu-central-003`) from the B2 fetcher.
- **Validation**: Added `B2_REGION` to the mandatory secrets check. The system now fails loudly if the region is not explicitly configured.
- **Security**: Prevented silent `SignatureDoesNotMatch` errors caused by incorrect regional defaults.

## VERSION 0.6.1 (2026-04-06) - Observability Stabilization
- **Configuration**: Implemented standardized `[observability]` settings in `wrangler.toml`.
- **Diagnostics**: Enabled persistent logs and trace sampling for improved production troubleshooting.
- **Hygiene**: Cleaned up compatibility flags and verified consistency across environments.

## VERSION 0.6.0 (2026-04-06) - Secure Multi-Cloud Gateway
- **Architecture**: Transformed into a **Secure Tiered Storage Gateway** supporting both Cloudflare R2 (Images) and Backblaze B2 (Video/Deliverables).
- **Multi-Cloud Integration**: Added `aws4fetch` to sign authenticated Backblaze B2 requests (S3-Compatible API).
- **Tiered Routing**: 
    - `/images/` -> Cloudflare R2 (Portfolio)
    - `/reels/` -> Backblaze B2 (Private Reels)
    - `/films/` -> Backblaze B2 (Private Films)
    - `/deliverables/` -> Backblaze B2 (Private Deliverables)
- **Security**: 
    - Enforced **Tenant Folder Isolation** across all storage (`/{tenantId}/...`).
    - Unified the **Identity-First** verification for all tiered paths.
    - All B2 buckets are now treated as **Private** and require sigv4 signing.
- **Bug Fix**: Explicitly added the `'Accept-Profile': 'management'` header to all Supabase REST calls. This resolves the `TENANT_NOT_FOUND` error caused by Supabase defaulting to the `public` schema.
- **Sync**: Verified that all internal tenant lookups correctly target the `management` schema in the database.

## VERSION 0.5.2 (2026-04-06) - Diagnostic Hardening
- **Security**: Hardened `getHostname` logic to ensure consistent matching across dev/prod environments (strips ports/protocols).
- **Diagnostics**:
    - Added `X-Debug-Tenant-ID` and `X-Debug-Resolved-Host` response headers to all 403/406 failures.
    - Added `X-Error-Reason` to explicitly distinguish between `TENANT_NOT_FOUND` and `UNAUTHORIZED_DOMAIN`.
- **Development UX**: Implemented a **Mandatory Cache Bypass** for `localhost` origins. This prevents stale 403 results from being served from the Edge Cache during repeated testing.

## VERSION 0.5.1 (2026-04-05) - Hardened Identity Response
- **Refinement**: Explicitly added `TENANT_NOT_FOUND` state.
- **Cleanup**: Removed temporary `console.log` debug instrumentation in favor of Cloudflare dashboard logs.

## VERSION 0.5.0 (2026-04-05) - Identity-First Tenant Verification
- **Architecture**: Transitioned from "Domain-First" to **"Identity-First"** verification.
    - **Collision Resolution**: Handled the `localhost` collision (where multiple tenants use dev domains) by requiring the `tenantId` in the request path prefix.
    - **Deterministic Lookup**: Supabase queries now target `tc_id` (Primary Key) instead of performing partial domain matches.
- **Performance**: Optimized Edge Caching by using `tenantId` as the unique cache key.

## VERSION 0.4.0 (2026-04-05) - Secure Upload Proxy
- **Architecture**: Implemented **Secure Upload Proxying** (PUT /images/*).
- **Infrastructure**: Upgraded to Wrangler v4 and fixed GitHub Actions deployment pipeline.
