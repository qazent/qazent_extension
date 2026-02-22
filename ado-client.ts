/**
 * Azure DevOps API client wrapper
 */

import * as azdev from 'azure-devops-node-api';
import { GitApi } from 'azure-devops-node-api/GitApi';
 import { GitVersionType, GitVersionDescriptor } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { WorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import { JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { CodeDiff, DiffChange, PRMetadata, TaskWorkItemOutput } from './types';
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
 * Generate unified diff format from two text contents
 */
function generateUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string
): { diffContent: string; linesAdded: number; linesDeleted: number } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diffLines: string[] = [];
  let linesAdded = 0;
  let linesDeleted = 0;

  // Simple line-by-line comparison
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];

    if (oldLine === newLine) {
      // Unchanged line - show context (limit to 3 lines before and after changes)
      if (diffLines.length < 3 || diffLines.length > oldLines.length - 3) {
        diffLines.push(`  ${oldLine || ''}`);
      }
      oldIndex++;
      newIndex++;
    } else if (oldIndex >= oldLines.length) {
      // Only new lines remain (additions at end)
      diffLines.push(`+ ${newLine || ''}`);
      linesAdded++;
      newIndex++;
    } else if (newIndex >= newLines.length) {
      // Only old lines remain (deletions at end)
      diffLines.push(`- ${oldLine || ''}`);
      linesDeleted++;
      oldIndex++;
    } else {
      // Lines differ - mark as delete old and add new
      diffLines.push(`- ${oldLine || ''}`);
      diffLines.push(`+ ${newLine || ''}`);
      linesDeleted++;
      linesAdded++;
      oldIndex++;
      newIndex++;
    }
  }

  // Limit diff output to prevent overwhelming AI (max 100 lines per file)
  const truncatedDiff = diffLines.slice(0, 100);
  const wasTruncated = diffLines.length > 100;

  let diffContent = `--- a/${filePath}\n+++ b/${filePath}\n`;
  diffContent += truncatedDiff.join('\n');
  if (wasTruncated) {
    diffContent += `\n... (${diffLines.length - 100} more lines truncated)`;
  }

  return { diffContent, linesAdded, linesDeleted };
}

/**
 * GET PR diff from Azure DevOps with real file content
 *
 * This function retrieves actual line-by-line diffs for PR changes using the Git Items API.
 * It fetches file contents at both source and target commits and generates unified diffs.
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

    // Step 1: Get PR details to find source and target commits
    const pr = await gitApi.getPullRequest(repositoryId, prId, projectName);

    if (!pr || !pr.lastMergeSourceCommit || !pr.lastMergeTargetCommit) {
      logger.warn('PR missing commit information, falling back to iteration changes', { prId });
      return fetchPRDiffFallback(projectName, repositoryId, prId, gitApi);
    }

    const sourceCommitId = pr.lastMergeSourceCommit.commitId;
    const targetCommitId = pr.lastMergeTargetCommit.commitId;

    logger.debug('PR commit IDs', { prId, sourceCommitId, targetCommitId });
    
    // Prepare version descriptors for API calls
    const sourceDescriptor: GitVersionDescriptor = {
      version: sourceCommitId,
      versionType: GitVersionType.Commit
    };

    const targetDescriptor: GitVersionDescriptor = {
      version: targetCommitId,
      versionType: GitVersionType.Commit
    };


    // Step 2: Get PR iterations to find changed files
    const iterations = await gitApi.getPullRequestIterations(repositoryId, prId, projectName);

    if (!iterations || iterations.length === 0) {
      throw new Error(`No iterations found for PR ${prId}`);
    }

    const latestIteration = iterations[iterations.length - 1];
    const iterationId = latestIteration.id;
    

    if (!iterationId) {
      throw new Error('Latest iteration has no ID');
    }

    // Step 3: Get list of changed files
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
    const MAX_FILES = 20; // Limit files to prevent overwhelming AI and API rate limits

    // Step 4: Process each changed file and fetch actual content
    for (const change of changes.changeEntries.slice(0, MAX_FILES)) {
      if (!change.item?.path) {
        continue;
      }

      const filePath = change.item.path;
      let changeType: 'add' | 'edit' | 'delete' = 'edit';

      if (change.changeType) {
        const changeTypeStr = change.changeType.toString().toLowerCase();
        if (changeTypeStr.includes('add')) {
          changeType = 'add';
        } else if (changeTypeStr.includes('delete')) {
          changeType = 'delete';
        }
      }

      let diffContent = '';
      let linesAdded = 0;
      let linesDeleted = 0;

      try {
        if (changeType === 'delete') {
          // For deleted files, fetch old content only
          logger.debug("Fetching olditem", {
          filePath,
          commitId: targetCommitId,
          descriptor: targetDescriptor
        });
          const oldItem = await gitApi.getItem(
            repositoryId,
            filePath,
            projectName,
            undefined, // scopePath
            undefined, // recursionLevel
            undefined, // includeContentMetadata
            undefined, // latestProcessedChange
            undefined, // download
            targetDescriptor // versionDescriptor - target (before PR)
          );

          const oldContent = oldItem.content || '[Binary or empty file]';
          linesDeleted = oldContent.split('\n').length;
          diffContent = `--- a/${filePath}\n+++ /dev/null\n${oldContent.split('\n').map(line => `- ${line}`).slice(0, 50).join('\n')}`;

        } else if (changeType === 'add') {
          // For added files, fetch new content only
          logger.debug("Fetching newitem", {
            filePath,
            commitId: sourceCommitId,
            descriptor: sourceDescriptor
          });

          const newItem = await gitApi.getItem(
            repositoryId,
            filePath,
            projectName,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            sourceDescriptor // versionDescriptor - source (after PR)
          );

          const newContent = newItem.content || '[Binary or empty file]';
          linesAdded = newContent.split('\n').length;
          diffContent = `--- /dev/null\n+++ b/${filePath}\n${newContent.split('\n').map(line => `+ ${line}`).slice(0, 50).join('\n')}`;

        } else {
          logger.info("Fetching bot old and newitem", {
          filePath,
          commitId: targetCommitId,
          descriptor: targetDescriptor
        });
          // For edited files, fetch both old and new content
          const [oldItem, newItem] = await Promise.all([
            gitApi.getItem(repositoryId, filePath, projectName, undefined, undefined, undefined, undefined, undefined, targetDescriptor),
            gitApi.getItem(repositoryId, filePath, projectName, undefined, undefined, undefined, undefined, undefined, sourceDescriptor),
            logger.debug("getItem response", {
            filePath,
            commitId: targetCommitId,
            item: sourceDescriptor
          }),
          ]);

          const oldContent = oldItem.content || '';
          const newContent = newItem.content || '';

          // Generate unified diff
          const diff = generateUnifiedDiff(filePath, oldContent, newContent);
          diffContent = diff.diffContent;
          linesAdded = diff.linesAdded;
          linesDeleted = diff.linesDeleted;
        }

      } catch (diffError) {
        logger.warn('Failed to fetch content for file, using fallback', { filePath, error: String(diffError) });
        // Fallback to basic change info
        diffContent = `File: ${filePath}\nChange type: ${changeType}\n[Content fetch failed - possibly binary file or access restricted]`;
        linesAdded = changeType === 'add' ? 10 : 5;
        linesDeleted = changeType === 'delete' ? 10 : 3;
      }

      diffChanges.push({
        filePath,
        changeType,
        linesAdded,
        linesDeleted,
        diffContent
      });
    }

    if (changes.changeEntries.length > MAX_FILES) {
      logger.warn('Truncated diff to prevent overwhelming AI', {
        prId,
        totalFiles: changes.changeEntries.length,
        included: MAX_FILES
      });
    }

    logger.info('PR diff fetched successfully with real content', {
      prId,
      filesChanged: diffChanges.length,
      totalChanges: changes.changeEntries.length,
      linesAdded: diffChanges.reduce((sum, c) => sum + c.linesAdded, 0),
      linesDeleted: diffChanges.reduce((sum, c) => sum + c.linesDeleted, 0)
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
 * Fallback diff fetching when commit IDs are unavailable
 * Returns basic file change information without actual content
 */
async function fetchPRDiffFallback(
  projectName: string,
  repositoryId: string,
  prId: number,
  gitApi: GitApi
): Promise<CodeDiff> {
  logger.info('Using fallback diff fetching', { prId });

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
  prMetadata: PRMetadata
): Promise<number> {
  try {
    logger.info('Creating task work item', { projectName, prId: prMetadata.prId });

    const conn = getConnection();
    const witApi: WorkItemTrackingApi = await conn.getWorkItemTrackingApi();

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
  prMetadata: PRMetadata
): Promise<number> {
  try {
    logger.info('Creating fallback work item', { projectName, prId: prMetadata.prId });

    const conn = getConnection();
    const witApi: WorkItemTrackingApi = await conn.getWorkItemTrackingApi();

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

): Promise<void> {
  try {
    logger.info('Posting PR comment', { projectName, prId, workItemId });

    const conn = getConnection();
    const gitApi: GitApi = await conn.getGitApi();

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
