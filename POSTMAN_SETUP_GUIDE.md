# Postman Setup & Quick Start Guide

## Files Created

1. **POSTMAN_API_TESTING_MANUAL.md** - Complete documentation with all endpoints, headers, bodies, and test cases
2. **Postman_Collection.json** - Ready-to-import Postman collection with all requests and tests

## Quick Setup (5 minutes)

### Step 1: Get Your Azure DevOps Token

1. Go to https://dev.azure.com/yourorg
2. Click your profile icon (top right) → Personal access tokens
3. Click "New Token"
4. Configure:
   - **Name:** Postman Testing
   - **Scopes:** Select these:
     - ✓ Code (Read & Write)
     - ✓ Work Items (Read & Write)
5. Click "Create" and copy the token immediately (you can only see it once)

### Step 2: Import Collection into Postman

1. Open Postman (download free from postman.com if needed)
2. Click **Import** (top left)
3. Select "Upload Files"
4. Choose `Postman_Collection.json`
5. The collection will now appear in your left sidebar

### Step 3: Configure Environment Variables

1. In Postman, create an **Environment** or **Collection Variables**:
   - Click the collection name → "Variables" tab
   - Fill in these values:

| Variable | Example Value | Where to Find |
|----------|---|---|
| `baseUrl` | `http://localhost:3000` | Your backend URL |
| `orgUrl` | `https://dev.azure.com/MyOrg` | Your Azure DevOps organization URL |
| `token` | `<your-pat-token>` | From Step 1 above |
| `prId` | `123` | The PR number in Azure DevOps |
| `projectName` | `MyProject` | Your project name |
| `repositoryId` | `<repo-id>` | Get from Azure DevOps → Project Settings → Repositories |
| `projectId` | `<project-id>` | Get from Azure DevOps → Project Settings |

**How to find IDs in Azure DevOps:**
- Go to Project Settings → Repositories → Select your repo
- Look at the URL: `dev.azure.com/org/project/_git/repo`
- Extract details from there and APIs

### Step 4: Start Testing

1. Click the **1. Health Check** request
2. Click **Send**
3. You should see a 200 OK response with `{"status": "healthy"}`

If health check passes, you're ready to test all endpoints!

---

## Testing Workflow

Run requests in this order for a complete end-to-end test:

### Flow 1: Simple Webhook Test (No Auth Required)
```
1. Health Check         → Verify server is running
2. Webhook - PR Created → Send sample webhook event
```

### Flow 2: Full Test Generation (Auth Required)
```
1. Health Check                        → Verify server is running
2. Generate Test Cases                 → AI generates test case from PR
3. Create Work Item                    → Creates task in Azure DevOps
4. Post PR Comment                     → Links task back to PR
5. (Optional) Store Webhook Token     → Enables automated webhooks
```

### Flow 3: Error Testing (Auth Required)
```
1. Missing Authorization Header        → Should return 401
2. Invalid Token                       → Should return 401
3. Missing Organization URL Header     → Should return 400/401
```

---

## Common Issues & Fixes

### "Status code 401 Unauthorized"
**Problem:** Your token is invalid or expired
**Solution:**
1. Create a new token in Azure DevOps
2. Update the `token` variable in Postman
3. Make sure token has required scopes: Code, Work Items

### "Status code 500"
**Problem:** Backend server error
**Checks:**
1. Is backend running? Run from your IDE or `npm start`
2. Check GEMINI_API_KEY env variable is set
3. Check network connectivity to Azure DevOps

### "Status code 429 Too Many Requests"
**Problem:** You've hit the rate limit
**Solution:**
1. Wait for the time specified in `Retry-After` header
2. Check your rate limits:
   - `/generate-tests`: 10 requests per 10 minutes
   - `/webhook`: 100 requests per 10 minutes

### "Status code 400 Bad Request"
**Problem:** Missing or invalid request data
**Solution:**
1. Verify all required fields are filled in
2. Check headers include `Content-Type: application/json`
3. Ensure variables like `{{prId}}` are properly substituted

### "Status code 403 Forbidden"
**Problem:** User lacks permissions
**Solution:**
1. Verify token user has Contributor role in Azure DevOps project
2. Verify organization URL in `X-Ado-Org-Url` header matches token's organization
3. Check project permissions in Azure DevOps

---

## Postman Tips & Tricks

### Pre-request Scripts
Before each test, Postman can set variables. Examples:

```javascript
// Set timestamp
pm.collectionVariables.set("timestamp", new Date().toISOString());

// Set random ID
pm.collectionVariables.set("prId", Math.floor(Math.random() * 1000));
```

### Test Scripts
After each test, validate the response:

```javascript
// Check status code
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

// Extract response data
var jsonData = pm.response.json();
pm.collectionVariables.set("workItemId", jsonData.workItemId);

// Chain requests: use output of one request in the next
```

### Viewing Response Details
1. Click **Send**
2. Check these tabs in the response panel:
   - **Body** - JSON response
   - **Headers** - Response headers (including rate limit info)
   - **Status** - HTTP status code
   - **Time** - Response time

### Rate Limit Status
After each response, check the value of these headers:
```
X-RateLimit-Limit: 10           (Maximum requests in window)
X-RateLimit-Remaining: 8        (Requests left before hitting limit)
X-RateLimit-Reset: <timestamp>  (When the window resets)
Retry-After: 60                 (Seconds to wait on 429 error)
```

---

## Webhook Testing with Postman

The webhook endpoint doesn't require authentication. You can test it like any other endpoint:

1. Open **2. Webhook - PR Created**
2. Modify the request body with your actual PR data:
   ```json
   {
     "eventType": "git.pullrequest.created",
     "resource": {
       "pullRequestId": 456,
       "title": "Your PR title here",
       ...
     }
   }
   ```
3. Click **Send**
4. You should get `202 Accepted` with a `jobId`

The backend will process this asynchronously.

---

## Environment Setup Checklist

Before running tests, ensure:

- [ ] Backend API is running (`npm start`)
- [ ] GEMINI_API_KEY environment variable is set
- [ ] Azure DevOps Personal Access Token is created
- [ ] Token has scopes: Code, Work Items
- [ ] Postman collection is imported
- [ ] All variables are filled in (token, orgUrl, prId, etc.)
- [ ] Network can reach both `localhost:3000` and `dev.azure.com`

---

## Testing Different Scenarios

### Test 1: Valid Request
Use real data from your Azure DevOps organization.

### Test 2: Missing Fields
Remove required fields to test error handling:
```json
{
  "prId": 123
  // missing projectName and repositoryId
}
```

### Test 3: Invalid Values
Use non-existent IDs:
```json
{
  "prId": 999999,
  "projectName": "NonExistent",
  "repositoryId": "fake-id"
}
```

### Test 4: Rate Limiting
Send `/generate-tests` 11 times in quick succession. After the 10th request, the 11th should get `429 Too Many Requests`.

### Test 5: Token Expiration
Let a PAT token expire (or revoke it) and retry. Should get `401 Unauthorized`.

---

## Next Steps

1. Test each endpoint individually
2. Run the complete end-to-end workflow
3. Test error scenarios
4. Monitor rate limiting
5. Check Azure DevOps for created work items and PR comments

## Support

For issues with:
- **API endpoints** - Check POSTMAN_API_TESTING_MANUAL.md
- **Postman setup** - See Postman docs: postman.com/docs
- **Azure DevOps** - Check Azure DevOps documentation: dev.azure.com/docs
- **Backend code** - See src/backend/

---

**Pro Tip:** Create multiple Postman environments (Dev, Staging, Production) with different tokens and URLs for testing across environments!
