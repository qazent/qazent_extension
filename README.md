# Azure DevOps PR Test Case Generator

Automated service that receives Azure DevOps Pull Request webhook events, analyzes PR changes using AI, and generates comprehensive Test Case work items automatically.

## Overview

This backend service integrates with Azure DevOps to automate QA workflows:

1. **Receives PR webhooks** - Listens for Pull Request Created/Updated events
2. **Fetches code changes** - Retrieves PR metadata and code diffs via Azure DevOps API
3. **Generates test cases** - Uses Google Gemini AI to create structured test cases
4. **Creates work items** - Automatically creates Test Case work items in Azure DevOps
5. **Links to PRs** - Links test cases back to originating pull requests

## Key Features

- **Asynchronous processing** - Immediate 202 response, background job processing
- **Retry logic** - 3 attempts with exponential backoff for transient failures
- **Fallback handling** - Creates minimal work item if AI generation fails
- **Structured logging** - JSON logs with sensitive data filtering
- **Health monitoring** - Health check endpoint for Azure App Service
- **Local testing** - Test with mock data without webhook setup

## Prerequisites

- **Node.js 18+** installed
- **Azure DevOps** organization with appropriate permissions
- **Google Gemini API** access
- **Azure App Service** instance (for production deployment)

## Architecture

### Components

- **server.ts** - HTTP webhook server with `/webhook` and `/health` endpoints
- **queue.ts** - In-memory job queue with retry logic
- **ado-client.ts** - Azure DevOps API wrapper for fetching diffs and creating work items
- **ai.ts** - Google Gemini integration for test case generation
- **logger.ts** - Structured JSON logging with sensitive data filtering
- **types.ts** - TypeScript type definitions

### Data Flow

```
Azure DevOps PR Event
        ↓
POST /webhook (202 Accepted)
        ↓
Job Queue (background)
        ↓
Fetch PR Diff → Generate Test Cases → Create Work Item
        ↓
Link to PR & Log Result
```

## Local Setup

### 1. Clone and Install

```bash
cd test-extension
npm install
```

n### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```bash
# Azure DevOps Configuration
ADO_ORG_URL=https://dev.azure.com/yourorg
ADO_PAT=your-personal-access-token

# Google Gemini Configuration
GEMINI_API_KEY=your-gemini-api-key

# Server Configuration
PORT=3000
```

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
  - `LICENSE_DEFAULT_SEATS_PER_KEY` – Optional. Default seat count when a key has no `activation_limit` (default: 5).
  - `LICENSE_EXPIRY_GRACE_DAYS` – Optional. Days after expiry to still consider the license active (default: 0).
  - `LICENSE_ALLOWED_PRODUCT_IDS` – Optional. Comma-separated product/variant IDs that are valid for this extension.

- **Lemon Squeezy**  
  In [Settings → Webhooks](https://app.lemonsqueezy.com/settings/webhooks), add an endpoint URL (e.g. `https://your-api.example.com/webhooks/lemon-squeezy`), set a signing secret (store it in `LEMON_SQUEEZY_WEBHOOK_SECRET`), and subscribe to events such as `order_created`, `order_refunded`, `subscription_created`, `subscription_updated`, `subscription_expired`, `subscription_cancelled`, `subscription_payment_failed`, `license_key_created`, `license_key_updated`.

- **Azure DevOps extension**  
  The License panel is under **Project Settings** → **QAZent - License**. The panel uses the `backendUrl` from the contribution in `vss-extension.json` (e.g. `https://api.qazent.com`) to call `GET /license/status` and `POST /license/activate`. Users must be signed in to Azure DevOps; the backend derives organization and user from the token and `X-Ado-Org-Url` header.

### 3. Run Development Server

```bash
npm run dev
```

Server starts on `http://localhost:3000`

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

### Option 2: Test with Webhook (Local Tunnel)

1. Install ngrok: `npm install -g ngrok`
2. Start your server: `npm run dev`
3. Start tunnel: `ngrok http 3000`
4. Copy the ngrok URL (e.g., `https://abc123.ngrok.io`)
5. Configure webhook in Azure DevOps (see below)
6. Create a test PR

## Configuring Azure DevOps Webhook

### Step-by-Step

1. Go to your Azure DevOps project
2. Navigate to **Project Settings** → **Service Hooks**
3. Click **Create subscription**
4. Select **Web Hooks** as service
5. Select events:
   - **Pull request created**
   - **Pull request updated**
6. Click **Next**
7. Enter your webhook URL:
   - Local: `https://your-ngrok-url.ngrok.io/webhook`
   - Production: `https://your-app.azurewebsites.net/webhook`
8. Set **Content type**: `application/json`
9. Click **Finish**
10. Click **Test** to verify

## Building for Production

Compile TypeScript to JavaScript:

```bash
npm run build
```

Output is in `dist/` directory.

Run production build:

```bash
npm start
```

## Deployment to Azure App Service

### Prerequisites

- Azure subscription
- Azure CLI installed (`az`)

### Deployment Steps

#### 1. Create Azure App Service

```bash
# Login to Azure
az login

# Create resource group (if needed)
az group create --name pr-testcase-rg --location eastus

# Create App Service plan
az appservice plan create \
  --name pr-testcase-plan \
  --resource-group pr-testcase-rg \
  --sku B1 \
  --is-linux

# Create web app
az webapp create \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg \
  --plan pr-testcase-plan \
  --runtime "NODE:18-lts"
```

#### 2. Configure Environment Variables

```bash
az webapp config appsettings set \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg \
  --settings \
    ADO_ORG_URL="https://dev.azure.com/yourorg" \
    ADO_PAT="your-pat-token" \
    GEMINI_API_KEY="your-gemini-key" \
    PORT="8080"
```

#### 3. Enable Always On

```bash
az webapp config set \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg \
  --always-on true
```

#### 4. Deploy Application

```bash
# Build locally
npm run build

# Deploy using Azure CLI
az webapp up \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg \
  --runtime "NODE:18-lts"
```

#### 5. Verify Deployment

```bash
# Check health endpoint
curl https://pr-testcase-generator.azurewebsites.net/health
```

Expected response:

```json
{
  "status": "healthy",
  "uptime": 123,
  "queue": {
    "pending": 0,
    "processing": true
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

#### 6. Configure Azure DevOps Webhook

Update your webhook URL to point to production:

```
https://pr-testcase-generator.azurewebsites.net/webhook
```

### Alternative Deployment Methods

#### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Azure

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - uses: azure/webapps-deploy@v2
        with:
          app-name: pr-testcase-generator
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

#### VS Code Azure Extension

1. Install **Azure App Service** extension
2. Right-click on `dist/` folder
3. Select **Deploy to Web App**
4. Follow prompts

## Production Deployment Checklist

Before going live, verify:

- [ ] All environment variables set in Azure App Service
- [ ] Health endpoint returns 200 status
- [ ] Azure DevOps PAT has correct scopes (Code: Read, Work Items: Read/Write)
- [ ] Gemini API key is valid and has quota
- [ ] Azure DevOps webhook configured with production URL
- [ ] Test webhook delivery with real PR
- [ ] Always On enabled in App Service
- [ ] Application Insights configured (optional but recommended)
- [ ] Alerts configured for error rate > 5%

## API Endpoints

### POST /webhook

Receives Azure DevOps PR webhook events.

**Request:**

```json
{
  "eventType": "git.pullrequest.created",
  "resource": {
    "pullRequestId": 42,
    "title": "Feature implementation",
    "repository": {
      "id": "repo-guid",
      "name": "repo-name",
      "project": {
        "name": "ProjectName"
      }
    }
  }
}
```

**Response (202 Accepted):**

```json
{
  "status": "accepted",
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (400 Bad Request):**

```json
{
  "error": "Invalid payload",
  "details": "Missing required field: resource.pullRequestId"
}
```

### GET /health

Health check for monitoring.

**Response (200 OK):**

```json
{
  "status": "healthy",
  "uptime": 3600,
  "queue": {
    "pending": 2,
    "processing": true
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

## Monitoring

### Logs

View logs in Azure:

```bash
az webapp log tail \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg
```

### Application Insights

Enable for detailed telemetry:

```bash
az monitor app-insights component create \
  --app pr-testcase-insights \
  --resource-group pr-testcase-rg \
  --location eastus

az webapp config appsettings set \
  --name pr-testcase-generator \
  --resource-group pr-testcase-rg \
  --settings APPLICATIONINSIGHTS_CONNECTION_STRING="your-connection-string"
```

### Key Metrics to Monitor

- Webhook requests received
- Jobs processed successfully
- Jobs failed (with reasons)
- AI generation time
- Work item creation time
- Queue depth

## Troubleshooting

### "Failed to connect to Azure DevOps"

- Verify `ADO_ORG_URL` is correct format: `https://dev.azure.com/yourorg`
- Check `ADO_PAT` is valid and not expired
- Ensure PAT has correct scopes

### "Gemini API error"

- Verify `GEMINI_API_KEY` is correct
- Check API quota hasn't been exceeded
- Ensure project has Gemini API enabled

### "Work item creation failed"

- Verify PAT has Work Items: Write scope
- Check project exists in Azure DevOps
- Ensure "Test Case" work item type exists

### "Webhook not received"

- Verify webhook URL is accessible from internet
- Check Azure DevOps webhook configuration
- Test with manual POST request:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d @mock-pr.json
```

### "TypeScript errors"

Run type checking:

```bash
npm run lint
```

## Development

### Code Structure

- **types.ts** - All TypeScript interfaces
- **logger.ts** - Structured logging utility
- **ado-client.ts** - Azure DevOps API client
- **ai.ts** - Gemini AI integration
- **queue.ts** - Job queue with retry logic
- **server.ts** - HTTP server and main entry point

### Adding New Features

1. Define new types in `types.ts`
2. Implement functionality in appropriate module
3. Update logging as needed
4. Test locally with `npm run test:local`
5. Update README with new features

### Modifying System Prompt

Edit `system-prompt.txt` to change AI behavior. The prompt is loaded at startup and cached.

### Changing AI Model

Edit `ai.ts` and update model name:

```typescript
const model = ai.getGenerativeModel({
  model: 'gemini-2.0-flash-exp', // Change this
  // ...
});
```

## Security Considerations

### Secrets Management

- Never commit `.env` file
- Use Azure Key Vault for production secrets
- Rotate PAT tokens regularly
- Monitor API key usage

### Input Validation

- All webhook payloads validated before processing
- PR descriptions sanitized before sending to AI
- AI responses validated before creating work items

### Network Security

- HTTPS enforced in Azure App Service
- Consider IP whitelisting for Azure DevOps webhook IPs
- No webhook signature validation (Azure DevOps doesn't support)

## Performance

### Expected Performance

- Webhook response: < 100ms (202 immediate)
- Background processing: 10-30 seconds per PR
- Handles ~6 PRs/minute comfortably

### Scaling Considerations

- Current design: Single worker, sequential processing
- For higher volume: Consider Azure Storage Queue
- For multiple instances: Use external queue (Redis, Service Bus)

## Support

For issues or questions:

1. Check troubleshooting section above
2. Review logs for error details
3. Verify environment configuration
4. Test with mock data locally

## License

MIT