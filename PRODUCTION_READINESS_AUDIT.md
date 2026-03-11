# Production Readiness & Multi-User Safety Audit

**Repository:** Azure DevOps PR Test Case Generator (test-extension)  
**Audit date:** 2025-03-11  
**Scope:** Full codebase (backend, frontend, config, CI/CD, env).

---

## 1. Architecture Overview

### System architecture (as implemented)

- **Backend:** Single Node.js HTTP server (`src/backend/server.ts`), no framework. Listens on `PORT` (default 3000), bind address `0.0.0.0`.
- **Endpoints:**
  - **Public:** `GET /health`, `GET /` — rate-limited only; no auth.
  - **Protected (auth + rate limit):** `POST /generate-tests`, `POST /create-work-item`, `POST /post-pr-comment`, `POST /api/extract-purpose-scope`. All require `Authorization: Bearer <token>` and `X-Ado-Org-Url`.
- **Frontend:** Azure DevOps extension (React + Fluent UI). Runs in Azure DevOps; obtains token via `SDK.getAccessToken()` and sends it with every backend request. Backend URL comes from contribution `properties.backendUrl` (default `https://api.qazent.com`).
- **Webhook flow:** Disabled. Commented-out code for `/webhook` and in-memory token store; only the button-driven flow (Generate Tests → backend) is active.
- **Queue/worker:** `queue.ts` and worker exist but are not started (`queue.startWorker()` commented out in `server.ts`). No background job processing in production path.
- **AI:** Google Gemini (`@google/genai`). System prompt loaded once at startup from `system-prompt.txt` via `process.cwd()`; single global cache (`systemPrompt`, `genAI` in `ai.ts`).
- **ADO:** Azure DevOps API used per-request via token from the request; no global ADO connection.

### Implicit assumptions and coupling

- **CWD and deployment:** `ai.ts` loads `system-prompt.txt` with `path.join(process.cwd(), 'system-prompt.txt')`. Assumption: at runtime, CWD is the app root and that file exists there. **This is violated by the current CI artifact** (see §2 and §4).
- **Token shape:** Backend and `tokenValidator` assume OAuth JWT (length ≥ 500, ≥ 2 dots). PATs are rejected by format. Frontend always uses SDK token.
- **Single process:** Rate limiter and token validation use in-memory stores. No Redis or shared store; multi-instance deployment means limits and cache are per-instance.
- **Extension context:** Frontend assumes contribution context and `pullRequest` in `SDK.getConfiguration()`; fails with a clear error if not on a PR page.
- **Backend URL:** Hardcoded in `configService.ts` (`WEBHOOK_ENDPOINT`), `vss-extension.json` (`backendUrl`), and `PRAssistantHub.tsx` default; no single source of truth for “production backend URL”.

### Missing boundaries

- No API versioning or path prefix (e.g. `/api/v1/`).
- Health does not check downstreams (Gemini, ADO); it only reports process uptime and timestamp.
- No explicit boundary between “extension backend” and future webhook/worker; shared modules (e.g. `ado-client`, `ai`) are fine, but deployment and config are tailored to the current flow only.

---

## 2. Production-Readiness Assessment

### Reliability

| Area | Finding | Location |
|------|---------|----------|
| **Error handling** | Handlers use try/catch and return 4xx/5xx with JSON body. Async handler errors are logged and converted to 500. | `server.ts` (e.g. 424–434, 508–521) |
| **Fail-fast** | `validateEnvironment()` exits process if `GEMINI_API_KEY` is missing. `loadSystemPrompt()` exits on read failure. | `server.ts` 212–226, 698–706; `ai.ts` 75–91 |
| **Retry** | AI: 2 attempts with shortened prompt on retry. Queue (when used): 3 attempts with backoff. ADO diff fetch in queue uses `fetchWithRetry`. No retry on protected API handlers. | `ai.ts` 393–494; `queue.ts` 60–90, 118–132 |
| **Timeout** | Token validation: 10s (`req.setTimeout(10000)`). No server-side timeout on `/generate-tests` or other long-running handlers; client uses 300s/180s. | `tokenValidator.ts` 152–156; `backendClient.ts` 217, 249, 293 |
| **Body parsing** | No size limit. Large POST body is accumulated in memory and then `JSON.parse(body)`; risk of DoS or OOM. | `server.ts` (all POST handlers: body += chunk) |

**Verdict:** Generally solid error handling and fail-fast; missing request body limit and no server-side request timeouts for long operations.

### Security

| Area | Finding | Location |
|------|---------|----------|
| **Auth flow** | Protected routes go through `createAuthMiddleware`: Bearer token + `X-Ado-Org-Url` required; token validated via ADO `connectionData`; user/org attached to request. | `authenticate.ts`; `server.ts` 686–696 |
| **Token handling** | Token from header only; no token in URL or logs. Validator caches by SHA-256 of token; raw token not stored. Optional PAT only in .env for dev. | `tokenValidator.ts` 37, 47–49, 188–203; `.env.example` |
| **Secrets** | `GEMINI_API_KEY` from env. README and .env.example recommend Key Vault for production; not enforced in code. | `ai.ts` 117–121; `.env.example` 8, 66–68 |
| **Permissions** | Extension scopes: `vso.code`, `vso.work_write`, etc. Backend does not check fine-grained permissions; relies on ADO validating the same token. | `vss-extension.json` 95–101 |
| **Data validation** | Payloads validated (prId, projectName, repositoryId, etc.). `customContext` length capped at 3000 in generate-tests. `/api/extract-purpose-scope` accepts any string `html` with no length limit. | `server.ts` 428–441, 912–922 |
| **CORS** | Origin allow-list (dev.azure.com, *.azurewebsites.net, etc.); dev adds localhost/ngrok. Blocked origin gets fallback `Access-Control-Allow-Origin: https://dev.azure.com`. | `server.ts` 579–641 |

**Verdict:** Auth and token handling are sound; secrets in env and lack of body/html size limits are the main gaps.

### Scalability

| Area | Finding | Location |
|------|---------|----------|
| **Statelessness** | Request handlers do not rely on server-local state; token and org come from each request. | `server.ts` |
| **Concurrency** | Node single-threaded; no shared mutable request state. Token cache and rate-limit store are in-memory Maps; concurrent access is safe for current usage. | `rateLimiter.ts` 34; `tokenValidator.ts` 37 |
| **Shared resources** | `ai.ts`: single `systemPrompt` and `genAI` instance (read-only after init; safe). Queue not started. No DB or external shared store. | `ai.ts` 67–68 |
| **Bottlenecks** | One worker would process one job at a time (queue disabled). Per-request: sequential ADO + Gemini calls in generate-tests; no horizontal scaling of “AI” other than more instances. | `queue.ts` 256–268; `server.ts` 466–467 |

**Verdict:** Stateless and safe for concurrent requests; rate limit and token cache are per-instance, so multiple instances weaken rate limiting and duplicate cache.

### Performance

| Area | Finding | Location |
|------|---------|----------|
| **Heavy work** | Generate-tests: fetch PR diff (many file fetches), then Gemini call. Diff limited to 28 files, 2000 chars/file; prompt compressed. | `fetchPRdiff.ts` 189; `ado-client.ts` 89; `ai.ts` 156–248 |
| **Blocking** | `loadSystemPrompt()` uses `fs.readFileSync` at startup (one-time). No other sync file I/O in request path. | `ai.ts` 81 |
| **I/O** | PR diff: multiple REST calls per file (add/edit: 2, delete: 1). Could be parallelized more per file but already uses `Promise.all` for old/new in edit case. | `fetchPRdiff.ts` 323–339 |
| **N+1** | File content fetched in a loop sequentially (one after another). Could batch or parallelize with a cap. | `fetchPRdiff.ts` 189–364 |

**Verdict:** Acceptable for moderate load; main cost is diff + Gemini. No N+1 in the sense of per-request DB loops; file fetches are the main sequential cost.

### Observability

| Area | Finding | Location |
|------|---------|----------|
| **Logging** | Structured JSON logger; levels info/warn/error/debug (debug gated by `DEBUG=true`). Context sanitized (length caps, redaction of window/document/vss). | `logger.ts` |
| **Metrics** | None. No Prometheus/StatsD/App Insights instrumentation. Health is only uptime + timestamp. | `server.ts` 411–424 |
| **Tracing** | `requestId` generated in auth middleware and logged in handlers. No distributed trace ID or OpenTelemetry. | `authenticate.ts` 43–45; `server.ts` 664–668 |
| **Errors** | Errors logged with context; JSON error body with message/code. No dedicated error taxonomy or alerting hooks. | Handlers and `authenticate.ts` |

**Verdict:** Logging is good for debugging; no metrics or tracing for production monitoring.

### Configuration

| Area | Finding | Location |
|------|---------|----------|
| **Env separation** | `NODE_ENV`, `PORT`, `GEMINI_API_KEY`, `DEBUG`, `NGROK_URL` (dev). No separate config files per environment. | `.env.example`; `server.ts` 39 |
| **Secrets** | From env only. README recommends Key Vault; no code path for Key Vault. | `.env.example`; `ai.ts` 117 |
| **Build** | Backend: `tsc -p tsconfig.backend.json` → `dist/backend`; `build:backend` also `cp system-prompt.txt dist/` (not into `dist/backend`). | `package.json` 14–15; `tsconfig.backend.json` 4 |

**Verdict:** Env-based config is clear; deployment artifact is wrong (see §4).

### Dependency health

| Area | Finding | Location |
|------|---------|----------|
| **Audit** | `npm audit`: 12 vulnerabilities (e.g. braces, minimatch, rollup, serialize-javascript, underscore). Mostly dev/build (cpx, jest, webpack). | Run `npm audit` |
| **node-fetch** | `fetchPRdiff.ts` uses `import fetch from "node-fetch"`. Not in `package.json` dependencies; appears as transitive. Node 18+ has global `fetch`; dependency could be removed and use global. | `fetchPRdiff.ts` 1; `package.json` |
| **Engines** | `package.json` has `"node": "24.x"`. CI uses `node-version: '20.x'`. Mismatch can cause local vs CI differences. | `package.json` 6–8; `.github/workflows/main_qazent.yml` 21 |

**Verdict:** Non-blocking but should be cleaned: fix or align node version, resolve or replace node-fetch, run audit fix where safe.

---

## 3. Multi-User Safety

### Shared state and global stores

- **Rate limit store:** `requestStore` in `rateLimiter.ts` (Map by `ip:endpoint`). Shared across all users; key is IP, so one IP can affect all users behind same NAT. No user ID in key. Safe for concurrency (single-threaded Node).
- **Token validation cache:** `tokenCache` in `tokenValidator.ts` (key = SHA-256 of token). Per-token; different users have different tokens. Safe for concurrency. TTL 50 minutes; cleanup every 10 minutes.
- **AI module:** `systemPrompt` and `genAI` are read-only after init. No per-request mutable state.
- **Queue/worker:** Not running; no shared queue state in use.

**Conclusion:** No user-to-user data leakage. Rate limit is per-IP, not per-user; acceptable for “one IP = one actor” but not for per-user quotas.

### Thread safety and request isolation

- Single-threaded event loop; no shared mutable request state. Each request gets its own `AuthenticatedRequest` with `user`, `orgUrl`, `requestId`. Token is taken from the request and used only for that request’s ADO/Gemini calls.
- **Async patterns:** Handlers use `req.on('data')` / `req.on('end')` and async handlers; no unhandled promise rejections in the flow. Rate limiter’s `next()` is invoked synchronously; the passed `next` runs async (auth + handler); that’s correct and does not double-end the response.

### Authentication and authorization at scale

- Each request is authenticated independently; token is validated (with cache) and user/org attached. No server-side session; no cross-request identity mix-up.
- Backend does not enforce per-user or per-org rate limits; only per-IP. So one user cannot exhaust another user’s quota, but one IP can affect all users behind it.

**Conclusion:** Multi-user safe from isolation and auth perspective; rate limiting is the only coarse part.

---

## 4. Missing Pieces

### Critical (blocks or severely risks production)

1. **Deployment artifact omits `system-prompt.txt`**  
   - **Where:** `.github/workflows/main_qazent.yml` uploads `path: dist/backend`. `build:backend` copies `system-prompt.txt` to `dist/`, not `dist/backend`. So the deployed app root contains only the contents of `dist/backend` (e.g. `server.js`), and `system-prompt.txt` is not there.  
   - **Effect:** At startup, `loadSystemPrompt()` runs `path.join(process.cwd(), 'system-prompt.txt')` and fails → process exits.  
   - **Fix:** Either (a) copy `system-prompt.txt` into `dist/backend` in the build and keep uploading `dist/backend`, or (b) upload a deployment root that includes both `dist/backend` and `system-prompt.txt` (e.g. build a `deploy/` that contains `dist/backend/*` and `system-prompt.txt` at root) and set start command so CWD is that root.

2. **No request body size limit**  
   - **Where:** All POST handlers in `server.ts` accumulate `body` with `req.on('data', chunk => body += chunk.toString())` and then `JSON.parse(body)` with no size check.  
   - **Effect:** Very large bodies can cause high memory use or DoS.  
   - **Fix:** Enforce a max body size (e.g. 1–2 MB) before parsing; respond 413 if exceeded.

### Medium (instability or risk under load)

3. **Rate limit and token cache are in-memory and per-instance**  
   - **Where:** `rateLimiter.ts` and `tokenValidator.ts`.  
   - **Effect:** Multiple instances each have their own limits and cache; limits are effectively multiplied, cache is duplicated. Under load balancer, one IP can send more requests than intended.  
   - **Fix:** For multi-instance, use a shared store (e.g. Redis) for rate limits and optionally for token cache; or accept single-instance and document it.

4. **No server-side timeout for long-running handlers**  
   - **Where:** `/generate-tests` and other POST handlers.  
   - **Effect:** A stuck Gemini or ADO call can hold the request indefinitely; client may timeout but server keeps resources.  
   - **Fix:** Wrap handler work in a timeout (e.g. `Promise.race` with a 5-minute timeout) and respond 504 on timeout.

5. **`/api/extract-purpose-scope` accepts unbounded `html`**  
   - **Where:** `server.ts` 912–922: `payload.html` is only checked for type string, not length.  
   - **Effect:** Large HTML can cause high memory or CPU (e.g. in `extractPurposeAndScope` string scanning).  
   - **Fix:** Reject body or `html` field over a reasonable limit (e.g. 500 KB) with 400.

6. **CI Node version vs package.json engines**  
   - **Where:** Workflow uses `node-version: '20.x'`, package.json has `"node": "24.x"`.  
   - **Effect:** Build and run in CI may differ from local; potential runtime differences.  
   - **Fix:** Align CI to 24.x or change engines to 20.x and document.

### Low (maintainability and hygiene)

7. **Hardcoded backend URL in multiple places**  
   - **Where:** `configService.ts` (`WEBHOOK_ENDPOINT`), `vss-extension.json` (contributions `backendUrl`), `PRAssistantHub.tsx` default.  
   - **Fix:** Single constant or build-time config; extension reads from contribution only.

8. **Logger timezone/locale**  
   - **Where:** `logger.ts` uses `'sv-SE'` and `'Europe/Stockholm'`.  
   - **Fix:** Use UTC or make locale configurable for consistency in distributed logs.

9. **Token access in handlers**  
   - **Where:** Handlers use `req.headers['authorization']!.split(' ')[1]` after auth.  
   - **Fix:** Optional: attach `token` (or a redacted ref) on the request in auth middleware and read from `req` to avoid repeated parsing and non-null assertion.

10. **`node-fetch` dependency**  
    - **Where:** `fetchPRdiff.ts` imports `node-fetch`; not in package.json (transitive).  
    - **Fix:** Use global `fetch` (Node 18+) and remove the import, or add `node-fetch` explicitly and document.

11. **npm audit**  
    - **Where:** 12 vulnerabilities in dev/build deps.  
    - **Fix:** Run `npm audit fix` (and `npm audit fix --force` only where acceptable); update or replace vulnerable dev deps (e.g. cpx).

---

## 5. Concrete Recommendations

### P0 (must fix before production)

**P0-1. Include `system-prompt.txt` in the deployed artifact**

- **Option A (minimal):** In `package.json`, change `build:backend` so the prompt is copied into the output dir used by the server:

```json
"build:backend": "tsc -p tsconfig.backend.json && cp system-prompt.txt dist/backend/ && if [ -d public ]; then cp -r public dist/backend/; fi"
```

- Then ensure the workflow still uploads `dist/backend` and that the Azure Web App start command runs with CWD = app root (so `process.cwd()` is the folder that contains `server.js` and `system-prompt.txt`). If the deploy action sets the root to the contents of `dist/backend`, this is enough.

- **Option B:** If the deploy root is the repo root, then load the prompt by path relative to the server file instead of CWD:

```ts
// ai.ts - more robust for any CWD
const promptPath = path.join(path.dirname(require.resolve('../server.js')), 'system-prompt.txt');
// or, if server is at dist/backend/server.js, path.join(__dirname, '..', 'system-prompt.txt') when prompt lives in dist/
```

- Prefer Option A so the artifact is self-contained under `dist/backend`.

**P0-2. Add request body size limit**

- In `server.ts`, before or when handling POST, enforce a max size. Example helper:

```ts
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

function readBodyWithLimit(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

- In each POST handler: use `readBodyWithLimit(req)` instead of manual `req.on('data'/'end')`. On reject (e.g. "Payload too large"), respond with 413 and JSON error.

### P1 (should fix soon)

- **P1-1.** Add a server-side timeout (e.g. 300s) around the entire handler logic for `/generate-tests` (and optionally other long handlers); on timeout return 504.
- **P1-2.** Enforce a max length for `payload.html` in `/api/extract-purpose-scope` (e.g. 512 KB); return 400 if exceeded.
- **P1-3.** Align CI Node version with `package.json` engines (e.g. 24.x in workflow or 20.x in engines) and document.
- **P1-4.** Resolve `node-fetch`: use global `fetch` in Node 18+ and remove the import in `fetchPRdiff.ts`, or add `node-fetch` to dependencies.

### P2 (improvements)

- **P2-1.** Add a simple health check that verifies `system-prompt.txt` is loadable (or that `loadSystemPrompt()` has already run) and optionally a quick Gemini connectivity check; keep health lightweight.
- **P2-2.** Consider Redis (or similar) for rate limit and token cache if you run multiple instances.
- **P2-3.** Run `npm audit fix` and update or replace vulnerable dev dependencies.
- **P2-4.** Centralize backend URL (and webhook URL) in one place for the extension and config.

---

## 6. Final Verdict

**Verdict: Not ready for production**

**Reasons:**

1. **Deployment is broken:** The CI artifact does not include `system-prompt.txt`, so the server exits on startup in the current Azure deployment. This is a showstopper.

2. **Request body is unbounded:** Large POST bodies can cause memory exhaustion or DoS. This must be capped before production traffic.

3. **No server-side timeouts:** Long-running Gemini/ADO calls can hold connections indefinitely; there is no fail-safe for hung requests.

4. **Multi-instance behavior undefined:** Rate limit and token cache are in-memory and per-instance. With multiple instances, limits are weaker and not clearly documented or designed for.

5. **Observability gap:** No metrics or tracing; health does not verify dependencies (Gemini, prompt file). Operational visibility is limited.

**After P0 fixes (artifact + body limit):** The app can be **ready with conditions**: single instance, monitored for errors and latency, and with the understanding that long requests have no server-side timeout until P1-1 is done. Document that multi-instance deployment is not supported until rate limit (and optionally token cache) use a shared store.

---

*Audit based solely on the current codebase; no assumptions beyond what is present in the repository.*
