# PR Assistant - Azure DevOps Extension

A minimal, clean Azure DevOps extension that provides AI-powered test case generation for pull requests.

## Features

- **PR Information Display**: View PR title, ID, author, and files changed
- **AI Test Case Generation**: Generate comprehensive test cases using Google Gemini AI
- **Work Item Creation**: Create Test Case work items directly from generated test cases
- **Azure DevOps Integration**: Seamlessly integrates with Azure Repos

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- Azure DevOps organization
- Google Gemini API key
- Azure DevOps Personal Access Token (PAT)

### Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Create a `.env` file with the following variables:
   ```env
   ADO_ORG_URL=https://dev.azure.com/your-org
   ADO_PAT=your-personal-access-token
   ADO_PROJECT_NAME=your-project-name
   GEMINI_API_KEY=your-gemini-api-key
   PORT=3000
   ```

3. **Build the backend**:
   ```bash
   npm run build
   ```

4. **Build the extension frontend**:
   ```bash
   npm run build:extension
   ```

5. **Package the extension**:
   ```bash
   npm run package:extension
   ```
   This creates a `.vsix` file that can be uploaded to Azure DevOps marketplace.

### Publishing to Azure DevOps

1. Go to [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. Sign in with your publisher account (create one if needed)
3. Click "New extension" → "Azure DevOps"
4. Upload the generated `.vsix` file
5. Share the extension with your Azure DevOps organization
6. Install the extension in your organization

## Usage

### Starting the Backend Server

```bash
npm run start
```

The backend server must be running for the extension to work. By default, it runs on `http://localhost:3000`.

### Using the Extension

1. **Navigate to a Pull Request** in Azure Repos
2. **Click the "PR Assistant" tab** in the Repos section
3. **View PR Information** displayed at the top
4. **Click "Generate AI Test Cases"** to generate test cases
5. **Review the generated test case** showing:
   - Title
   - Preconditions
   - Test Steps
   - Expected Results
6. **Click "Copy to Clipboard"** to copy the test case
7. **Click "Create Work Item"** to create a Test Case work item linked to the PR

### Configuration

#### Backend URL

Update the backend URL in `vss-extension.json`:

```json
{
  "contributions": [{
    "properties": {
      "configuration": {
        "backendUrl": "http://localhost:3000"
      }
    }
  }]
}
```

For production, change this to your deployed backend URL (e.g., `https://pr-assistant.azurewebsites.net`).

## Development

### Running in Development Mode

1. **Start backend with hot reload**:
   ```bash
   npm run dev
   ```

2. **Build extension with watch mode**:
   ```bash
   npm run dev:extension
   ```

3. **Package and test**:
   ```bash
   npm run package:extension
   ```
   Then upload to Azure DevOps as a private extension for testing.

### Project Structure

```
test-extension/
├── src/                          # Frontend code
│   ├── hub/
│   │   ├── hub.html             # Entry HTML
│   │   ├── PRAssistantHub.tsx   # Main component
│   │   ├── PRInfoSection.tsx    # PR info display
│   │   ├── GenerateButton.tsx   # Generate button
│   │   └── TestCaseCard.tsx     # Test case display
│   ├── services/
│   │   └── backendClient.ts     # API client
│   └── types/
│       └── extension-types.ts   # Frontend types
├── dist/                         # Build output
├── server.ts                     # Backend server
├── ado-client.ts                 # Azure DevOps API client
├── ai.ts                         # AI generation
├── types.ts                      # Backend types
├── vss-extension.json            # Extension manifest
├── webpack.config.js             # Frontend build config
└── package.json                  # Dependencies
```

## API Endpoints

### POST /generate-tests

Generate test cases for a pull request.

**Request body**:
```json
{
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-guid"
}
```

**Response**:
```json
{
  "title": "Test Case Title",
  "preconditions": ["Precondition 1", "Precondition 2"],
  "testSteps": ["Step 1", "Step 2"],
  "expectedResults": ["Expected result 1"],
  ...
}
```

### POST /create-work-item

Create a work item from a test case.

**Request body**:
```json
{
  "testCase": { ... },
  "prId": 123,
  "projectName": "MyProject",
  "repositoryId": "repo-guid"
}
```

**Response**:
```json
{
  "workItemId": 456,
  "workItemUrl": "https://dev.azure.com/org/project/_workitems/edit/456"
}
```

### GET /health

Health check endpoint.

**Response**:
```json
{
  "status": "healthy",
  "uptime": 12345,
  "queue": {
    "pending": 0,
    "processing": false
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Troubleshooting

### Extension not loading

- Verify backend server is running
- Check CORS configuration allows Azure DevOps origins
- Check browser console for errors

### PR context not detected

- Ensure you're viewing a Pull Request page
- Refresh the page and try again
- Check Azure DevOps Extension SDK is loaded

### Test case generation fails

- Verify Gemini API key is correct
- Check backend logs for errors
- Ensure PR has code changes

### Work item creation fails

- Verify PAT has work item write permissions
- Check project name is correct
- Review backend logs for detailed errors

## License

MIT
