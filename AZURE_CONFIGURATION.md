# Azure App Service Configuration Guide

## Required Azure App Settings

After deploying the fixed code, you **MUST** configure these environment variables in Azure App Service.

### How to Configure (Azure Portal)

1. Go to Azure Portal → App Services → qazent
2. Navigate to: **Settings → Configuration → Application settings**
3. Click **+ New application setting** for each setting below
4. Click **Save** after adding all settings
5. The app will automatically restart

### How to Configure (Azure CLI)

```bash
# Set all required settings at once
az webapp config appsettings set \
  --resource-group <your-resource-group-name> \
  --name qazent \
  --settings \
    WEBSITE_NODE_DEFAULT_VERSION="24-lts" \
    GEMINI_API_KEY="<your-gemini-api-key>" \
    NODE_ENV="production"
```

---

## Required Settings

### 1. WEBSITE_NODE_DEFAULT_VERSION

**Value:** `24-lts`

**Purpose:** Ensures Azure uses Node.js 24.x to match the build environment (GitHub Actions uses Node 24.x) and package.json engines field.

**Critical:** Without this, Azure may use a different Node version causing compatibility issues.

**Note:** If Azure is already running Node 24, this setting ensures it stays on 24.x consistently.

---

### 2. GEMINI_API_KEY

**Value:** `<your-actual-gemini-api-key>`

**Purpose:** Required for AI test case generation. The server validates this at startup and will not start without it.

**Critical:** Server will exit with error if missing:
```
FATAL: Missing required environment variables: GEMINI_API_KEY
On Azure: Set these in Application Settings -> Configuration -> Application settings
```

**Security Note:** For production, consider migrating this to Azure Key Vault for better security.

---

### 3. NODE_ENV

**Value:** `production`

**Purpose:**
- Enables production CORS settings (disables development-only origins)
- Indicates production environment for logging and error handling

**Not Critical:** The app will work without this, but CORS will include development origins which is a security risk.

---

## Optional Settings (Auto-configured by Azure)

### PORT

**Value:** Auto-set by Azure (typically 8080 or dynamic)

**Purpose:** The port the application listens on.

**Status:** ✅ Already handled - server.ts has fallback: `process.env.PORT || '8080'`

**No action needed** - Azure automatically sets this.

---

## Verification Steps

### After Configuring Settings

1. **Check Application Logs** (Azure Portal → Monitoring → Log stream):
   ```
   [STARTUP] Current working directory: /home/site/wwwroot
   [STARTUP] Node version: v18.x.x
   [STARTUP] Environment: production
   [STARTUP] Port: 8080
   [AI] Loading system prompt from: /home/site/wwwroot/system-prompt.txt
   [AI] System prompt loaded successfully, length: XXXX
   Server listening on port XXXX
   ```

2. **Test Health Endpoint**:
   ```bash
   curl https://qazent.azurewebsites.net/health
   ```

   Expected response:
   ```json
   {
     "status": "healthy",
     "timestamp": "2026-02-24T...",
     "uptime": 123
   }
   ```

3. **Verify No Module Errors**:
   ```bash
   # Search logs for module errors
   az webapp log tail --name qazent --resource-group <rg> | grep -i "cannot find module"
   ```

   Expected: No "Cannot find module 'dotenv'" errors

---

## Deployment Structure After Fix

### What Gets Deployed

```
/home/site/wwwroot/
├── dist/
│   ├── server.js              ← Entry point
│   ├── ai.js                   ← Compiled modules
│   ├── logger.js
│   ├── system-prompt.txt       ← Runtime asset (copied by build)
│   └── public/                 ← Static files
├── package.json                ← NEW: Defines dependencies
├── package-lock.json           ← NEW: Dependency lock
└── node_modules/               ← Installed by Azure during deployment
    ├── @google/genai/
    ├── cors/
    └── ... (all production dependencies)
```

### What Changed

**Before (Broken):**
- ❌ Only `dist/` folder deployed
- ❌ No `package.json` → Azure couldn't install dependencies
- ❌ No `node_modules/` → Missing all runtime dependencies
- ❌ Crash: "Cannot find module 'dotenv'"

**After (Fixed):**
- ✅ `dist/`, `package.json`, and `package-lock.json` deployed
- ✅ Azure detects `package.json` and runs `npm install --production`
- ✅ All production dependencies installed in `node_modules/`
- ✅ `dotenv` not installed (moved to devDependencies)
- ✅ Server starts successfully

---

## Troubleshooting

### Issue: "Cannot find module 'dotenv'"

**Cause:** Using old deployment before fix was applied.

**Solution:**
1. Verify GitHub Actions workflow completed successfully
2. Check deployment logs: Should show "Running npm install --production"
3. Redeploy if needed

---

### Issue: "Missing required environment variables: GEMINI_API_KEY"

**Cause:** GEMINI_API_KEY not configured in Azure App Settings.

**Solution:**
```bash
az webapp config appsettings set \
  --resource-group <rg> \
  --name qazent \
  --settings GEMINI_API_KEY="<your-key>"
```

---

### Issue: "Cannot load system-prompt.txt"

**Cause:** File not found in working directory.

**Solution:**
1. Check build script copied file: `cpx system-prompt.txt dist`
2. Verify file exists in deployment artifact
3. Check working directory in logs: `[STARTUP] Current working directory: ...`

---

### Issue: Wrong Node.js version

**Cause:** WEBSITE_NODE_DEFAULT_VERSION not set.

**Solution:**
```bash
az webapp config appsettings set \
  --resource-group <rg> \
  --name qazent \
  --settings WEBSITE_NODE_DEFAULT_VERSION="24-lts"
```

---

## Monitoring Recommendations

### Enable Application Insights

```bash
# Create Application Insights
az monitor app-insights component create \
  --app qazent-insights \
  --location northeurope \
  --resource-group <rg>

# Connect to App Service
az webapp config appsettings set \
  --resource-group <rg> \
  --name qazent \
  --settings APPLICATIONINSIGHTS_CONNECTION_STRING="<connection-string>"
```

### Key Metrics to Monitor

1. **Availability**: Server uptime and response times
2. **Failed Requests**: HTTP 500 errors
3. **Module Errors**: Custom log query for "Cannot find module"
4. **Startup Success**: Check for diagnostic logs in first 30 seconds

### Useful Log Queries (Application Insights)

**Find module errors:**
```kusto
traces
| where message contains "Cannot find module"
| project timestamp, message, severityLevel
| order by timestamp desc
```

**Verify startup sequence:**
```kusto
traces
| where message startswith "[STARTUP]" or message startswith "[AI]"
| project timestamp, message
| order by timestamp asc
```

---

## Summary Checklist

Before marking deployment as complete:

- [ ] All code changes deployed via GitHub Actions
- [ ] WEBSITE_NODE_DEFAULT_VERSION set to "18-lts"
- [ ] GEMINI_API_KEY configured (verify not empty)
- [ ] NODE_ENV set to "production"
- [ ] Health endpoint returns 200 OK
- [ ] Logs show successful startup with all [STARTUP] messages
- [ ] No "Cannot find module" errors in logs
- [ ] Application Insights connected (optional but recommended)

---

## Support

For issues after deployment:

1. **Check logs**: Azure Portal → App Service → Log stream
2. **Review deployment**: Deployment Center → Logs
3. **Verify settings**: Configuration → Application settings
4. **Test health**: `curl https://qazent.azurewebsites.net/health`

---

*Last updated: 2026-02-24*
