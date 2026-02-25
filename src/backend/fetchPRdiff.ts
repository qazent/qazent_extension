import fetch from "node-fetch";
import { CodeDiff, DiffChange, } from './types';
import * as logger from './utils/logger';
import {generateUnifiedDiff} from "./ado-client";
import { GitApi } from 'azure-devops-node-api/GitApi';
import { fetchPRDiffFallback } from "./ado-client";
import * as azdev from 'azure-devops-node-api';




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

  if (!token) {
    throw new Error('Authorization token is missing. Cannot proceed with API call.');
  }

  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(`Authorization token is invalid (empty or non-string). Token type: "${typeof token}"`);
  }

  logger.debug("Fetching file content via REST", {
    organization,
    projectName,
    repositoryId,
    filePath,
    commitId,
    url,
    tokenPresent: true,
    tokenLength: token.length,
    tokenPrefix: token.substring(0, 10) + '...'
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unable to read response body)");
    const headers = {
      wwwAuthenticate: response.headers.get('www-authenticate'),
      xMsCorrelationId: response.headers.get('x-ms-correlation-id'),
      xTfsProcessingId: response.headers.get('x-tfs-processingid')
    };

    logger.error('REST API call failed', {
      status: response.status,
      statusText: response.statusText,
      url,
      headers,
      responseBody: text.substring(0, 500),
      authHeaderSent: !!token
    });

    throw new Error(
      `REST API failed (${response.status}): ${text}`
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
    logger.info("Fetching PR diff", { projectName, repositoryId, prId });

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

    if (!iterationId) {
      throw new Error("Latest iteration has no ID");
    }

    // Step 3: Get list of changed files
    const changes = await gitApi.getPullRequestIterationChanges(
      repositoryId,
      prId,
      iterationId,
      projectName
    );

    if (!changes || !changes.changeEntries) {
      logger.warn("No changes found in PR", { prId });
      return { changes: [], totalChanges: 0 };
    }

    const diffChanges: DiffChange[] = [];
    const MAX_FILES = 100; // Limit files to prevent overwhelming AI and API rate limits

    // Step 4: Process each changed file and fetch actual content via REST
    for (const change of changes.changeEntries.slice(0, MAX_FILES)) {
      if (!change.item?.path) {
        continue;
      }

      const filePath = change.item.path;
      let changeType: "add" | "edit" | "delete" = "edit";

      if (change.changeType) {
        const changeTypeStr = change.changeType.toString().toLowerCase();
        if (changeTypeStr.includes("add")) {
          changeType = "add";
        } else if (changeTypeStr.includes("delete")) {
          changeType = "delete";
        }
      }

      let diffContent = "";
      let linesAdded = 0;
      let linesDeleted = 0;

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
          const oldContent = await fetchFileContentFromRest(
            organization,
            projectName,
            repositoryId,
            filePath,
            targetCommitId,
            token
          );

          // Validate returned content
          if (!oldContent) {
            throw new Error(`fetchFileContentFromRest returned empty content for ${filePath}`);
          }

          if (oldContent.startsWith("<!DOCTYPE html") || oldContent.includes("<script class=\"options\"")) {
            throw new Error(
              `Azure DevOps returned HTML login page instead of file content for ${filePath}. ` +
              `Check PAT, org, project, and URL.`
            );
          }

          linesDeleted = oldContent.split("\n").length;

          diffContent =
            `--- a/${filePath}\n` +
            `+++ /dev/null\n` +
            oldContent
              .split("\n")
              .map((line) => `- ${line}`)
              .slice(0, 50)
              .join("\n");

        } else if (changeType === "add") {
          // For added files, fetch new content only (source commit = after PR)
          logger.debug("Fetching new content via REST for added file", {
            filePath,
            commitId: sourceCommitId,
          });

          if (!organization) throw new Error("Organization is undefined");
          if (!sourceCommitId) throw new Error(`sourceCommitId undefined for ${filePath}`);

          const newContent = await fetchFileContentFromRest(
            organization,
            projectName,
            repositoryId,
            filePath,
            sourceCommitId,
            token
          );

          if (!newContent) {
            throw new Error(`fetchFileContentFromRest returned empty content for ${filePath}`);
          }

          if (newContent.startsWith("<!DOCTYPE html") || newContent.includes("<script class=\"options\"")) {
            throw new Error(
              `Azure DevOps returned HTML login page instead of file content for ${filePath}.`
            );
          }

          linesAdded = newContent.split("\n").length;

          diffContent =
            `--- /dev/null\n` +
            `+++ b/${filePath}\n` +
            newContent
              .split("\n")
              .map((line) => `+ ${line}`)
              .slice(0, 50)
              .join("\n");
        } else {
          // For edited files, fetch both old and new content
          logger.info("Fetching old and new content via REST for edited file", {
            filePath,
            targetCommitId,
            sourceCommitId,
          });

          const [oldContentRaw, newContentRaw] = await Promise.all([
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

          const oldContent = oldContentRaw || "";
          const newContent = newContentRaw || "";

          const diff = generateUnifiedDiff(filePath, oldContent, newContent);
          diffContent = diff.diffContent;
          linesAdded = diff.linesAdded;
          linesDeleted = diff.linesDeleted;
        }
      } catch (diffError) {
        logger.warn("Failed to fetch content for file, using fallback", {
          filePath,
          error: String(diffError),
        });
        diffContent =
          `File: ${filePath}\n` +
          `Change type: ${changeType}\n` +
          `[Content fetch failed - possibly binary file, too large, or access restricted]`;
        linesAdded = changeType === "add" ? 10 : 5;
        linesDeleted = changeType === "delete" ? 10 : 3;
      }

      diffChanges.push({
        filePath,
        changeType,
        linesAdded,
        linesDeleted,
        diffContent,
      });
    }

    if (changes.changeEntries.length > MAX_FILES) {
      logger.warn("Truncated diff to prevent overwhelming AI", {
        prId,
        totalFiles: changes.changeEntries.length,
        included: MAX_FILES,
      });
    }

    logger.info("PR diff fetched successfully with real content", {
      prId,
      filesChanged: diffChanges.length,
      totalChanges: changes.changeEntries.length,
      linesAdded: diffChanges.reduce((sum, c) => sum + c.linesAdded, 0),
      linesDeleted: diffChanges.reduce((sum, c) => sum + c.linesDeleted, 0),
    });

    return {
      changes: diffChanges,
      totalChanges: changes.changeEntries.length,
      sourceCommitId,
      targetCommitId,
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
