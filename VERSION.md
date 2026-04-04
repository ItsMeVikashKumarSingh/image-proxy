# image-proxy — Version History

# image-proxy — Version History

## VERSION 0.2.0 (2026-04-03)

### Major Architecture: Direct Database Verification

- **Feature**: Replaced external API call to Zorvik-Tech with a direct **Supabase REST API** query at the Edge.
- **Performance**: Integrated **Cloudflare Cache API** to cache tenant settings for 5 minutes, reducing database hits and latency.
- **Improved**: Ported domain normalization and deep feature merging logic directly into the worker for maximum accuracy.
- **Security**: Switched to `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets.

## VERSION 0.1.3 (2026-04-02)

### Root Experience Improvement

- **Feature**: Added a friendly welcome message to the root path (`/`) to identify the service and provide a link to documentation, replacing the previous 404 response.
- **Testing**: Updated unit tests to verify the new root route and its CORS compliance.

## VERSION 0.1.2 (2026-04-02)

### Documentation & Setup Refinement

- **Documentation**: Added `.env.example` file as a standard reference for required environment variables (`BUCKET_ACCESS_TOKEN`, `LICENSE_API_BASE`).

## VERSION 0.1.0 (2026-04-02)

### Complete Project Infrastructure — CI/CD, Testing, Linting, Governance

- **CI/CD**: Added GitHub Actions workflow (`ci.yml`) with 3-stage pipeline: Lint → Test → Build dry-run.
- **Testing**: Implemented full Vitest unit test suite (`test/index.test.js`) — 12 tests across 8 suites covering all request paths, license auth, watermark logic, CORS, error safety, and auth header forwarding.
- **Linting**: Added ESLint 9 Flat Config (`eslint.config.js`) with separate rule sets for `src/` (Cloudflare Workers runtime) and `test/` (Node.js/Vitest). Zero warning policy enforced.
- **Pre-commit Hooks**: Added Husky v9 (`pre-commit`) + lint-staged integration. All staged `.js` files are auto-linted before commit. Bypass (`--no-verify`) is prohibited.
- **CodeRabbit**: Added `.coderabbit.yaml` with per-path review instructions for `src/`, `test/`, `wrangler.toml`, and `.github/workflows/`.
- **Secrets Template**: Added `.dev.vars.example` for safe local development secret setup.
- **Updated `.gitignore`**: Added `coverage/` and `dist/` to gitignore.
- **Updated `package.json`**: Added `lint`, `lint:fix`, `test`, `test:watch`, `build` (dry-run), and `prepare` (husky) scripts. Added all governance devDependencies.
- **Updated `README.md`**: Full production-grade documentation with architecture diagram, API reference, test coverage table, CI/CD guide, local dev setup, and GitHub repo description.

## VERSION 0.0.1 (2026-04-02)

### Initial Release

- **Architecture**: Standalone Cloudflare Worker extracted from WEDDING repo `workers/` folder.
- **Feature**: Validates tenant domain via Zorvik license API before serving any image.
- **Feature**: Applies dynamic watermarks via Cloudflare Image Resizing when tenant feature is enabled.
- **Security**: All secrets (`BUCKET_ACCESS_TOKEN`, `LICENSE_API_BASE`) stored as Cloudflare Worker Secrets — never in code or config files.
- **Improvement**: Added CORS headers for cross-origin requests from WEDDING frontend.
- **Improvement**: Added `/health` endpoint for uptime monitoring.
- **Improvement**: Improved error handling — safe 500 response with console logging; internals never exposed.
