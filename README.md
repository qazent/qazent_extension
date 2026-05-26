# Azure DevOps PR Test Case Generator (QAZent PR Assistant)

This repository ships **two coordinated parts**:

1. **Azure DevOps extension** (React / Fluent UI / webpack) — PR tab, AI context settings hub, and license hub. The extension calls the backend using the user’s **Azure DevOps OAuth token** (`Authorization: Bearer`) and **`X-Ado-Org-Url`**.
2. **Node.js HTTP API** (`src/backend/`, compiled to `dist/backend/`) — validates tokens, fetches PR metadata and diffs, runs **Google Gemini** against `system-prompt.txt`, and creates **Task** work items linked to the PR.

Repository-local conventions for agents and contributors are summarized in **`.rules`**.

## Overview

End-to-end flow in production today is **user-initiated from the PR tab** (“Generate test cases”), not service-hook webhooks:

1. **Authenticate** — Extension obtains an OAuth token via `azure-devops-extension-sdk`; backend verifies it per request.
2. **Fetch changes** — Backend uses `azure-devops-node-api` (Bearer) for PR metadata and diffs (`fetchPRdiff.ts`, `ado-client.ts`).
3. **Generate output** — `ai.ts` builds a token-bounded prompt and calls Gemini; response is JSON with `title` and `htmlDescription` (HTML with structured QA sections per `system-prompt.txt`).
4. **Create work item** — `ado-client.ts` creates a **Task** work item with sanitized HTML and an artifact link back to the PR.
5. **Optional async path** — When Redis (`UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`) is configured, **`POST /api/queue/pr`** enqueues jobs for the separate **worker** process (`npm run start:worker`). This is distinct from the legacy in-memory module in `queue.ts` (see **Architecture** below).

## Key Features

- **Extension + API** — Webpack builds `hub` / `settings` / `license` bundles; `npm run build` also compiles the backend to `dist/backend/`.
- **Rate limiting and audit logging** — Applied to authenticated routes in `server.ts`.
- **Optional Redis-backed queue** — For durable background processing when env vars are set; returns **503** if the queue is required but not configured.
- **Retry logic** — AI generation retries with a shortened system prompt on the second attempt; ADO calls use retries where implemented.
- **Fallback work item** — Legacy in-memory webhook processor can create a minimal Task if AI fails after retries (only relevant if that path is re-enabled).
- **Structured logging** — JSON logs via `src/backend/utils/logger.ts` with sensitive-field discipline.
- **Health check** — `GET /health` for load balancers (no internal queue stats in the payload).
- **Licensing** — Lemon Squeezy + optional Postgres; extension calls `GET /license/status` and `POST /license/activate`.

## Prerequisites

- **Node.js** — `package.json` `engines` specifies **Node 24.x** and **npm ≥ 11**, matching the **`nodeVersion`** variable in **`src/backend/utils/azure-pipelines.yml`**. Use the same major version locally when possible; run **`npm run lint`** and **`npm test`** after upgrades.
- **Azure DevOps** organization where the extension is installed
- **Google Gemini API** key (`GEMINI_API_KEY`) for the backend
- **Hosting** — **[Render](https://render.com)** Web Service (or equivalent) for the API; Redis (Upstash) if you use the worker queue

## Architecture

### Extension (frontend)

- **Webpack entries** — `hub` (PR tab), `settings` (AI context), `license` (`webpack.config.js`).
- **Backend URL** — Must be an absolute `https://` URL (validated in `src/services/backendClient.ts`). Contribution properties in `vss-extension.json` point clients at the API host (e.g. `https://api.qazent.com`).

### Backend (Node)

| Module / area | Role |
|---------------|------|
| `server.ts` | `http` server: CORS, rate limits, auth middleware, routing for generate/create-comment/license/webhook (Lemon) and queue enqueue. |
| `middleware/authenticate.ts` | Validates Azure DevOps OAuth tokens for protected routes. |
| `middleware/rateLimiter.ts` | Per-route rate limiting. |
| `fetchPRdiff.ts` / `ado-client.ts` | PR diffs, metadata, Task creation, PR comments, artifact URIs. |
| `ai.ts` | Gemini client, prompt compression, JSON parse/repair, `system-prompt.txt` loader (`process.cwd()` / `system-prompt.txt` at runtime). |
| `queue/enqueue.ts`, `queue/dequeue.ts`, `worker/worker.ts` | **Redis** job pipeline for **`POST /api/queue/pr`**. |
| `queue.ts` | **In-memory** queue + worker loop intended for the **commented-out** service webhook flow — **not** started by default (`queue.startWorker()` is not called from `startServer()`). Do not confuse with Redis. |
| `license/*` | License status, activation, Lemon webhook signature handling, optional Postgres store. |

### Active data flow (PR tab → API)

```
User in Azure DevOps PR → Extension (hub.js)
        ↓ HTTPS + Bearer token + X-Ado-Org-Url
POST /generate-tests (optional customContext ≤ 3000 chars)
        ↓
fetch PR diff + metadata → Gemini (system-prompt.txt + user prompt)
        ↓
200 JSON: title, htmlDescription, source/target commit IDs, optional compressionReport
        ↓
Extension may POST /create-work-item and /post-pr-comment with same auth
```

### Service webhook path (currently disabled in code)

`POST /webhook`, in-memory `queue.ts` processing, and encrypted token storage are **present only inside large commented blocks** in `server.ts` because OAuth tokens from the extension are short-lived and there is no supported server-side refresh for the old auto-webhook design. The extension still exposes a **fixed** webhook URL constant in `src/services/configService.ts` (`https://api.qazent.com/webhook`) for documentation/subscription UX; **do not assume the live server handles `POST /webhook` until that code path is explicitly re-enabled and deployed with a full token strategy.**

```
(If re-enabled in future) ADO Service Hook → POST /webhook → queue job → …
```

## Local Setup

### 1. Clone and Install

```bash
cd test-extension
npm install
```

### 2. Configure Environment

Create a `.env` file in the project root (there is no committed `.env.example` in this tree—add one locally if you use it). Typical variables include:

```bash
# Azure DevOps Configuration
ADO_ORG_URL=https://dev.azure.com/yourorg
ADO_PAT=your-personal-access-token

# Google Gemini Configuration
GEMINI_API_KEY=your-gemini-api-key

# Server Configuration
PORT=3000

# Optional: Redis queue (Upstash) for POST /api/queue/pr + worker
# UPSTASH_REDIS_URL=...
# UPSTASH_REDIS_TOKEN=...
```

The **PR tab extension** talks to the API with the signed-in user’s **OAuth** token; it does **not** send `ADO_PAT`. Variables like **`ADO_ORG_URL` / `ADO_PAT`** are mainly relevant for **local scripts** (for example `npm run test:local`) or any custom tooling you maintain—not for the default browser extension flow.

#### Getting Azure DevOps PAT

1. Go to `https://dev.azure.com/{org}/_usersSettings/tokens`
2. Click **New Token**
3. Set scopes:
   - **Code**: Read
   - **Work Items**: Read, Write
4. Copy token immediately (shown only once)

#### Getting Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click **Create API key**
3. Select or create a Google Cloud project
4. Copy the API key

#### License configuration (optional)

The extension supports license activation and status via a backend license service and [Lemon Squeezy](https://www.lemonsqueezy.com/) (API + webhooks). Configure the following for license features:

- **Backend (e.g. Render Web Service or same Node server)**  
  Set these environment variables:

  - `LICENSE_HASH_SALT` – Required for activation. A secret string used to hash license keys (never store raw keys).
  - `LEMON_SQUEEZY_WEBHOOK_SECRET` – Required for webhooks. The signing secret you set when creating the webhook in the Lemon Squeezy dashboard.
  - `LEMON_SQUEEZY_API_KEY` – Optional but recommended. API key from **Settings → API** in Lemon Squeezy; sent as `Authorization: Bearer <key>` on license validate/activate calls. Use for server-side authentication and rate-limit protection.
  - `LEMON_SQUEEZY_LICENSE_API_URL` – Optional. Defaults to `https://api.lemonsqueezy.com/v1/licenses`.
  - `DATABASE_URL` – Optional. Postgres connection string (e.g. `postgresql://user:pass@host:5432/dbname`). When set, license and seat data is stored in Postgres; tables are created automatically. When unset, an in-memory store is used (data lost on restart).
  - `LICENSE_DEFAULT_SEATS_PER_KEY` – Optional. Default seat count when a key has no `activation_limit` (default: 5).
  - `LICENSE_EXPIRY_GRACE_DAYS` – Optional. Days after expiry to still consider the license active (default: 0).
  - `LICENSE_ALLOWED_PRODUCT_IDS` – Optional. Comma-separated product/variant IDs that are valid for this extension.

- **Lemon Squeezy**  
  In [Settings → Webhooks](https://app.lemonsqueezy.com/settings/webhooks), add an endpoint URL (e.g. `https://your-api.example.com/webhooks/lemon-squeezy`), set a signing secret (store it in `LEMON_SQUEEZY_WEBHOOK_SECRET`), and subscribe to events such as `order_created`, `order_refunded`, `subscription_created`, `subscription_updated`, `subscription_expired`, `subscription_cancelled`, `subscription_payment_failed`, `license_key_created`, `license_key_updated`.

- **Azure DevOps extension**  
  The License panel is under **Project Settings** → **QAZent - License**. The panel uses the `backendUrl` from the contribution in `vss-extension.json` (e.g. `https://api.qazent.com`) to call `GET /license/status` and `POST /license/activate`. Users must be signed in to Azure DevOps; the backend derives organization and user from the token and `X-Ado-Org-Url` header.

- **License data storage (database)**  
  By default, license and seat data is kept **in memory** only. No database is required; nothing to configure. Restarts (or multiple server instances) clear or duplicate state. For production or multi-instance deployments, use a persistent store:

  - Set **`DATABASE_URL`** to a Postgres connection string (e.g. `postgresql://user:password@host:5432/dbname`). The backend will use it for the license store and create the required tables automatically on first use.
  - If `DATABASE_URL` is not set, the in-memory store is used (fine for single-instance dev; webhooks can repopulate after restarts).
  - **Supabase Postgres:** In the [Supabase Dashboard](https://supabase.com/dashboard) go to **Project Settings → Database**. Use the **Connection string** (URI format). Prefer **Session mode** (port 5432) for this backend; the **Transaction** pooler (port 6543) also works. The backend creates `license_records` and `license_seat_assignments` in the `public` schema automatically.

  Required tables are created automatically: `license_records` and `license_seat_assignments`. No migrations or manual schema setup are required.

### 3. Run the backend (development)

```bash
npm run dev
```

This runs the backend entry via `ts-node` as defined in `package.json`. The **packaged** backend entry used in production is `npm start` → `node dist/backend/server.js` after `npm run build:backend`.

Default listen port is **`3000`** (or `PORT` from the environment).

### 4. Test Locally

Test with mock data (no Azure DevOps required):

```bash
# Set MOCK_MODE=true in .env, then:
npm run test:local
```

This will:
- Load `mock-pr.json`
- Use mock diff data
- Generate test cases with AI
- Skip work item creation
- Display full test case output

## Testing with Real Azure DevOps

### Option 1: Test with Real PR (No Webhook)

1. Set `MOCK_MODE=false` in `.env`
2. Update `mock-pr.json` with real PR details from your Azure DevOps
3. Run `npm run test:local`

This will fetch real diff data and create actual work items.

### Option 2: Test with a service hook (local tunnel)

Only applicable if your server build exposes **`POST /webhook`** (disabled in the default `server.ts` in this repo). If you enable it for experiments:

1. Install ngrok: `npm install -g ngrok`
2. Start your server: `npm run dev`
3. Start tunnel: `ngrok http 3000`
4. Copy the ngrok HTTPS URL
5. Configure a service hook in Azure DevOps (see **Configuring Azure DevOps service hooks** above)
6. Create a test PR

## Configuring Azure DevOps service hooks (optional / product-dependent)

The extension code references a **fixed** webhook URL (`https://api.qazent.com/webhook` via `getWebhookEndpoint()` in `src/services/configService.ts`). The **default `server.ts` in this branch does not register a live `POST /webhook` handler** (that path is commented out together with token storage and `queue.startWorker()`). Before subscribing service hooks in Azure DevOps, confirm with your deployment that the webhook endpoint is actually enabled server-side and secured as intended.

If your team re-enables the handler, the historical subscription steps are:

1. **Project Settings** → **Service Hooks** → **Create subscription**
2. Service: **Web Hooks**; events: **Pull request created** / **Pull request updated**
3. URL: the HTTPS endpoint your API exposes for `POST /webhook` (must match deployment)
4. **Content type**: `application/json`
5. Use **Test** to verify delivery

## Building for production

```bash
npm run build
```

This runs **`build:extension`** (webpack → `dist/` for `hub.js`, `settings.js`, `license.js`, HTML, copied assets) and **`build:backend`** (TypeScript → `dist/backend/` plus `system-prompt.txt` copies). Webpack is configured with **`clean: false`** so it does not delete backend output under `dist/`.

Run the compiled API:

```bash
npm start
```

Runs `node dist/backend/server.js`. Run the Redis worker separately when using the queue: `npm run start:worker`.

## Deploying the API on Render.com

The backend is a plain Node **`http`** server (`npm start` → `node dist/backend/server.js` after `npm run build:backend`). A typical setup on **[Render](https://render.com)**:

### 1. Create a Web Service

1. In the Render dashboard, **New** → **Web Service**, connect your Git repository (or use **Deploy Docker** / manual deploy if you prefer).
2. **Runtime**: Node (use a version consistent with **`package.json` `engines`** and **`src/backend/utils/azure-pipelines.yml`** — e.g. **24.x**).
3. **Build command**: `npm ci && npm run build:backend` (only the API artifact is required on Render; use **`npm run build`** if this service also needs extension bundles from the same repo).
4. **Start command**: `npm start` (or `node dist/backend/server.js`).
5. **Health check path**: `/health` (Render will probe it for deploys and uptime).

Render sets **`PORT`** automatically; the server reads `process.env.PORT` (default `3000` locally).

### 2. Environment variables

In **Environment** for the Web Service, set at least **`GEMINI_API_KEY`**. Add **`UPSTASH_REDIS_URL`** / **`UPSTASH_REDIS_TOKEN`** when using the queue, license/Lemon/Postgres variables per the **License configuration** section, and any other vars your deployment uses. **`ADO_PAT` / `ADO_ORG_URL`** are not required for the standard extension-driven API (each request carries the user’s OAuth token).

Use Render **secret** / **environment group** features for sensitive values; never commit real secrets to the repo.

### 3. Custom domain (optional)

Attach your public API hostname (for example **`https://api.qazent.com`**) in Render and point DNS as their docs describe. Ensure **`vss-extension.json`** (and any hardcoded URLs) reference that same host.

### 4. Verify deployment

```bash
curl https://<your-service>.onrender.com/health
# or your custom domain, e.g. https://api.example.com/health
```

Example response (shape only):

```json
{
  "status": "healthy",
  "uptime": 123,
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

Internal queue depth is **not** exposed on `/health` by design.

### 5. Background worker (optional)

If you use **`POST /api/queue/pr`**, run the consumer as a separate Render **Background Worker** (or second Web Service) with the same repo, **`npm run build:backend`**, start command **`npm run start:worker`**, and the same Redis-related environment variables as the API.

### 6. Service hooks (optional)

Only subscribe Azure DevOps service hooks to a **`POST /webhook`** URL if your **deployed** server build has that route enabled and you have a supported token strategy. Otherwise rely on the **extension + API** flow or the **Redis** queue API (`POST /api/queue/pr`) as designed for your product.

### CI/CD and the extension

#### Azure Pipelines

CI/CD for builds and marketplace publish is defined in **`src/backend/utils/azure-pipelines.yml`**. Point your Azure DevOps pipeline at that file (or copy its stages into your team’s YAML). At a high level it:

- **Triggers** on `main`, `develop`, and `release/*` (with `docs/**` path exclusions); **PR** validation on `main` and `develop`.
- **Validate** — `npm ci`, **`npm run lint`**, Jest with coverage and JUnit publish; enforces an **80%** overall test pass-rate floor.
- **Build** (branches other than `main`) — **`npm run build`** (extension + backend), packages a VSIX with **`tfx`**, publishes the **`output`** folder as a pipeline artifact (`extension-vsix`).
- **PublishExtension** (`main` only) — runs **`scripts/ci-publish.sh`** (bump version, build, package, publish to the Azure DevOps Marketplace) with secrets from variable groups **`pr-assistant-production`** / **`pr-assistant-development`** and **`MARKETPLACE_PAT`**.

Deploying the **Node API** to Render is independent of that pipeline unless you add a deploy stage (for example invoking the Render deploy hook or API from Azure Pipelines).

## Production deployment checklist

Before going live, verify:

- [ ] All required environment variables set on the API (at minimum **`GEMINI_API_KEY`**; Redis vars if using the queue; license vars if selling through Lemon; **`DATABASE_URL`** if you need durable license state)
- [ ] **`GET /health`** returns **200**
- [ ] Extension **backend URL** in `vss-extension.json` matches the deployed API host
- [ ] Gemini API key is valid and within quota
- [ ] If using **`POST /api/queue/pr`**: Redis reachable from API and worker; worker process deployed (`npm run start:worker`)
- [ ] If using service hooks to **`/webhook`**: server code path explicitly enabled in your branch and token strategy documented
- [ ] On Render: appropriate **instance type** / scaling for long-running **`/generate-tests`** requests (free tiers may spin down or limit CPU)
- [ ] Logs or APM (Render log stream, or a third-party tool) for production debugging (optional)

## HTTP API (backend)

Unless noted, endpoints expect **`Content-Type: application/json`**, **`Authorization: Bearer <Azure DevOps OAuth token>`**, and **`X-Ado-Org-Url: <organization base URL>`** (same pattern as `src/services/backendClient.ts`). URLs are normalized (e.g. leading duplicate slashes are collapsed).

| Method | Path | Auth | Summary |
|--------|------|------|---------|
| GET/HEAD | `/` or `/health` | No | Liveness: `status`, `uptime`, `timestamp` only. |
| POST | `/generate-tests` | Yes | Body: `prId`, `projectName`, `repositoryId`, optional `customContext` (≤ **3000** characters). Returns AI `title` / `htmlDescription` and commit IDs. |
| POST | `/create-work-item` | Yes | Creates a **Task** from the generated `testCase` plus PR linkage fields (`projectId`, `sourceCommitId`, `targetCommitId`, …). |
| POST | `/post-pr-comment` | Yes | Posts a PR thread; `workItemId` optional when `commentContent` supplies full text. |
| POST | `/api/extract-purpose-scope` | Yes | Body: `{ "html": string }` → extracted Purpose/Scope snippet. |
| POST | `/api/queue/pr` | Yes (+ license when enforcement on) | Enqueues Redis job; **503** if Redis env is missing. |
| GET | `/license/status` | Yes | License state for the authenticated org/user. |
| POST | `/license/activate` | Yes | Body includes `licenseKey` (see `src/license/api.ts` / `license/routes.ts`). |
| POST | `/webhooks/lemon-squeezy` | No (signature verified in handler) | Lemon Squeezy billing webhook; rate limited. |

**Commented / inactive in source:** `POST /webhook`, `POST /api/webhook-token`, and automatic startup of the in-memory worker in `queue.ts` — see comments in `src/backend/server.ts`.

### POST /webhook (disabled in default build)

Historical Azure DevOps service hook payload shape and **202** `{ status, jobId }` responses are described in commented code in `server.ts`. Treat this as **documentation of intent**, not a guarantee the route exists in your deployed binary.

## Monitoring

### Logs

Use the **Logs** tab on your Render Web Service (and Worker, if any) for live tail and history. You can also wire log drains or external APM if your team uses them.

### Key metrics to monitor

- Authenticated API requests (`/generate-tests`, `/create-work-item`, `/post-pr-comment`, `/api/queue/pr`, license routes) — status, duration, user/org from audit logs
- AI generation latency and error rate (parse vs truncation vs API failures)
- Work item and PR comment creation failures
- Redis queue depth / worker errors (when the worker is deployed)
- Lemon webhook delivery and signature failures

## Troubleshooting

### "Failed to connect to Azure DevOps"

- From the **extension**, confirm the user is signed in and **`X-Ado-Org-Url`** matches the organization base URL
- For **script-based** runs using a PAT, verify `ADO_ORG_URL` and that the PAT is valid, not expired, and has **Code (Read)** and **Work Items (Read & write)** where needed

### "Gemini API error"

- Verify `GEMINI_API_KEY` is correct
- Check API quota hasn't been exceeded
- Ensure project has Gemini API enabled

### "Work item creation failed"

- Confirm the extension user has permission to create work items in the project
- Verify the project name and IDs in the payload match the PR’s project
- The API creates work items of type **Task** (not a custom “Test Case” WI type)

### "Webhook not received" or `POST /webhook` 404

- Confirm whether your deployed server actually exposes **`POST /webhook`** (it is **not** active in the default `server.ts` in this repository)
- If you rely on the **Redis** path, use **`POST /api/queue/pr`** from an authenticated client instead
- For local experiments only (when/if the route exists): `curl -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d @tests/mock-pr.json`

### "TypeScript errors"

Run type checking:

```bash
npm run lint
```

## Development

### Code structure

- **`src/`** — Extension UI (`hub/`, `settings/`, `license/`), `services/` (backend client, config), `types/extension-types.ts`
- **`src/backend/`** — API server, AI, ADO client, Redis queue modules, worker, license subsystem, middleware
- **`src/backend/types.ts`** — Backend job/PR/AI types (not identical to extension types)
- **`system-prompt.txt`** — QA instructions for Gemini (must stay consistent with optional short-prompt headings in `src/backend/ai.ts` if you rename sections)

### Adding New Features

1. Define new types in `types.ts`
2. Implement functionality in appropriate module
3. Update logging as needed
4. Test locally with `npm run test:local`
5. Update README with new features

### Modifying the system prompt

Edit **`system-prompt.txt`**. It is read from **`process.cwd()/system-prompt.txt`** at runtime (copied next to compiled output during `npm run build:backend`). The file is cached after first load. If you change the text of optional sections at the top of the prompt, update **`OPTIONAL_SHORT_PROMPT_HEADINGS`** in **`src/backend/ai.ts`** so the second-attempt “short prompt” still strips the right blocks.

### Changing the Gemini model

Model name and generation options live in **`src/backend/ai.ts`** (e.g. `GEMINI_MODEL_NAME` from `diff-config.ts`) and use the **`@google/genai`** SDK — adjust there and run tests around prompt size and output truncation.

## Security Considerations

### Secrets Management

- Never commit `.env` file
- Store production secrets in Render **environment** / **secret** configuration (or your org’s vault), not in source control
- Rotate PAT tokens regularly (for local or script-based testing only, if you use PATs)
- Monitor API key usage

### Input validation

- JSON bodies validated per handler in `server.ts`
- AI HTML sanitized (`sanitize-html`) before persistence in ADO (`ado-client.ts`, `ai.ts`)
- Lemon Squeezy requests verified with the configured signing secret in the license webhook handler

### Network security

- HTTPS is provided by Render for `*.onrender.com` and for custom domains you configure there
- CORS allowlists ADO / Visual Studio / gallery origins (see `applyCorsHeaders` in `server.ts`); development may allow localhost/ngrok when `NODE_ENV=development`
- Azure DevOps service hooks do not provide the same signing model as Lemon; treat webhook URLs as sensitive capabilities if enabled

## Performance

### Expected performance

- **`/generate-tests`** is synchronous end-to-end (diff + AI); typical latency depends on PR size and Gemini (often on the order of tens of seconds for large diffs)
- **`POST /api/queue/pr`** returns **202** quickly when Redis is configured; the separate worker process performs heavy work

### Scaling considerations

- Run **multiple worker** instances only after reviewing Redis locking/idempotency in `src/backend/worker/` and queue helpers
- Without Redis, do not rely on `queue.ts` for multi-instance scale-out (in-memory only)

## Support

For issues or questions:

1. Check troubleshooting section above
2. Review logs for error details
3. Verify environment configuration
4. Test with mock data locally

## License

MIT