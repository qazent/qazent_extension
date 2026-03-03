# Postman API Testing Manual
## Azure DevOps PR Test Case Generator Backend API

**API Base URL:** `http://localhost:3000` (Development) or `https://qazent.azurewebsites.net` (Production)

---

## Table of Contents
1. [Authentication Setup](#authentication-setup)
2. [Common Headers](#common-headers)
3. [Rate Limiting](#rate-limiting)
4. [Endpoint Tests](#endpoint-tests)
5. [Error Handling](#error-handling)
6. [Testing Workflow](#testing-workflow)

---

## Authentication Setup

### Prerequisites
- Azure DevOps account with access to a project
- OAuth token from Azure DevOps (via SDK or Personal Access Token)
- Organization URL (e.g., `https://dev.azure.com/yourorg`)

### Getting an OAuth Token
1. In Azure DevOps, click your profile → Security → Personal Access Tokens
2. Create a new PAT with scopes: `Code (Read)`, `Work Items (Read & Write)`, `Build (Read)`
3. Copy the token (you can only see it once)

### Setting up Postman Variables
Create these in Postman (Collection → Variables or Environment):

```
baseUrl: http://localhost:3000
orgUrl: https://dev.azure.com/yourorg
token: <your-azure-devops-oauth-token-or-pat>
prId: 123
projectName: YourProject
repositoryId: <repo-id>
projectId: <project-id>
```

---

## Common Headers

All API requests should include:

| Header | Required | Value | Notes |
|--------|----------|-------|-------|
| `Content-Type` | Yes | `application/json` | For all POST requests |
| `Authorization` | Yes* | `Bearer {{token}}` | Required for protected endpoints only (marked with 🔒) |
| `X-Ado-Org-Url` | Yes* | `{{orgUrl}}` | Required for protected endpoints only |
| `X-Forwarded-For` | No | `192.168.1.1` | Optional, used for rate limit tracking |

*Required for protected endpoints (🔒)

---

## Rate Limiting

**Rate Limit Headers in Response:**
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 2026-02-25T10:05:00.000Z
Retry-After: 60
```

**Limits by Endpoint:**
| Endpoint | Limit | Window |
|----------|-------|--------|
| `/health` | 60 requests | 1 minute |
| `/webhook` | 100 requests | 10 minutes |
| `/generate-tests` | 10 requests | 10 minutes |
| `/api/webhook-token` | 10 requests | 10 minutes |
| `/create-work-item` | 20 requests | 10 minutes |
| `/post-pr-comment` | 20 requests | 10 minutes |

---

## Endpoint Tests

### 1. Health Check ✅

**Test Name:** Health Check - Verify Server is Running

**HTTP Method:** `GET`

**URL:** `{{baseUrl}}/health`

**Headers:**
```
Content-Type: application/json
```

**Request Body:** (None - GET request)

**Expected Response:** `200 OK`
```json
{
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2026-02-25T10:00:00.000Z"
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response contains healthy status", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.status).to.equal("healthy");
});

pm.test("Rate limit headers present", function () {
    pm.expect(pm.response.headers.get("X-RateLimit-Limit")).to.exist;
});
```

**Test Case:** Health check after server restart
**Expected Behavior:** Server responds with uptime > 0

---

### 2. Webhook Endpoint 🔌

**Test Name:** Receive PR Webhook Event

**HTTP Method:** `POST`

**URL:** `{{baseUrl}}/webhook`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "eventType": "git.pullrequest.created",
  "resource": {
    "pullRequestId": 123,
    "title": "Add new authentication feature",
    "description": "Implements OAuth2 authentication for the API",
    "repository": {
      "id": "repo-abc-123",
      "name": "MyRepository",
      "url": "https://dev.azure.com/myorg/myproject/_git/MyRepository",
      "project": {
        "name": "MyProject",
        "id": "proj-xyz-789"
      }
    },
    "sourceRefName": "refs/heads/feature/auth",
    "targetRefName": "refs/heads/main",
    "createdBy": {
      "displayName": "John Doe",
      "uniqueName": "john.doe@example.com",
      "id": "user-123"
    }
  }
}
```

**Expected Response:** `202 Accepted`
```json
{
  "status": "accepted",
  "jobId": "12345678-1234-1234-1234-123456789abc"
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 202", function () {
    pm.response.to.have.status(202);
});

pm.test("Response contains jobId", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.jobId).to.exist;
    pm.expect(jsonData.status).to.equal("accepted");
});

pm.test("Rate limit headers present", function () {
    pm.expect(pm.response.headers.get("X-RateLimit-Remaining")).to.exist;
});
```

**Test Cases:**
1. **Valid PR Created Event** - Should accept and queue background job
2. **Valid PR Updated Event** - Should handle PR updates
3. **Missing Event Type** - Should return 400 Bad Request
4. **Invalid JSON** - Should return 400 Bad Request

---

### 3. Generate Test Cases 🔒

**Test Name:** Generate Test Cases from PR Code Changes

**HTTP Method:** `POST`

**URL:** `{{baseUrl}}/generate-tests`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{token}}
X-Ado-Org-Url: {{orgUrl}}
```

**Request Body:**
```json
{
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-abc-123",
  "customContext": "This PR adds a new REST API endpoint for user authentication. Focus on security, input validation, and error handling test cases."
}
```

**Request Body (Without Optional Context):**
```json
{
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-abc-123"
}
```

**Expected Response:** `200 OK` (Timeout: 60 seconds)
```json
{
  "title": "Test OAuth2 Authentication Endpoint",
  "htmlDescriptionBase64": "<h2>Test Case: OAuth2 Authentication</h2><p>This test case validates the OAuth2 authentication flow...</p>",
  "sourceCommitId": "abc123def456",
  "targetCommitId": "xyz789uvw012",
  "purpose": "Validate OAuth2 token generation and expiration",
  "scopeOfChange": "Added new /auth/oauth/token endpoint with JWT support",
  "preconditions": [
    "API server is running",
    "Database with test users is available",
    "OAuth provider is accessible"
  ],
  "testSteps": [
    "1. Send POST request to /auth/oauth/token with valid credentials",
    "2. Verify token is generated and contains required claims",
    "3. Use token in Authorization header for subsequent requests",
    "4. Verify token expiration time is 1 hour"
  ],
  "expectedResults": [
    "Token endpoint returns 200 OK",
    "Response contains access_token and expires_in fields",
    "Token can be decoded and verified with server public key"
  ],
  "negativeScenarios": [
    "Invalid credentials return 401 Unauthorized",
    "Missing credentials return 400 Bad Request",
    "Expired token returns 401 Unauthorized"
  ],
  "edgeCases": [
    "Very long password (>1000 chars)",
    "Special characters in username",
    "Simultaneous token requests from same user",
    "Token refresh before expiration"
  ],
  "regressionAreas": [
    "Existing login endpoint compatibility",
    "Session management",
    "CORS for authentication endpoints"
  ],
  "dataRequirements": [
    "Test user with known credentials",
    "Test OAuth provider access",
    "Database reset capability"
  ],
  "automationNotes": "Can be automated using REST API calls and JWT verification helpers"
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response contains test case title", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.title).to.exist;
    pm.expect(jsonData.title.length).to.be.greaterThan(0);
});

pm.test("Test case has all required fields", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.htmlDescriptionBase64).to.exist;
    pm.expect(jsonData.testSteps || jsonData.purpose).to.exist;
});

pm.test("Response time is within 60 seconds", function () {
    pm.expect(pm.response.responseTime).to.be.below(60000);
});

// Save testCase for later use
var jsonData = pm.response.json();
pm.collectionVariables.set("testCase", JSON.stringify(jsonData));
```

**Test Cases:**
1. **Valid Request with Custom Context** - Should generate test case with context applied
2. **Valid Request without Custom Context** - Should generate default test case
3. **Missing Authorization Header** - Should return 401 Unauthorized
4. **Invalid Token** - Should return 401 Unauthorized
5. **Token from Different Organization** - Should return 403 Forbidden
6. **Invalid Project Name** - Should return 400 Bad Request
7. **Rate Limit Exceeded** - Should return 429 Too Many Requests after 10 requests in 10 minutes

---

### 4. Create Work Item 🔒

**Test Name:** Create Task Work Item in Azure DevOps

**HTTP Method:** `POST`

**URL:** `{{baseUrl}}/create-work-item`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{token}}
X-Ado-Org-Url: {{orgUrl}}
```

**Request Body:**
```json
{
  "testCase": {
    "title": "Test OAuth2 Authentication Endpoint",
    "htmlDescriptionBase64": "<h2>Test Case: OAuth2 Authentication</h2><p>This test case validates the OAuth2 authentication flow...</p>",
    "purpose": "Validate OAuth2 token generation and expiration",
    "scopeOfChange": "Added new /auth/oauth/token endpoint with JWT support",
    "preconditions": [
      "API server is running",
      "Database with test users is available"
    ],
    "testSteps": [
      "1. Send POST request to /auth/oauth/token with valid credentials",
      "2. Verify token is generated and contains required claims",
      "3. Use token in Authorization header for subsequent requests"
    ],
    "expectedResults": [
      "Token endpoint returns 200 OK",
      "Response contains access_token and expires_in fields"
    ],
    "negativeScenarios": [
      "Invalid credentials return 401 Unauthorized",
      "Missing credentials return 400 Bad Request"
    ],
    "edgeCases": [
      "Very long password (>1000 chars)",
      "Special characters in username"
    ],
    "regressionAreas": [
      "Existing login endpoint compatibility",
      "Session management"
    ],
    "dataRequirements": [
      "Test user with known credentials",
      "Test OAuth provider access"
    ],
    "automationNotes": "Can be automated using REST API calls and JWT verification helpers"
  },
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-abc-123",
  "projectId": "proj-xyz-789",
  "sourceCommitId": "abc123def456",
  "targetCommitId": "xyz789uvw012"
}
```

**Expected Response:** `200 OK` (Timeout: 30 seconds)
```json
{
  "workItemId": 45678,
  "workItemUrl": "https://dev.azure.com/myorg/myproject/_workitems/edit/45678"
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response contains workItemId and URL", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.workItemId).to.exist;
    pm.expect(jsonData.workItemUrl).to.exist;
    pm.expect(jsonData.workItemId).to.be.a("number");
});

pm.test("Work item URL is valid format", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.workItemUrl).to.include("dev.azure.com");
    pm.expect(jsonData.workItemUrl).to.include("_workitems/edit/");
});

// Save workItemId for next request
var jsonData = pm.response.json();
pm.collectionVariables.set("workItemId", jsonData.workItemId);
pm.collectionVariables.set("workItemUrl", jsonData.workItemUrl);
```

**Test Cases:**
1. **Valid Request** - Should create work item and return ID
2. **Missing Authorization Header** - Should return 401 Unauthorized
3. **Invalid Token** - Should return 401 Unauthorized
4. **Missing Required Fields** - Should return 400 Bad Request
5. **Invalid Project Name** - Should return 400 Bad Request
6. **User Lacks Permissions** - Should return 403 Forbidden
7. **Invalid HTML in Description** - Should sanitize and still create item

---

### 5. Post PR Comment 🔒

**Test Name:** Post Comment on PR with Work Item Link

**HTTP Method:** `POST`

**URL:** `{{baseUrl}}/post-pr-comment`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{token}}
X-Ado-Org-Url: {{orgUrl}}
```

**Request Body:**
```json
{
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-abc-123",
  "workItemId": 45678
}
```

**Expected Response:** `200 OK` (Timeout: 10 seconds)
```json
{
  "success": true
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response indicates success", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.success).to.equal(true);
});

pm.test("Response time is under 10 seconds", function () {
    pm.expect(pm.response.responseTime).to.be.below(10000);
});
```

**Test Cases:**
1. **Valid Request** - Should post comment successfully
2. **Missing Authorization Header** - Should return 401 Unauthorized
3. **Invalid Token** - Should return 401 Unauthorized
4. **Invalid PR ID** - Should return 400 Bad Request
5. **PR Not Found** - Should return 404 Not Found
6. **User Lacks Permissions** - Should return 403 Forbidden
7. **Invalid Work Item ID** - Should still post (graceful degradation)

---

### 6. Webhook Token Storage 🔒

**Test Name:** Store Webhook Authentication Token

**HTTP Method:** `POST`

**URL:** `{{baseUrl}}/api/webhook-token`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{token}}
X-Ado-Org-Url: {{orgUrl}}
```

**Request Body:**
```json
{
  "orgUrl": "https://dev.azure.com/myorg",
  "token": "PAT_TOKEN_HERE_OR_OAUTH_TOKEN"
}
```

**Expected Response:** `200 OK`
```json
{
  "success": true,
  "message": "Webhook token stored successfully",
  "orgUrl": "https://dev.azure.com/myorg"
}
```

**Postman Test Script:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response indicates success", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.success).to.equal(true);
    pm.expect(jsonData.message).to.include("stored successfully");
});

pm.test("Organization URL is echoed back", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.orgUrl).to.equal(pm.collectionVariables.get("orgUrl"));
});
```

**Test Cases:**
1. **Valid PAT Token** - Should store token successfully
2. **Valid OAuth Token** - Should store token successfully
3. **Invalid Token Format** - Should return 400 Bad Request
4. **Missing Organization URL** - Should return 400 Bad Request
5. **Missing Authorization Header** - Should return 401 Unauthorized
6. **User Lacks Permissions** - Should return 403 Forbidden
7. **Token Already Exists** - Should overwrite successfully

---

## Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "error": "Invalid request",
  "details": "Missing required field: prId",
  "message": "Request validation failed"
}
```

#### 401 Unauthorized
```json
{
  "error": "Unauthorized",
  "details": "Invalid or expired token",
  "message": "Authentication required"
}
```

#### 403 Forbidden
```json
{
  "error": "Forbidden",
  "details": "User does not have permission to access this resource",
  "message": "Access denied"
}
```

#### 429 Too Many Requests
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again later.",
    "statusCode": 429,
    "retryAfter": 60,
    "timestamp": "2026-02-25T10:00:00.000Z"
  }
}
```

#### 500 Internal Server Error
```json
{
  "error": "Internal Server Error",
  "details": "An unexpected error occurred while processing your request",
  "message": "Please try again later or contact support"
}
```

### Postman Test for Error Handling
```javascript
pm.test("Error responses have consistent structure", function () {
    if (pm.response.code >= 400) {
        var jsonData = pm.response.json();
        pm.expect(jsonData.error || jsonData.error.code).to.exist;
    }
});

pm.test("Rate limit error includes retryAfter", function () {
    if (pm.response.code === 429) {
        var jsonData = pm.response.json();
        pm.expect(jsonData.error.retryAfter).to.exist;
        pm.expect(jsonData.error.retryAfter).to.be.a("number");
    }
});
```

---

## Testing Workflow

### Complete End-to-End Flow

**Objective:** Test the full workflow from webhook to comment posting

**Prerequisites:**
1. Valid Azure DevOps organization and project
2. Valid OAuth token with appropriate scopes
3. An existing PR in your repository

**Steps:**

#### Step 1: Health Check
- **Endpoint:** `/health`
- **Purpose:** Verify backend is operational
- **Expected:** 200 OK response

#### Step 2: Store Webhook Token (Optional)
- **Endpoint:** `/api/webhook-token`
- **Purpose:** Store credentials for webhook processing
- **Expected:** 200 OK with success=true

#### Step 3: Generate Test Cases
- **Endpoint:** `/generate-tests`
- **Body:** Include your actual PR data
- **Purpose:** AI generates test cases from PR changes
- **Expected:** 200 OK with comprehensive test case
- **Save:** Store the generated test case in a variable

#### Step 4: Create Work Item
- **Endpoint:** `/create-work-item`
- **Body:** Use the generated test case from Step 3
- **Purpose:** Create task work item in Azure DevOps
- **Expected:** 200 OK with workItemId
- **Save:** Store the workItemId and URL

#### Step 5: Post PR Comment
- **Endpoint:** `/post-pr-comment`
- **Body:** Use the workItemId from Step 4
- **Purpose:** Link test case to PR via comment
- **Expected:** 200 OK with success=true

### Postman Collection JSON Template

Use this template to import into Postman:

```json
{
  "info": {
    "name": "Azure DevOps Test Case Generator API",
    "description": "Complete API testing for PR test case generation",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "1. Health Check",
      "request": {
        "method": "GET",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "url": {
          "raw": "{{baseUrl}}/health",
          "host": ["{{baseUrl}}"],
          "path": ["health"]
        }
      }
    },
    {
      "name": "2. Webhook - PR Created",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{...}"
        },
        "url": {
          "raw": "{{baseUrl}}/webhook",
          "host": ["{{baseUrl}}"],
          "path": ["webhook"]
        }
      }
    }
  ]
}
```

---

## Quick Reference: Headers by Endpoint

| Endpoint | Content-Type | Authorization | X-Ado-Org-Url |
|----------|---|---|---|
| GET /health | ✓ | ✗ | ✗ |
| POST /webhook | ✓ | ✗ | ✗ |
| POST /generate-tests | ✓ | ✓ | ✓ |
| POST /create-work-item | ✓ | ✓ | ✓ |
| POST /post-pr-comment | ✓ | ✓ | ✓ |
| POST /api/webhook-token | ✓ | ✓ | ✓ |

---

## Security Notes

1. **Never commit tokens** - Use Postman environments, not collection files
2. **Token expiration** - OAuth tokens expire; refresh if tests fail with 401
3. **Rate limiting** - Implement exponential backoff for retries
4. **CORS** - API accepts requests from Azure DevOps domains only
5. **Test data** - Use non-production organizations when possible
6. **Webhook URL** - Hardcoded as `https://api.qazent.com/webhook` on backend

---

## Troubleshooting

### 401 Unauthorized
- **Cause:** Invalid or expired token
- **Solution:** Refresh token in Azure DevOps or create new PAT

### 403 Forbidden
- **Cause:** User lacks project permissions
- **Solution:** Grant user Contributor role or higher in Azure DevOps

### 429 Too Many Requests
- **Cause:** Rate limit exceeded
- **Solution:** Wait for time specified in Retry-After header

### 500 Internal Server Error
- **Cause:** Backend error (check logs)
- **Solution:** Verify all required fields are present and valid

### Timeout (60s on generate-tests)
- **Cause:** AI API is slow or unreachable
- **Solution:** Check GEMINI_API_KEY environment variable is set

---

## Environment Variables Needed

Backend requires these to be set:

```bash
# Required
GEMINI_API_KEY=your-google-gemini-api-key
NODE_ENV=development  # or production
PORT=3000

# Optional
TOKEN_ENCRYPTION_KEY=your-encryption-key
ADO_PAT=your-azure-devops-pat  # For webhook fallback
NGROK_URL=https://your-ngrok-url.ngrok-free.dev  # For development
```

---

**Last Updated:** 2026-02-25
**API Version:** 1.0
**Endpoint Base URL:** http://localhost:3000 (dev) | https://qazent.azurewebsites.net (prod)
