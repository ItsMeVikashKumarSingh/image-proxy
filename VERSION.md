# image-proxy — Version History

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
