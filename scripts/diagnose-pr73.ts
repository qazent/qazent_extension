/**
 * One-off diagnostic: compare ADO PR 73 vs generateUnifiedDiff / 80-line prompt slice.
 * Do not print secrets.
 */
import * as dotenv from 'dotenv';
import * as azdev from 'azure-devops-node-api';
import { GitVersionType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { generateUnifiedDiff } from '../src/backend/ado-client';
import {
  DIFF_MAX_CHARS_PER_FILE,
  MAX_DIFF_LINES_PER_FILE,
  MAX_DIFF_LINES_PER_FILE_INLINE,
  MAX_FILES_WITH_DIFF,
} from '../src/backend/diff-config';

dotenv.config();

function truncateToLines(text: string, maxLines: number): { text: string; omitted: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, omitted: 0 };
  return { text: lines.slice(0, maxLines).join('\n'), omitted: lines.length - maxLines };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const orgUrl = process.env.ADO_ORG_URL;
  const pat = process.env.ADO_PAT;
  const project = process.env.ADO_PROJECT_NAME;
  const repoName = process.env.ADO_REPO_NAME;
  if (!orgUrl || !pat || !project || !repoName) {
    throw new Error('Missing ADO_* env vars');
  }

  const auth = azdev.getPersonalAccessTokenHandler(pat);
  const connection = new azdev.WebApi(orgUrl, auth);
  const gitApi = await connection.getGitApi();
  const repos = await gitApi.getRepositories(project);
  console.log(JSON.stringify({
    envRepoName: repoName,
    project,
    repoCount: repos?.length ?? 0,
    repoNames: (repos ?? []).map((item) => item.name),
  }, null, 2));

  const prId = 73;
  let repo = (repos ?? []).find((item) => item.name === repoName);
  let pr = repo?.id ? await gitApi.getPullRequest(repo.id, prId, project).catch(() => null) : null;
  if (!pr) {
    for (const candidate of repos ?? []) {
      if (!candidate.id) {
        continue;
      }
      const found = await gitApi.getPullRequest(candidate.id, prId, project).catch(() => null);
      if (found) {
        repo = candidate;
        pr = found;
        break;
      }
    }
  }
  if (!repo?.id || !pr) {
    throw new Error(`PR ${prId} not found in project ${project}`);
  }
  console.log(JSON.stringify({ resolvedRepo: repo.name, resolvedRepoId: repo.id }, null, 2));
  const iterations = await gitApi.getPullRequestIterations(repo.id, prId, project);
  const latest = iterations?.[iterations.length - 1];
  const iterationId = latest?.id;
  const sourceCommitId = pr.lastMergeSourceCommit?.commitId;
  const targetCommitId = pr.lastMergeTargetCommit?.commitId;
  console.log(JSON.stringify({
    title: pr.title,
    status: pr.status,
    source: pr.sourceRefName,
    target: pr.targetRefName,
    lastMergeSourceCommit: sourceCommitId,
    lastMergeTargetCommit: targetCommitId,
    iterationCount: iterations?.length ?? 0,
    latestIterationId: iterationId,
  }, null, 2));

  if (!iterationId) {
    throw new Error('No iteration');
  }

  const changes = await (gitApi as any).getPullRequestIterationChanges(
    repo.id, prId, iterationId, project, 200, 0
  );
  const entries = (changes?.changeEntries ?? []) as Array<{
    item?: { path?: string };
    changeType?: unknown;
    changeTrackingId?: number;
  }>;
  console.log(JSON.stringify({
    iterationChangeCount: entries.length,
    iterationFiles: entries.map((entry) => ({
      path: entry.item?.path,
      changeType: String(entry.changeType),
      tracking: entry.changeTrackingId,
    })),
  }, null, 2));

  if (!sourceCommitId || !targetCommitId) {
    throw new Error('PR missing merge commit IDs');
  }

  const fileSummaries = [];
  for (const entry of entries.slice(0, 20)) {
    const filePath = entry.item?.path;
    if (!filePath) {
      continue;
    }
    const version = { versionType: GitVersionType.Commit as GitVersionType };
    let oldContent = '';
    let newContent = '';
    let oldError: string | undefined;
    let newError: string | undefined;
    try {
      oldContent = await readStream(await gitApi.getItemContent(
        repo.id, filePath, project, undefined, undefined, undefined, undefined, false,
        { ...version, version: targetCommitId }
      ));
    } catch (error) {
      oldError = error instanceof Error ? error.message : String(error);
    }
    try {
      newContent = await readStream(await gitApi.getItemContent(
        repo.id, filePath, project, undefined, undefined, undefined, undefined, false,
        { ...version, version: sourceCommitId }
      ));
    } catch (error) {
      newError = error instanceof Error ? error.message : String(error);
    }

    const generated = generateUnifiedDiff(filePath, oldContent, newContent, DIFF_MAX_CHARS_PER_FILE);
    const qaSlice = truncateToLines(generated.diffContent, MAX_DIFF_LINES_PER_FILE);
    const inlineSlice = truncateToLines(generated.diffContent, MAX_DIFF_LINES_PER_FILE_INLINE);
    const plusMinusInFull = generated.diffContent.split('\n').filter((line) => line.startsWith('+ ') || line.startsWith('- ')).length;
    const plusMinusInQaPrompt = qaSlice.text.split('\n').filter((line) => line.startsWith('+ ') || line.startsWith('- ')).length;
    const plusMinusInInlinePrompt = inlineSlice.text.split('\n').filter((line) => line.startsWith('+ ') || line.startsWith('- ')).length;
    fileSummaries.push({
      filePath,
      oldLineCount: oldContent ? oldContent.split('\n').length : 0,
      newLineCount: newContent ? newContent.split('\n').length : 0,
      oldError,
      newError,
      generatedAdded: generated.linesAdded,
      generatedDeleted: generated.linesDeleted,
      generatedDiffLines: generated.diffContent.split('\n').length,
      generatedDiffChars: generated.diffContent.length,
      truncatedForSafety: generated.diffContent.includes('diff truncated for AI safety'),
      qaPromptOmittedLines: qaSlice.omitted,
      inlinePromptOmittedLines: inlineSlice.omitted,
      plusMinusInFull,
      plusMinusInQaPrompt,
      plusMinusInInlinePrompt,
      generatedPreview: generated.diffContent.split('\n').slice(0, 25),
    });
  }

  console.log(JSON.stringify({
    filesWithFullDiffInPrompt: Math.min(MAX_FILES_WITH_DIFF, entries.length),
    fileSummaries,
  }, null, 2));
}

main().catch((err) => {
  console.error('DIAGNOSE_FAILED', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
