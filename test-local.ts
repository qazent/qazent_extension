/**
 * Local testing script for PR test case generation
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { WebhookPayload, PRMetadata, CodeDiff } from './types';
import * as logger from './logger';
import * as adoClient from './ado-client';
import * as ai from './ai';

// Load environment variables
dotenv.config();

/**
 * Extract PR metadata from webhook payload
 */
function extractPRMetadata(payload: WebhookPayload): PRMetadata {
  return {
    prId: payload.resource.pullRequestId,
    title: payload.resource.title,
    description: payload.resource.description || '',
    repositoryId: payload.resource.repository.id,
    repositoryName: payload.resource.repository.name,
    projectName: payload.resource.repository.project.name,
    projectId: payload.resource.repository.project.id,
    sourceBranch: payload.resource.sourceRefName.replace('refs/heads/', ''),
    targetBranch: payload.resource.targetRefName.replace('refs/heads/', ''),
    author: payload.resource.createdBy.displayName,
    authorEmail: payload.resource.createdBy.uniqueName,
    createDate: new Date(),
    branchName: payload.resource.sourceRefName.replace('refs/heads/', '')
  };
}

/**
 * Create mock code diff
 */
function createMockDiff(): CodeDiff {
  return {
    changes: [
      {
        filePath: '/src/middleware/auth.ts',
        changeType: 'add',
        linesAdded: 45,
        linesDeleted: 0,
        diffContent: `
+export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
+  const authHeader = req.headers.authorization;
+  if (!authHeader) {
+    return res.status(401).json({ error: 'No token provided' });
+  }
+  const token = authHeader.split(' ')[1];
+  try {
+    const decoded = jwt.verify(token, JWT_SECRET);
+    req.user = decoded;
+    next();
+  } catch (error) {
+    return res.status(403).json({ error: 'Invalid token' });
+  }
+}
`
      },
      {
        filePath: '/src/routes/api.ts',
        changeType: 'edit',
        linesAdded: 3,
        linesDeleted: 1,
        diffContent: `
+import { authenticateJWT } from '../middleware/auth';
+
-router.get('/users', getUsers);
+router.get('/users', authenticateJWT, getUsers);
`
      }
    ],
    totalChanges: 2
  };
}

/**
 * Main test function
 */
async function runTest(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Azure DevOps PR Test Case Generator - Local Test');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1: Load mock payload
    console.log('Step 1: Loading mock PR payload...');
    const mockPath = path.join(__dirname, 'mock-pr.json');
    const mockData = fs.readFileSync(mockPath, 'utf-8');
    const payload: WebhookPayload = JSON.parse(mockData);

    const prMetadata = extractPRMetadata(payload);
    console.log(`  ✓ PR #${prMetadata.prId}: ${prMetadata.title}`);
    console.log(`  ✓ Project: ${prMetadata.projectName}`);
    console.log(`  ✓ Repository: ${prMetadata.repositoryName}`);
    console.log();

    // Step 2: Fetch diff (or use mock)
    let codeDiff: CodeDiff;

    if (process.env.MOCK_MODE === 'true') {
      console.log('Step 2: Using mock code diff (MOCK_MODE=true)...');
      codeDiff = createMockDiff();
      console.log(`  ✓ Mock diff: ${codeDiff.totalChanges} files changed`);
    } else {
      console.log('Step 2: Fetching real PR diff from Azure DevOps...');
      adoClient.initializeAdoConnection();
      codeDiff = await adoClient.fetchPRDiff(
        prMetadata.projectName,
        prMetadata.repositoryId,
        prMetadata.prId
      );
      console.log(`  ✓ Fetched diff: ${codeDiff.totalChanges} files changed`);
    }
    console.log();

    // Step 3: Generate test cases with AI
    console.log('Step 3: Generating test cases with AI...');
    ai.loadSystemPrompt();
    const taskOutput = await ai.generateTestCases(prMetadata, codeDiff);
    console.log(`  ✓ Task output generated: ${taskOutput.title}`);
    console.log(`  ✓ HTML description length: ${taskOutput.htmlDescription.length} characters`);
    console.log();

    // Display generated task output
    console.log('Generated Task Output:');
    console.log('-'.repeat(60));
    console.log(`Title: ${taskOutput.title}`);
    console.log();
    console.log('HTML Description:');
    console.log(taskOutput.htmlDescription.substring(0, 500) + '...');
    console.log('-'.repeat(60));
    console.log();

    // Step 4: Create work item (skip in mock mode)
    if (process.env.MOCK_MODE === 'true') {
      console.log('Step 4: Skipping work item creation (MOCK_MODE=true)...');
      console.log('  ✓ Task work item would be created in Azure DevOps');
    } else {
      console.log('Step 4: Creating task work item in Azure DevOps...');
      const workItemId = await adoClient.createTaskWorkItem(
        prMetadata.projectName,
        taskOutput,
        prMetadata
      );
      console.log(`  ✓ Work item created: #${workItemId}`);

      const workItemUrl = `${process.env.ADO_ORG_URL}/${prMetadata.projectName}/_workitems/edit/${workItemId}`;
      console.log(`  ✓ View at: ${workItemUrl}`);
    }
    console.log();

    console.log('='.repeat(60));
    console.log('✓ Test completed successfully!');
    console.log('='.repeat(60));

    process.exit(0);

  } catch (error) {
    console.error();
    console.error('='.repeat(60));
    console.error('✗ Test failed with error:');
    console.error('='.repeat(60));
    console.error(error);
    console.error();

    logger.error('Local test failed', { error: String(error) });

    process.exit(0);
  }
}

// Run the test
runTest();
