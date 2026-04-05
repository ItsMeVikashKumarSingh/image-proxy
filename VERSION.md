# image-proxy — Version History

## VERSION 0.5.0 (2026-04-05) - Identity-First Tenant Verification
- **Architecture**: Transitioned from "Domain-First" to **"Identity-First"** verification.
    - **Collision Resolution**: Handled the `localhost` collision (where multiple tenants use dev domains) by requiring the `tenantId` in the request path prefix.
    - **Deterministic Lookup**: Supabase queries now target `tc_id` (Primary Key) instead of performing partial domain matches.
    - **Strict Verification**: After resolving the tenant, the Worker verifies the request `Origin` against the tenant's exact authorized domain list.
- **Performance**: Optimized Edge Caching by using `tenantId` as the unique cache key.

## VERSION 0.4.0 (2026-04-05) - Secure Upload Proxy & CI/CD Fix
- **Architecture**: Implemented **Secure Upload Proxying** (PUT /images/*).
    - **CORS Resolution**: Eliminated the need for public R2 bucket CORS policies by proxying writes through the Worker's native R2 binding.
- **Infrastructure**:
    - **Wrangler v4**: Upgraded dev environment and CI/CD to latest Cloudflare standards.
    - **GitHub Actions**: Fixed the broken pipeline by adding the `deploy` job for automatic production updates.

## VERSION 0.3.0 (2026-04-05) - Native R2 Binding Migration
- **Major Architecture**: Switched from `fetch`-based public URL retrieval to **Native R2 Bindings** (`env.BUCKET.get`).
- **Security**: Removed `BUCKET_ACCESS_TOKEN` in favor of secure internal Cloudflare bindings.

## VERSION 0.2.0 (2026-04-03) - Direct Database Verification
- **Feature**: Replaced external API call to Zorvik-Tech with a direct **Supabase REST API** query at the Edge.
- **Performance**: Integrated Cloudflare Cache API for tenant settings.

## VERSION 0.1.0 (2026-04-02) - Initial Infrastructure
- **CI/CD**: Added GitHub Actions workflow.
- **Testing**: Implemented Vitest unit test suite.
- **Linting**: Added ESLint 9 Flat Config.
