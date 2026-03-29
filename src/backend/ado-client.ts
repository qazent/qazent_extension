/**
 * Azure DevOps API client wrapper
 */

import * as azdev from 'azure-devops-node-api';
import { GitApi } from 'azure-devops-node-api/GitApi';
import { WorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import { JsonPatchOperation, Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { CodeDiff, DiffChange, DiffChangeType, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './utils/logger';
import { sanitizeHTML } from './utils/sanitize-html';
import {
  classifyChangeType,
  countContentLines,
  DIFF_CONTEXT_LINES,
  DIFF_MAX_CHARS_PER_FILE,
  getFallbackLineMetrics,
  ITERATION_CHANGES_PAGE_SIZE,
  MAX_SYNTHETIC_DIFF_LINES,
  normalizeDiffPath,
} from './diff-config';

/**
 * Create a new Azure DevOps connection using the user's access token and organization URL
 * @param token User access token from SDK.getAccessToken()
 * @param orgUrl Organization URL (e.g., https://dev.azure.com/myorg)
 * @returns Azure DevOps WebApi connection
 */
export function createConnection(token: string, orgUrl: string): azdev.WebApi {
  // Use BearerHandler for Azure DevOps access tokens from the extension.
  const authHandler = azdev.getBearerHandler(token);
  const connection = new azdev.WebApi(orgUrl, authHandler);
  logger.debug('Created Azure DevOps connection', {
    orgUrl,
    authMethod: 'Bearer',
    tokenPresent: Boolean(token),
    tokenLength: token?.length,
  });
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
  maxChars = DIFF_MAX_CHARS_PER_FILE,
  contextLines = DIFF_CONTEXT_LINES
): { diffContent: string; linesAdded: number; linesDeleted: number } {
  const diffPath = normalizeDiffPath(filePath);
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
  let diff = `--- a/${diffPath}\n+++ b/${diffPath}\n`;

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

export function generateSyntheticFileDiff(
  filePath: string,
  content: string,
  changeType: DiffChangeType,
  maxChars = DIFF_MAX_CHARS_PER_FILE,
  maxLines = MAX_SYNTHETIC_DIFF_LINES
): { diffContent: string; linesAdded: number; linesDeleted: number } {
  const diffPath = normalizeDiffPath(filePath);
  const lines = content.length === 0 ? [] : content.split('\n');
  const linePrefix = changeType === 'delete' ? '- ' : '+ ';
  const header =
    changeType === 'delete'
      ? `--- a/${diffPath}\n+++ /dev/null\n`
      : `--- /dev/null\n+++ b/${diffPath}\n`;
  const selectedRanges = selectSalientSyntheticRanges(lines, maxLines);
  const shownLineCount = selectedRanges.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
  const omittedLines = Math.max(0, lines.length - shownLineCount);

  let diffContent = header;
  if (selectedRanges.length === 0) {
    diffContent = header.trimEnd();
  } else {
    const hunks = selectedRanges.map((range) => {
      const rangeLines = lines.slice(range.start, range.end + 1).map((line) => `${linePrefix}${line}`).join('\n');
      const oldStart = changeType === 'delete' ? range.start + 1 : 0;
      const oldCount = changeType === 'delete' ? range.end - range.start + 1 : 0;
      const newStart = changeType === 'add' ? range.start + 1 : 0;
      const newCount = changeType === 'add' ? range.end - range.start + 1 : 0;
      return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${rangeLines}`;
    });
    diffContent += hunks.join('\n');
  }
  if (omittedLines > 0) {
    diffContent += `\n... (${omittedLines} more lines omitted, selected the most relevant regions)`;
  }
  if (diffContent.length > maxChars) {
    diffContent = diffContent.slice(0, maxChars).trimEnd() + '\n... (diff truncated for AI safety)';
  }

  return {
    diffContent: diffContent.trim(),
    linesAdded: changeType === 'add' ? countContentLines(content) : 0,
    linesDeleted: changeType === 'delete' ? countContentLines(content) : 0,
  };
}

function selectSalientSyntheticRanges(
  lines: string[],
  maxLines: number
): Array<{ start: number; end: number }> {
  if (lines.length === 0 || maxLines <= 0) {
    return [];
  }
  if (lines.length <= Math.min(maxLines, 20)) {
    return [{ start: 0, end: lines.length - 1 }];
  }

  const declarationPatterns = [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
    /^\s*(export\s+)?(abstract\s+)?class\b/,
    /^\s*(export\s+)?interface\b/,
    /^\s*(export\s+)?type\b/,
    /^\s*(export\s+)?enum\b/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?(function\b|\()/,
    /^\s*(app|router)\.(get|post|put|patch|delete|use)\b/,
    /^\s*(describe|it|test)\s*\(/,
    /^\s*@\w+/,
  ];

  const preferredStarts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (declarationPatterns.some((pattern) => pattern.test(line))) {
      preferredStarts.push(index);
    }
  }

  const fallbackStart = findFirstMeaningfulLine(lines);
  if (preferredStarts.length === 0 && fallbackStart >= 0) {
    preferredStarts.push(fallbackStart);
  } else if (fallbackStart >= 0) {
    preferredStarts.unshift(fallbackStart);
  }

  const windowBefore = 2;
  const windowAfter = 12;
  const candidateRanges = preferredStarts.map((start) => ({
    start: Math.max(0, start - windowBefore),
    end: Math.min(lines.length - 1, start + windowAfter),
  }));

  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const range of candidateRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.start <= previous.end + 2) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    mergedRanges.push({ ...range });
  }

  const selectedRanges: Array<{ start: number; end: number }> = [];
  let usedLines = 0;
  for (const range of mergedRanges) {
    const rangeLength = range.end - range.start + 1;
    if (usedLines >= maxLines) {
      break;
    }
    if (usedLines + rangeLength <= maxLines) {
      selectedRanges.push(range);
      usedLines += rangeLength;
      continue;
    }

    const remainingLines = maxLines - usedLines;
    if (remainingLines <= 0) {
      break;
    }

    selectedRanges.push({
      start: range.start,
      end: range.start + remainingLines - 1,
    });
    usedLines += remainingLines;
    break;
  }

  if (selectedRanges.length === 0 && fallbackStart >= 0) {
    selectedRanges.push({
      start: fallbackStart,
      end: Math.min(lines.length - 1, fallbackStart + maxLines - 1),
    });
  }

  return selectedRanges;
}

function findFirstMeaningfulLine(lines: string[]): number {
  let inLeadingImportBlock = true;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || trimmed === '{' || trimmed === '}') {
      continue;
    }

    if (
      inLeadingImportBlock &&
      (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('export {') ||
        trimmed.startsWith('export *') ||
        trimmed.startsWith("'use ") ||
        trimmed.startsWith('"use ') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*')
      )
    ) {
      continue;
    }

    inLeadingImportBlock = false;
    return index;
  }

  return lines.findIndex((line) => line.trim().length > 0);
}

export async function fetchAllIterationChangeEntries(
  gitApi: GitApi,
  repositoryId: string,
  prId: number,
  iterationId: number,
  projectName: string
): Promise<any[]> {
  const entries: any[] = [];
  let skip = 0;

  while (true) {
    const page = await (gitApi as any).getPullRequestIterationChanges(
      repositoryId,
      prId,
      iterationId,
      projectName,
      ITERATION_CHANGES_PAGE_SIZE,
      skip
    );
    const pageEntries = page?.changeEntries ?? [];
    entries.push(...pageEntries);

    if (pageEntries.length < ITERATION_CHANGES_PAGE_SIZE) {
      break;
    }

    skip += pageEntries.length;
  }

  return entries;
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

  const changeEntries = await fetchAllIterationChangeEntries(gitApi, repositoryId, prId, iterationId, projectName);

  if (changeEntries.length === 0) {
    return { changes: [], totalChanges: 0 };
  }

  const diffChanges: DiffChange[] = changeEntries.slice(0, 20).map(change => {
    const filePath = change.item?.path || 'unknown';
    const changeType = classifyChangeType(change.changeType);
    const fallbackMetrics = getFallbackLineMetrics(changeType);

    return {
      filePath,
      changeType,
      linesAdded: fallbackMetrics.linesAdded,
      linesDeleted: fallbackMetrics.linesDeleted,
      diffContent: `File: ${filePath}\nChange type: ${changeType}\n[Detailed diff unavailable - fallback mode]`
    };
  });

  return {
    changes: diffChanges,
    totalChanges: changeEntries.length,
    truncatedChanges: Math.max(0, changeEntries.length - diffChanges.length),
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
    const sanitizedDescription = sanitizeHTML(taskOutput.htmlDescription, {
      source: 'ado.createTaskWorkItem',
      prId: prMetadata.prId,
      projectName,
    });

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
        value: sanitizedDescription
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

    const descriptionHtml = sanitizeHTML(`
<p>AI test case generation failed after multiple attempts.</p>
<p><strong>PR #${prMetadata.prId}:</strong> ${escapeHtml(prMetadata.title)}</p>
<p><strong>Author:</strong> ${escapeHtml(prMetadata.author)}</p>
<p><strong>Description:</strong> ${escapeHtml(prMetadata.description || 'N/A')}</p>
<hr/>
<p><em>Please manually review this PR and create appropriate test cases.</em></p>`, {
      source: 'ado.createFallbackWorkItem',
      prId: prMetadata.prId,
      projectName,
    });

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
   // --- POST PR LABEL VAULTED ---
   // export async function postPRLabel({
   //   projectName,
   //   repositoryId,
   //   prId,
   //   connection,
   //   labelName
   // }: {
   //   projectName: string;
   //   repositoryId: string;
   //   prId: number;
   //   connection: azdev.WebApi;
   //   labelName: string;
   // }): Promise<void> {
   //   logger.info("Posting PR label", { projectName, prId, labelName });
   //   try {
   //     const gitApi: GitApi = await connection.getGitApi();
   //     const prLabel = { name: labelName };
   //     await gitApi.createPullRequestLabel(prLabel, repositoryId, prId, projectName);
   //     logger.info("PR label posted successfully", { projectName, prId, labelName });
   //   } catch (error) {
   //     logger.error("Failed to post PR label", { projectName, prId, labelName, error: String(error) });
   //   }
   // }
      /**
       * Post a comment on a pull request
       */
      export async function postPRComment({
        projectName,
        repositoryId,
        prId,
        workItemId,
        connection,
        commentContent
      }: {
        projectName: string;
        repositoryId: string;
        prId: number;
        workItemId: number;
        connection: azdev.WebApi;
        commentContent?: string;
      }): Promise<void> {
        try {
        logger.info('Posting PR comment', { projectName, prId, workItemId });

        const gitApi: GitApi = await connection.getGitApi();

        const commentText =
          sanitizeHTML(commentContent ?? `Testcase workitem has been created! #${workItemId}`, {
            source: 'ado.postPRComment',
            prId,
            projectName,
            workItemId,
          });

        const commentThread = {
          comments: [
            {
              parentCommentId: 0,
              content: commentText,
              commentType: 1
            }
          ],
          status: 1
        };

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
      throw new Error(`Failed to post PR comment: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
        
export { DIFF_MAX_CHARS_PER_FILE };

