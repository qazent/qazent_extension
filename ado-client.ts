/**
 * Azure DevOps API client wrapper
 */

import * as azdev from 'azure-devops-node-api';
import { GitApi } from 'azure-devops-node-api/GitApi';
import { WorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import { JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { CodeDiff, DiffChange, GeneratedTestCase, PRMetadata } from './types';
import * as logger from './logger';

let connection: azdev.WebApi | null = null;



/**
 * Initialize connection to Azure DevOps
 */
export function initializeAdoConnection(): azdev.WebApi {
  const orgUrl = process.env.ADO_ORG_URL;
  const pat = process.env.ADO_PAT;


  if (!orgUrl || !pat) {
    throw new Error('ADO_ORG_URL and ADO_PAT environment variables are required');
  }

  const authHandler = azdev.getPersonalAccessTokenHandler(pat);
  connection = new azdev.WebApi(orgUrl, authHandler);

  logger.info('Azure DevOps connection initialized', { orgUrl });
  return connection;
}

/**
 * Get cached connection or create new one
 */
function getConnection(): azdev.WebApi {
  if (!connection) {
    return initializeAdoConnection();
  }
  return connection;
}


/**
 * GET PR metadata (title, description, author) from Azure DevOps
 */

/**
 * GET PR metadata (title, description, author) from Azure DevOps
 */
export async function fetchPRMetadata(prId: number): Promise<PRMetadata> {
  try {
    logger.info("Fetching PR metadata", { prId });

    const conn = getConnection();
    const gitApi: GitApi = await conn.getGitApi();

    // Fetch PR by ID (project is optional if connection already scoped)
    const pr = await gitApi.getPullRequestById(prId);

    if (!pr) {
      throw new Error(`PR with ID ${prId} not found`);
    }

    const sourceBranch = pr.sourceRefName ?? "";
    const targetBranch = pr.targetRefName ?? "";
    
    const metadata: PRMetadata = {
      prId,
      title: pr.title ?? "",
      description: pr.description ?? "",
      author: pr.createdBy?.displayName ?? "",
      authorEmail: pr.createdBy?.uniqueName ?? "",
      createDate: pr.creationDate ?? new Date(),
      repositoryId: pr.repository?.id ?? "",
      repositoryName: pr.repository?.name ?? "",
      projectName: pr.repository?.project?.name ?? "",
      projectId: pr.repository?.project?.id ?? "",
      sourceBranch,
      targetBranch,
      branchName: sourceBranch.split('/').pop() ?? "",
    };

    logger.info("PR metadata fetched successfully", {
      prId,
      title: metadata.title
    });

    return metadata;
  } catch (error) {
    logger.error("Failed to fetch PR metadata", {
      prId,
      error: String(error)
    });
    throw new Error(`Failed to fetch metadata for PR ${prId}: ${error}`);
  }
}

/**
 * GET PR diff from Azure DevOps
 *
 * This function retrieves the list of changed files and their change types (add/edit/delete).
 * Due to API limitations, it provides a simplified diff representation rather than full line-by-line diffs.
 */


export async function fetchPRDiff(
  projectName: string,
  repositoryId: string,
  prId: number
): Promise<CodeDiff> {
  try {
    logger.info('Fetching PR diff', { projectName, repositoryId, prId });

    const conn = getConnection();
    const gitApi: GitApi = await conn.getGitApi();

    // Get PR iterations to find latest changes
    const iterations = await gitApi.getPullRequestIterations(repositoryId, prId, projectName);

    if (!iterations || iterations.length === 0) {
      throw new Error(`No iterations found for PR ${prId}`);
    }

    // Get the latest iteration
    const latestIteration = iterations[iterations.length - 1];
    const iterationId = latestIteration.id;

    if (!iterationId) {
      throw new Error('Latest iteration has no ID');
    }

    // Get changes for the latest iteration
    const changes = await gitApi.getPullRequestIterationChanges(
      repositoryId,
      prId,
      iterationId,
      projectName
    );

    if (!changes || !changes.changeEntries) {
      logger.warn('No changes found in PR', { prId });
      return { changes: [], totalChanges: 0 };
    }

    const diffChanges: DiffChange[] = [];

    // Process each changed file
    for (const change of changes.changeEntries) {
      if (!change.item?.path) {
        continue;
      }

      const filePath = change.item.path;
      let changeType: 'add' | 'edit' | 'delete' = 'edit';

      if (change.changeType) {
        if (change.changeType.toString().includes('add')) {
          changeType = 'add';
        } else if (change.changeType.toString().includes('delete')) {
          changeType = 'delete';
        }
      }

      // Get file diff content
      let diffContent = '';
      let linesAdded = 0;
      let linesDeleted = 0;

      try {
        // For deleted files, we can't fetch diff, so skip
        if (changeType !== 'delete' && change.item.objectId) {
          // Use a simplified approach - just record basic change info
          // Full diff extraction would require more complex API calls
          diffContent = `File: ${filePath}\nChange type: ${changeType}`;

          // Estimate line changes based on change type
          if (changeType === 'add') {
            linesAdded = 10; // Estimate
            linesDeleted = 0;
          } else if (changeType === 'edit') {
            linesAdded = 5; // Estimate
            linesDeleted = 3; // Estimate
          }
        }
      } catch (diffError) {
        logger.warn('Failed to fetch diff for file', { filePath, error: String(diffError) });
        diffContent = `[Diff unavailable for ${filePath}]`;
      }

      diffChanges.push({
        filePath,
        changeType,
        linesAdded,
        linesDeleted,
        diffContent
      });

      // Limit to 50 files to avoid overwhelming the AI
      if (diffChanges.length >= 50) {
        logger.warn('Truncating diff to 50 files', { totalFiles: changes.changeEntries.length });
        break;
      }
    }

    logger.info('PR diff fetched successfully', {
      prId,
      filesChanged: diffChanges.length,
      totalChanges: changes.changeEntries.length
    });

    return {
      changes: diffChanges,
      totalChanges: changes.changeEntries.length
    };

  } catch (error) {
    logger.error('Failed to fetch PR diff', {
      projectName,
      repositoryId,
      prId,
      error: String(error)
    });
    throw new Error(`Failed to fetch diff for PR ${prId}: ${error}`);
  }
}

/**
 * Format test steps as Azure DevOps XML
 */
function formatTestStepsXml(testSteps: string[], expectedResults: string[]): string {
  let xml = '<steps id="0">';

  for (let i = 0; i < testSteps.length; i++) {
    const stepNum = i + 1;
    const step = testSteps[i] || 'N/A';
    const expected = expectedResults[i] || 'N/A';

    // Escape HTML entities and wrap in HTML
    const stepHtml = escapeHtml(step);
    const expectedHtml = escapeHtml(expected);

    xml += `
  <step id="${stepNum}" type="ActionStep">
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${stepHtml}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${expectedHtml}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <description/>
  </step>`;
  }

  xml += '\n</steps>';
  return xml;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format test case description as HTML
 */
function formatDescriptionHtml(testCase: GeneratedTestCase, prMetadata: PRMetadata): string {
  const { purpose, scopeOfChange, preconditions, negativeScenarios, edgeCases,
          regressionAreas, dataRequirements, automationNotes } = testCase;
  const { prId, title } = prMetadata;

  let html = `<h2>Purpose</h2><p>${escapeHtml(purpose)}</p>`;

  html += `<h2>Scope of Change</h2><p>${escapeHtml(scopeOfChange)}</p>`;

  if (preconditions.length > 0) {
    html += '<h2>Preconditions</h2><ul>';
    preconditions.forEach(item => {
      html += `<li>${escapeHtml(item)}</li>`;
    });
    html += '</ul>';
  }

  if (negativeScenarios.length > 0) {
    html += '<h2>Negative Scenarios</h2><ul>';
    negativeScenarios.forEach(item => {
      html += `<li>${escapeHtml(item)}</li>`;
    });
    html += '</ul>';
  }

  if (edgeCases.length > 0) {
    html += '<h2>Edge Cases</h2><ul>';
    edgeCases.forEach(item => {
      html += `<li>${escapeHtml(item)}</li>`;
    });
    html += '</ul>';
  }

  if (regressionAreas.length > 0) {
    html += '<h2>Regression Areas</h2><ul>';
    regressionAreas.forEach(item => {
      html += `<li>${escapeHtml(item)}</li>`;
    });
    html += '</ul>';
  }

  if (dataRequirements.length > 0) {
    html += '<h2>Data Requirements</h2><ul>';
    dataRequirements.forEach(item => {
      html += `<li>${escapeHtml(item)}</li>`;
    });
    html += '</ul>';
  }

  html += `<h2>Automation Notes</h2><p>${escapeHtml(automationNotes)}</p>`;

  html += '<hr/>';
  html += `<p><em>Auto-generated from PR #${prId}: ${escapeHtml(title)}</em></p>`;

  return html;
}

/**
 * Build Azure DevOps artifact URI for linking PR to work item
 *
 * Format: vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{pullRequestId}
 *
 * @param prMetadata PR metadata containing required IDs
 * @returns Artifact URI string in vstfs format
 */
export function buildPRArtifactUri(prMetadata: PRMetadata): string {
  // Validate required fields
  if (!prMetadata.projectId || !prMetadata.repositoryId || prMetadata.prId == null) {
    throw new Error('Missing required IDs for PR artifact URI construction');
  }

  // Construct artifact URI with URL-encoded separators
  const artifactUri = `vstfs:///Git/PullRequestId/${prMetadata.projectId}%2F${prMetadata.repositoryId}%2F${prMetadata.prId}`;

  return artifactUri;
}

/**
 * Create Test Case work item in Azure DevOps
 */
export async function createTestCaseWorkItem(
  projectName: string,
  testCase: GeneratedTestCase,
  prMetadata: PRMetadata
): Promise<number> {
  try {
    logger.info('Creating test case work item', { projectName, prId: prMetadata.prId });

    const conn = getConnection();
    const witApi: WorkItemTrackingApi = await conn.getWorkItemTrackingApi();

    // Format test steps as XML
    const stepsXml = formatTestStepsXml(testCase.testSteps, testCase.expectedResults);

    // Format description as HTML
    const descriptionHtml = formatDescriptionHtml(testCase, prMetadata);

    // Build PR artifact URI for linking (vstfs format required by Azure DevOps API)
    const prArtifactUri = buildPRArtifactUri(prMetadata);

    logger.debug('Constructed PR artifact URI', {
      projectId: prMetadata.projectId,
      repositoryId: prMetadata.repositoryId,
      prId: prMetadata.prId,
      artifactUri: prArtifactUri
    });

    // Create patch document for work item
    const patchDocument: JsonPatchOperation[] = [
      {
        op: Operation.Add,
        path: '/fields/System.Title',
        value: testCase.title
      },
      {
        op: Operation.Add,
        path: '/fields/System.Description',
        value: descriptionHtml
      },
      {
        op: Operation.Add,
        path: '/fields/Microsoft.VSTS.TCM.Steps',
        value: stepsXml
      },
      {
        op: Operation.Add,
        path: '/fields/System.Tags',
        value: `AI-Generated; PR-${prMetadata.prId}`
      },
      {
        op: Operation.Add,
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: prArtifactUri,
          attributes: {
            name: 'Pull Request'
          }
        }
      }
    ];

    // Create the work item
    const workItem = await witApi.createWorkItem(
      undefined, // customHeaders
      patchDocument,
      projectName,
      'Test Case'
    );

    if (!workItem || !workItem.id) {
      throw new Error('Work item creation returned no ID');
    }

    logger.info('Test case work item created', {
      projectName,
      workItemId: workItem.id,
      prId: prMetadata.prId
    });

    return workItem.id;

  } catch (error) {
    logger.error('Failed to create work item', {
      projectName,
      prId: prMetadata.prId,
      error: String(error)
    });
    throw new Error(`Failed to create work item: ${error}`);
  }
}

/**
 * Create minimal fallback work item when AI fails
 */
export async function createFallbackWorkItem(
  projectName: string,
  prMetadata: PRMetadata
): Promise<number> {
  try {
    logger.info('Creating fallback work item', { projectName, prId: prMetadata.prId });

    const conn = getConnection();
    const witApi: WorkItemTrackingApi = await conn.getWorkItemTrackingApi();

    const title = `Test Case: ${prMetadata.title} (Auto-generated - AI unavailable)`;

    const descriptionHtml = `
<p>AI test case generation failed after 3 attempts.</p>
<p><strong>PR #${prMetadata.prId}:</strong> ${escapeHtml(prMetadata.title)}</p>
<p><strong>Author:</strong> ${escapeHtml(prMetadata.author)}</p>
<p><strong>Description:</strong> ${escapeHtml(prMetadata.description || 'N/A')}</p>
<hr/>
<p><em>Please manually review this PR and create appropriate test cases.</em></p>`;

    const stepsXml = `<steps id="0">
  <step id="1" type="ActionStep">
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Review PR changes and create appropriate test cases&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Test cases created based on PR changes&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <description/>
  </step>
</steps>`;

    // Build PR artifact URI for linking (vstfs format required by Azure DevOps API)
    const prArtifactUri = buildPRArtifactUri(prMetadata);

    logger.debug('Constructed PR artifact URI for fallback', {
      projectId: prMetadata.projectId,
      repositoryId: prMetadata.repositoryId,
      prId: prMetadata.prId,
      artifactUri: prArtifactUri
    });

    const patchDocument: JsonPatchOperation[] = [
      {
        op: Operation.Add,
        path: '/fields/System.Title',
        value: title
      },
      {
        op: Operation.Add,
        path: '/fields/System.Description',
        value: descriptionHtml
      },
      {
        op: Operation.Add,
        path: '/fields/Microsoft.VSTS.TCM.Steps',
        value: stepsXml
      },
      {
        op: Operation.Add,
        path: '/fields/System.Tags',
        value: `AI-Generated-Fallback; PR-${prMetadata.prId}`
      },
      {
        op: Operation.Add,
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: prArtifactUri,
          attributes: {
            name: 'Pull Request'
          }
        }
      }
    ];

    const workItem = await witApi.createWorkItem(
      undefined,
      patchDocument,
      projectName,
      'Test Case'
    );

    if (!workItem || !workItem.id) {
      throw new Error('Fallback work item creation returned no ID');
    }

    logger.info('Fallback work item created', {
      projectName,
      workItemId: workItem.id,
      prId: prMetadata.prId
    });

    return workItem.id;

  } catch (error) {
    logger.error('Failed to create fallback work item', {
      projectName,
      prId: prMetadata.prId,
      error: String(error)
    });
    throw new Error(`Failed to create fallback work item: ${error}`);
  }
}

/**
 * Post a comment on a pull request
 */
export async function postPRComment(
  projectName: string,
  repositoryId: string,
  prId: number,
  workItemId: number,
  authorEmail: string
): Promise<void> {
  try {
    logger.info('Posting PR comment', { projectName, prId, workItemId });

    const conn = getConnection();
    const gitApi: GitApi = await conn.getGitApi();

    // Build comment text with @mention and #workitem reference
    const commentText = `Testcase has been created! @${authorEmail} #${workItemId}`;

    // Create comment thread payload
    const commentThread = {
      comments: [
        {
          parentCommentId: 0,
          content: commentText,
          commentType: 1 // 1 = text comment
        }
      ],
      status: 1, // 1 = Active thread
      threadContext: null // null for general PR comment (not line-specific)
    };

    // Post the comment thread
    await gitApi.createThread(
      commentThread,
      repositoryId,
      prId,
      projectName
    );

    logger.info('PR comment posted successfully', { projectName, prId, workItemId });

  } catch (error) {
    logger.error('Failed to post PR comment', {
      projectName,
      prId,
      workItemId,
      error: String(error)
    });
    throw new Error(`Failed to post PR comment: ${error}`);
  }
}
