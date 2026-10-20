import fetch from "node-fetch";
import { CodeDiff, DiffChange, } from './types';
import * as logger from './utils/logger';
import {
  fetchAllIterationChangeEntries,
  fetchPRDiffFallback,
  generateSyntheticFileDiff,
  generateUnifiedDiff,
} from "./ado-client";
import { GitApi } from 'azure-devops-node-api/GitApi';
import * as azdev from 'azure-devops-node-api';
import { classifyChangeType, fileLineCounts, getFallbackLineMetrics, MAX_FILES_FOR_AI } from './diff-config';
function isMissingFileError(error: unknown): boolean {
  const message = String(error);
  return message.includes('REST getItem failed (404') || message.includes('TF401174');
}





export async function fetchFileContentFromRest(
  organization: string,
  projectName: string,
  repositoryId: string,
  filePath: string,
  commitId: string,
  token: string
): Promise<string> {
  if (!organization) {
  throw new Error(`Organization is undefined. URL would be invalid.`);
}
  const url =
    `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(projectName)}` +
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items` +
    `?path=${encodeURIComponent(filePath)}` +
    `&versionDescriptor.version=${encodeURIComponent(commitId)}` +
    `&versionDescriptor.versionType=commit` +
    `&includeContent=true` +
    `&api-version=7.1-preview.1`;

  logger.debug("Fetching file content via REST", {
    organization, projectName, repositoryId, filePath, commitId, url,
    authMethod: 'Bearer',
    tokenPresent: Boolean(token),
    tokenLength: token?.length
  });

  const response = await fetch(url, {
    headers: {
      // Pass the Azure DevOps access token through as an opaque bearer token.
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn("REST getItem failed", {
      status: response.status,
      statusText: response.statusText,
      filePath,
      organization,
      tokenPresent: Boolean(token),
      tokenLength: token?.length,
      responseBody: text.substring(0, 200)
    });
    throw new Error(
      `REST getItem failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  // When includeContent=true and format is default, Azure DevOps returns raw text
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    // Some responses may wrap content in JSON; handle defensively
    const json = (await response.json()) as any;

      if (typeof json.content === "string") {
        // fallback to content property if it exists, otherwise return entire JSON as string
        return json.content;
}

return JSON.stringify(json, null, 2);
  }

  return await response.text();
}

/**
 * GET PR diff from Azure DevOps with real file content
 *
 * This function retrieves actual line-by-line diffs for PR changes using the Git Items REST API.
 * It fetches file contents at both source and target commits and generates unified diffs.
 */
export async function fetchPRDiff(
  projectName: string,
  repositoryId: string,
  prId: number,
  connection: azdev.WebApi,
  organization: string,
  token: string
): Promise<CodeDiff> {
  try {
    logger.info("Fetching PR diff", {
      projectName, repositoryId, prId, organization,
      tokenPresent: Boolean(token),
      tokenLength: token?.length
    });

    const gitApi: GitApi = await connection.getGitApi();

    // Step 1: Get PR details to find source and target commits
    const pr = await gitApi.getPullRequest(repositoryId, prId, projectName);

    if (!pr || !pr.lastMergeSourceCommit || !pr.lastMergeTargetCommit) {
      logger.warn("PR missing commit information, falling back to iteration changes", { prId });
      // FALLBACK IF COMMIT INFO IS INVALID:
      return fetchPRDiffFallback(projectName, repositoryId, prId, connection);

    }

    const sourceCommitId = pr.lastMergeSourceCommit.commitId!;
    const targetCommitId = pr.lastMergeTargetCommit.commitId!;

    logger.debug("PR commit IDs", { prId, sourceCommitId, targetCommitId });

    // Step 2: Get PR iterations to find changed files
    const iterations = await gitApi.getPullRequestIterations(repositoryId, prId, projectName);

    if (!iterations || iterations.length === 0) {
      throw new Error(`No iterations found for PR ${prId}`);
    }

    const latestIteration = iterations[iterations.length - 1];
    const iterationId = latestIteration.id;
    const firstComparingIteration = iterations[0]?.id;

    if (!iterationId) {
      throw new Error("Latest iteration has no ID");
    }

    // Step 3: Get list of changed files
    const changeEntries = await fetchAllIterationChangeEntries(
      gitApi,
      repositoryId,
      prId,
      iterationId,
      projectName
    );

    if (changeEntries.length === 0) {
      logger.warn("No changes found in PR", { prId });
      return {
        changes: [],
        totalChanges: 0,
        latestIterationId: iterationId,
        ...(typeof firstComparingIteration === 'number' ? { firstComparingIteration } : {}),
      };
    }

    const diffChanges: DiffChange[] = [];
    // Step 4: Process each changed file and fetch actual content via REST


    // List of file extensions to ignore (case-insensitive, include the dot)
    const ignoredExtensions = [
      // Markdown
      '.md',
      // Binary media files
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
      '.mp4', '.mov', '.avi',
      '.mp3', '.wav', '.flac',
      // Compiled or generated artifacts
      '.dll', '.exe', '.so', '.dylib',
      '.class', '.jar', '.war',
      '.pyc',
      '.o', '.obj',
      '.wasm',
      // Archives and containers
      '.zip', '.tar', '.gz', '.7z', '.rar',
      '.iso',
      // Design and proprietary binary formats
      '.psd', '.ai', '.fig', '.sketch',
      '.docx', '.xlsx', '.pptx',
      // Large data blobs
      '.csv', '.bin', '.dat', '.db', '.sqlite',
      // log files and temporary files
       '.log', '.tmp', '.temp' ,'.cache', '.bak' ,'pid', '.coverage',
      //  Metadata and config files that are often not relevant for test generation
      '.lock', '.map', '.min.js', '.min.css', '.g.dart',
      '.DS_Store', 'Thumbs.db',
      '.swp', '.swo',
      '.orig', '.rej',
      '.pdb',
      '.tsbuildinfo',
      '.coverage.*',
      '.generated', '.gen', '.auto'
    ];

    // List of directory patterns to ignore (case-insensitive, trailing slash)
    const ignoredDirs = ['dist/', 'build/', 'out/', 'bin/', 'obj/', 'node_modules/', 'vendor/', 'logs/', 'temp/', 'cache/', 'coverage/', '.vscode/', 'svelte-kit',
       '.idea/', '.gradle/', '.mvn/', '.pytest_cache/', '.nyc_output/','.sass-cache/', '.parcel-cache/', '.eslintcache/','.next/', '.nuxt/', '.angular/', '.vite/',
        '.storybook-static/', '.expo/','__pycache__/', 'target/', 'gen/'];

    const includedEntries = [];
    let filteredChanges = 0;

    for (const change of changeEntries) {
      if (!change.item?.path) {
        continue;
      }

      const filePath = change.item.path;
      // Skip files with ignored extensions or in ignored directories !!! Reduce noise in PR summaries
      const lowerFilePath = filePath.toLowerCase();
      if (
        ignoredExtensions.some(ext => lowerFilePath.endsWith(ext)) ||
        ignoredDirs.some(dir => lowerFilePath.includes(`/${dir}`) || lowerFilePath.startsWith(dir))
      ) {
        logger.info('Skipping file from diff/AI analysis due to ignored extension or directory', { filePath });
        filteredChanges++;
        continue;
      }

      includedEntries.push(change);
    }

    const truncatedChanges = Math.max(0, includedEntries.length - MAX_FILES_FOR_AI);

    for (const change of includedEntries.slice(0, MAX_FILES_FOR_AI)) {
      const filePath = change.item?.path;
      if (!filePath) {
        continue;
      }

      let changeType = classifyChangeType(change.changeType);

      let diffContent = "";
      let linesAdded = 0;
      let linesDeleted = 0;
      let oldContent: string | undefined;
      let newContent: string | undefined;

      try {
        if (changeType === "delete") {
          // For deleted files, fetch old content only (target commit = before PR)
          logger.debug("Fetching old content via REST for deleted file", {
            filePath,
            commitId: targetCommitId,
          });

          // Validate parameters before calling REST
          if (!organization) {
            throw new Error(`Organization is undefined. Cannot fetch file content.`);
          }

          if (!projectName) {
            throw new Error(`projectName is undefined for file ${filePath}`);
          }

          if (!repositoryId) {
            throw new Error(`repositoryId is undefined for file ${filePath}`);
          }

          if (!targetCommitId) {
            throw new Error(`targetCommitId is undefined for file ${filePath}`);
          }

          // Fetch old content (deleted file)
          oldContent = await fetchFileContentFromRest(
            organization,
            projectName,
            repositoryId,
            filePath,
            targetCommitId,
            token
          );

          // Validate returned content
          if (oldContent == null) {
            throw new Error(`fetchFileContentFromRest returned empty content for ${filePath}`);
          }

          if (oldContent.startsWith("<!DOCTYPE html") || oldContent.includes("<script class=\"options\"")) {
            throw new Error(
              `Azure DevOps returned HTML login page instead of file content for ${filePath}. ` +
              `Check PAT, org, project, and URL.`
            );
          }

          const syntheticDiff = generateSyntheticFileDiff(filePath, oldContent, "delete");
          diffContent = syntheticDiff.diffContent;
          linesDeleted = syntheticDiff.linesDeleted;

        } else if (changeType === "add") {
          // For added files, fetch new content only (source commit = after PR)
          logger.debug("Fetching new content via REST for added file", {
            filePath,
            commitId: sourceCommitId,
          });

          if (!organization) throw new Error("Organization is undefined");
          if (!sourceCommitId) throw new Error(`sourceCommitId undefined for ${filePath}`);

          newContent = await fetchFileContentFromRest(
            organization,
            projectName,
            repositoryId,
            filePath,
            sourceCommitId,
            token
          );

          if (newContent == null) {
            throw new Error(`fetchFileContentFromRest returned empty content for ${filePath}`);
          }

          if (newContent.startsWith("<!DOCTYPE html") || newContent.includes("<script class=\"options\"")) {
            throw new Error(
              `Azure DevOps returned HTML login page instead of file content for ${filePath}.`
            );
          }

          const syntheticDiff = generateSyntheticFileDiff(filePath, newContent, "add");
          diffContent = syntheticDiff.diffContent;
          linesAdded = syntheticDiff.linesAdded;
        } else {
          // For edited files, fetch both old and new content
          logger.info("Fetching old and new content via REST for edited file", {
            filePath,
            targetCommitId,
            sourceCommitId,
          });

          const [oldContentResult, newContentResult] = await Promise.allSettled([
            fetchFileContentFromRest(
              organization,
              projectName,
              repositoryId,
              filePath,
              targetCommitId,
              token
            ),
            fetchFileContentFromRest(
              organization,
              projectName,
              repositoryId,
              filePath,
              sourceCommitId,
              token
            ),
          ]);

          const oldContentAvailable = oldContentResult.status === 'fulfilled';
          const newContentAvailable = newContentResult.status === 'fulfilled';
          const oldContentMissing = oldContentResult.status === 'rejected' && isMissingFileError(oldContentResult.reason);
          const newContentMissing = newContentResult.status === 'rejected' && isMissingFileError(newContentResult.reason);

          if (oldContentAvailable && newContentAvailable) {
            oldContent = oldContentResult.value || "";
            newContent = newContentResult.value || "";

            const diff = generateUnifiedDiff(filePath, oldContent, newContent);
            diffContent = diff.diffContent;
            linesAdded = diff.linesAdded;
            linesDeleted = diff.linesDeleted;
            if (diffContent.includes('diff truncated for AI safety')) {
              logger.warn('Unified diff truncated before prompt construction', {
                filePath,
                linesAdded,
                linesDeleted,
                diffChars: diffContent.length,
              });
            }
          } else if (oldContentMissing && newContentAvailable) {
            changeType = "add";
            newContent = newContentResult.value;
            const syntheticDiff = generateSyntheticFileDiff(filePath, newContent, "add");
            diffContent = syntheticDiff.diffContent;
            linesAdded = syntheticDiff.linesAdded;
            linesDeleted = syntheticDiff.linesDeleted;
            logger.info("Recovered added file from one-sided edit fetch", {
              filePath,
              sourceCommitId,
              targetCommitId,
            });
          } else if (oldContentAvailable && newContentMissing) {
            changeType = "delete";
            oldContent = oldContentResult.value;
            const syntheticDiff = generateSyntheticFileDiff(filePath, oldContent, "delete");
            diffContent = syntheticDiff.diffContent;
            linesAdded = syntheticDiff.linesAdded;
            linesDeleted = syntheticDiff.linesDeleted;
            logger.info("Recovered deleted file from one-sided edit fetch", {
              filePath,
              sourceCommitId,
              targetCommitId,
            });
          } else {
            if (oldContentResult.status === 'rejected') {
              throw oldContentResult.reason;
            }
            if (newContentResult.status === 'rejected') {
              throw newContentResult.reason;
            }
            throw new Error(`Unable to recover diff for ${filePath}`);
          }
        }
      } catch (diffError) {
        logger.warn("Failed to fetch content for file, using fallback", {
          filePath,
          error: String(diffError),
        });
        oldContent = undefined;
        newContent = undefined;
        diffContent =
          `File: ${filePath}\n` +
          `Change type: ${changeType}\n` +
          `[Content fetch failed - possibly binary file, too large, or access restricted]`;
        const fallbackMetrics = getFallbackLineMetrics(changeType);
        linesAdded = fallbackMetrics.linesAdded;
        linesDeleted = fallbackMetrics.linesDeleted;
      }

      diffChanges.push({
        filePath,
        changeType,
        linesAdded,
        linesDeleted,
        diffContent,
        ...(typeof change.changeTrackingId === 'number' ? { changeTrackingId: change.changeTrackingId } : {}),
        ...fileLineCounts(changeType, oldContent, newContent),
      });
    }

    if (truncatedChanges > 0) {
      logger.warn("Truncated diff to prevent overwhelming AI", {
        prId,
        totalFiles: includedEntries.length,
        included: MAX_FILES_FOR_AI,
      });
    }

    logger.info("PR diff fetched successfully with real content", {
      prId,
      filesChanged: diffChanges.length,
      totalChanges: changeEntries.length,
      filteredChanges,
      truncatedChanges,
      linesAdded: diffChanges.reduce((sum, c) => sum + c.linesAdded, 0),
      linesDeleted: diffChanges.reduce((sum, c) => sum + c.linesDeleted, 0),
    });

    return {
      changes: diffChanges,
      totalChanges: changeEntries.length,
      filteredChanges,
      truncatedChanges,
      sourceCommitId,
      targetCommitId,
      latestIterationId: iterationId,
      ...(typeof firstComparingIteration === 'number' ? { firstComparingIteration } : {}),
    };
  } catch (error) {
    logger.error("Failed to fetch PR diff", {
      projectName,
      repositoryId,
      prId,
      error: String(error),
    });
    throw new Error(`Failed to fetch diff for PR ${prId}: ${error}`);
  }
}
