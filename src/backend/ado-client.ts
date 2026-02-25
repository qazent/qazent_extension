/**
 * Azure DevOps API client wrapper
 */

import * as azdev from 'azure-devops-node-api';
import { GitApi } from 'azure-devops-node-api/GitApi';
import { WorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import { JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { CodeDiff, DiffChange, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './utils/logger';

/**
 * Create a new Azure DevOps connection using user's token and organization URL
 * @param token User's OAuth token
 * @param orgUrl Organization URL (e.g., https://dev.azure.com/myorg)
 * @returns Azure DevOps WebApi connection
 */
export function createConnection(token: string, orgUrl: string): azdev.WebApi {
  const authHandler = azdev.getBearerHandler(token);
  const connection = new azdev.WebApi(orgUrl, authHandler);
  logger.debug('Created Azure DevOps connection', { orgUrl });
  return connection;
}



/**
 * GET PR metadata (title, description, author) from Azure DevOps
 */

/**
 * GET PR metadata (title, description, author) from Azure DevOps
 */
export async function fetchPRMetadata(prId: number, connection: azdev.WebApi): Promise<PRMetadata> {
  try {
    logger.info("Fetching PR metadata", { prId });

    const gitApi: GitApi = await connection.getGitApi();

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
      branchName: (sourceBranch?.split('/').pop() ?? "") || "unknown",
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
 * Generate a unified diff with proper hunks, context, and safe truncation.
 */
export function generateUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  maxChars = 8000,          // character budget instead of line count
  contextLines = 4          // lines of context around changes
): { diffContent: string; linesAdded: number; linesDeleted: number } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let linesAdded = 0;
  let linesDeleted = 0;

  const hunks: {
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
    lines: string[];
  }[] = [];

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Start of a hunk
    const hunkStartOld = i;
    const hunkStartNew = j;

    const hunkLines: string[] = [];

    // Collect changed block
    while (i < oldLines.length && j < newLines.length && oldLines[i] !== newLines[j]) {
      hunkLines.push(`- ${oldLines[i]}`);
      hunkLines.push(`+ ${newLines[j]}`);
      linesDeleted++;
      linesAdded++;
      i++;
      j++;
    }

    // Handle trailing additions
    while (j < newLines.length && (i >= oldLines.length)) {
      hunkLines.push(`+ ${newLines[j]}`);
      linesAdded++;
      j++;
    }

    // Handle trailing deletions
    while (i < oldLines.length && (j >= newLines.length)) {
      hunkLines.push(`- ${oldLines[i]}`);
      linesDeleted++;
      i++;
    }

    // Add context lines before
    const contextBeforeStart = Math.max(0, hunkStartOld - contextLines);
    const contextBefore = oldLines.slice(contextBeforeStart, hunkStartOld).map(l => `  ${l}`);

    // Add context lines after
    const contextAfterEnd = Math.min(oldLines.length, i + contextLines);
    const contextAfter = oldLines.slice(i, contextAfterEnd).map(l => `  ${l}`);

    hunks.push({
      oldStart: hunkStartOld + 1,
      newStart: hunkStartNew + 1,
      oldCount: i - hunkStartOld,
      newCount: j - hunkStartNew,
      lines: [...contextBefore, ...hunkLines, ...contextAfter]
    });
  }

  // Build final diff
  let diff = `--- a/${filePath}\n+++ b/${filePath}\n`;

  for (const hunk of hunks) {
    diff += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
    diff += hunk.lines.join("\n") + "\n";

    if (diff.length > maxChars) {
      diff = diff.slice(0, maxChars) + `\n... (diff truncated for AI safety)`;
      break;
    }
  }

  return { diffContent: diff.trim(), linesAdded, linesDeleted };
}

/**
 * Fallback diff fetching when commit IDs are unavailable
 * Returns basic file change information without actual content
 */
export async function fetchPRDiffFallback(
  projectName: string,
  repositoryId: string,
  prId: number,
  connection: azdev.WebApi
): Promise<CodeDiff> {
  logger.info('Using fallback diff fetching', { prId });

  const gitApi: GitApi = await connection.getGitApi();
  const iterations = await gitApi.getPullRequestIterations(repositoryId, prId, projectName);
  if (!iterations || iterations.length === 0) {
    return { changes: [], totalChanges: 0 };
  }

  const latestIteration = iterations[iterations.length - 1];
  const iterationId = latestIteration.id;

  if (!iterationId) {
    return { changes: [], totalChanges: 0 };
  }

  const changes = await gitApi.getPullRequestIterationChanges(repositoryId, prId, iterationId, projectName);

  if (!changes || !changes.changeEntries) {
    return { changes: [], totalChanges: 0 };
  }

  const diffChanges: DiffChange[] = changes.changeEntries.slice(0, 20).map(change => {
    const filePath = change.item?.path || 'unknown';
    let changeType: 'add' | 'edit' | 'delete' = 'edit';

    if (change.changeType) {
      const typeStr = change.changeType.toString().toLowerCase();
      if (typeStr.includes('add')) changeType = 'add';
      else if (typeStr.includes('delete')) changeType = 'delete';
    }

    return {
      filePath,
      changeType,
      linesAdded: changeType === 'add' ? 10 : 5,
      linesDeleted: changeType === 'delete' ? 10 : 3,
      diffContent: `File: ${filePath}\nChange type: ${changeType}\n[Detailed diff unavailable - fallback mode]`
    };
  });

  return {
    changes: diffChanges,
    totalChanges: changes.changeEntries.length
  };
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
 * Create Task work item in Azure DevOps
 */
export async function createTaskWorkItem(
  projectName: string,
  taskOutput: TaskWorkItemOutput,
  prMetadata: PRMetadata,
  connection: azdev.WebApi
): Promise<number> {
  try {
    logger.info('Creating task work item', { projectName, prId: prMetadata.prId });

    const witApi: WorkItemTrackingApi = await connection.getWorkItemTrackingApi();

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
        value: taskOutput.title
      },
      {
        op: Operation.Add,
        path: '/fields/System.Description',
        value: taskOutput.htmlDescription
      },
      {
        op: Operation.Add,
        path: '/fields/System.Tags',
        value: `AI-Generated; PR-${prMetadata.prId}`
      },
      // Link work item to PR using artifact URI
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
      'Task'
    );

    if (!workItem || !workItem.id) {
      throw new Error('Work item creation returned no ID');
    }

    logger.info('Task work item created', {
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
  prMetadata: PRMetadata,
  connection: azdev.WebApi
): Promise<number> {
  try {
    logger.info('Creating fallback work item', { projectName, prId: prMetadata.prId });

    const witApi: WorkItemTrackingApi = await connection.getWorkItemTrackingApi();

    const title = `Test Case: ${prMetadata.title} (Auto-generated - AI unavailable)`;

    const descriptionHtml = `
<p>AI test case generation failed after multiple attempts.</p>
<p><strong>PR #${prMetadata.prId}:</strong> ${escapeHtml(prMetadata.title)}</p>
<p><strong>Author:</strong> ${escapeHtml(prMetadata.author)}</p>
<p><strong>Description:</strong> ${escapeHtml(prMetadata.description || 'N/A')}</p>
<hr/>
<p><em>Please manually review this PR and create appropriate test cases.</em></p>`;

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
      'Task'
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
  connection: azdev.WebApi
): Promise<void> {
  try {
    logger.info('Posting PR comment', { projectName, prId, workItemId });

    const gitApi: GitApi = await connection.getGitApi();

    // Build comment text with @mention and #workitem reference
    const commentText = `Testcase workitem has been created! #${workItemId}`;

    // Create comment thread payload
    const commentThread = {
      comments: [
        {
          parentCommentId: 0,
          content: commentText,
          commentType: 1 // 1 = text comment
        }
      ],
      status: 1 // 1 = Active thread
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
