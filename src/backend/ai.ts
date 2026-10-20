
/**
 * AI integration module using Google Gemini
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { CodeDiff, PRCommit, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './utils/logger';
import { sanitizeHTML } from './utils/sanitize-html';
import { jsonrepair } from "jsonrepair";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  GEMINI_MODEL_NAME,
  MAX_COMMIT_MESSAGE_CHARS,
  MAX_COMMIT_MESSAGE_CHARS_STRICT,
  MAX_COMMITS,
  MAX_COMMITS_STRICT,
  MAX_DIFF_LINES_PER_FILE,
  MAX_DIFF_LINES_PER_FILE_STRICT,
  MAX_FILES_WITH_DIFF,
  MAX_FILES_WITH_DIFF_STRICT,
  MAX_PR_DESCRIPTION_CHARS,
  MAX_PR_DESCRIPTION_CHARS_STRICT,
  MAX_REPOSITORY_CONTEXT_CHARS,
  MAX_REPOSITORY_CONTEXT_CHARS_STRICT,
  rankDiffChange,
  TARGET_USER_PROMPT_TOKENS,
} from './diff-config';

export const COMPRESSION_SUMMARY =
  `User prompt is capped by (1) summarizing every included file in a one-line bullet, (2) prioritizing detailed diff blocks for the highest-signal ${MAX_FILES_WITH_DIFF} files on the first pass, (3) truncating PR description to ${MAX_PR_DESCRIPTION_CHARS} chars and repository context to ${MAX_REPOSITORY_CONTEXT_CHARS} chars, (4) trimming per-file diffs to ${MAX_DIFF_LINES_PER_FILE} lines before a stricter second pass, (5) capping commit messages at ${MAX_COMMITS} entries and ${MAX_COMMIT_MESSAGE_CHARS} chars per line, and (6) dynamically reducing diff and commit detail if the prompt still exceeds roughly ${TARGET_USER_PROMPT_TOKENS} tokens. All critical PR and file-level context is retained for test case generation; only lower-priority detail is compressed first.`;

const SECTIONS_REMOVED = [
  `Full PR description → summarized to first ${MAX_PR_DESCRIPTION_CHARS_STRICT}-${MAX_PR_DESCRIPTION_CHARS} chars`,
  'Per-file "File:/Type:/Lines Added:/Lines Deleted:" blocks → replaced by one-line bullet list',
  `Full diff content per file → truncated to first ~${MAX_DIFF_LINES_PER_FILE} lines (or ~${MAX_DIFF_LINES_PER_FILE_STRICT} on stricter passes)`,
  `Repository-Specific Context → truncated to ${MAX_REPOSITORY_CONTEXT_CHARS_STRICT}-${MAX_REPOSITORY_CONTEXT_CHARS} chars`,
  'Redundant JSON structure block → replaced by one-line instruction',
  `Detailed diff blocks → prioritized to the top ${MAX_FILES_WITH_DIFF} files first and reduced further only when needed`,
  `Commit messages → capped to first ${MAX_COMMITS} entries with each line truncated to ${MAX_COMMIT_MESSAGE_CHARS} chars (${MAX_COMMITS_STRICT} / ${MAX_COMMIT_MESSAGE_CHARS_STRICT} on stricter passes)`,
] as const;

/** Response schema for Gemini structured output: guarantees valid JSON with title + htmlDescription */
const AI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    htmlDescription: { type: "string" }
  },
  required: ["title", "htmlDescription"]
} as const;


/**
 * This module handles all interactions with the Gemini AI model, including:
- Loading the system prompt from a file (with caching)
- Building the user prompt based on PR metadata and code diff
- Sending the prompt to Gemini and receiving the response
- Extracting JSON from the AI response (handling markdown wrappers)
- Validating the response and filling in defaults for missing fields
- Logging all steps and errors for observability

 */
/** let parsed: Partial<GeneratedTestCase>;
*/

export type PromptMode = 'qa' | 'review' | 'deep-review';

const PROMPT_FILES: Record<PromptMode, string> = {
  qa: 'system-prompt.txt',
  review: 'system-prompt-review.txt',
  'deep-review': 'system-prompt-deep-review.txt',
};

const systemPromptCache: Record<PromptMode, string | null> = {
  qa: null,
  review: null,
  'deep-review': null,
};

let genAI: GoogleGenAI | null = null;

const PROMPT_SECTION_DIVIDER = '------------------------------------------------';
const OPTIONAL_SHORT_PROMPT_HEADINGS = [
  'Before producing the final answer, think privately and follow this reasoning process:',
  'REPOSITORY CONTEXT (IF PROVIDED)',
  'PURPOSE & SCOPE OF CHANGE (DEPTH REQUIREMENTS)',
  'SUMMARY & IMPACT (DEPTH REQUIREMENTS)',
] as const;

function stripPromptSection(prompt: string, heading: string): string {
  const sectionStart = prompt.indexOf(heading);
  if (sectionStart === -1) {
    return prompt;
  }

  const dividerStart = prompt.indexOf(PROMPT_SECTION_DIVIDER, sectionStart + heading.length);
  if (dividerStart === -1) {
    return prompt;
  }

  const sectionEnd = dividerStart + PROMPT_SECTION_DIVIDER.length;
  const before = prompt.slice(0, sectionStart).trimEnd();
  const after = prompt.slice(sectionEnd).trimStart();

  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }

  return `${before}\n\n${after}`;
}

/**
 * Load system prompt from file (cached, per-mode).
 * If useShortPrompt is true, returns a version with optional guidance blocks stripped
 * to leave more output budget for retries after MAX_TOKENS.
 */
export function loadSystemPrompt(mode: PromptMode = 'qa', useShortPrompt = false): string {
  const fileName = PROMPT_FILES[mode];

  if (systemPromptCache[mode] === null) {
    const promptPath = path.join(process.cwd(), fileName);
    console.log(`[AI] Loading system prompt (mode=${mode}) from:`, promptPath);

    try {
      const loaded = fs.readFileSync(promptPath, 'utf-8');
      systemPromptCache[mode] = loaded;
      console.log(`[AI] System prompt (mode=${mode}) loaded successfully, length:`, loaded.length);
      logger.info('System prompt loaded', { mode, length: loaded.length });
    } catch (error) {
      logger.error('Failed to load system prompt', { mode, promptPath, error: String(error) });
      console.error(`FATAL: Cannot load ${fileName} from ${promptPath}`);
      console.error('Current working directory:', process.cwd());
      console.error('Error details:', error);
      console.error(`Ensure ${fileName} is in the dist/ folder alongside server.js`);
      process.exit(1);
    }
  }

  const cached = systemPromptCache[mode]!;

  if (!useShortPrompt) {
    return cached;
  }

  const shortPrompt = OPTIONAL_SHORT_PROMPT_HEADINGS.reduce(
    (prompt, heading) => stripPromptSection(prompt, heading),
    cached
  );

  if (shortPrompt === cached) {
    return cached;
  }

  logger.debug('Using short system prompt (optional sections omitted)', {
    mode,
    fullLength: cached.length,
    shortLength: shortPrompt.length,
    removedSections: [...OPTIONAL_SHORT_PROMPT_HEADINGS].filter((heading) => !shortPrompt.includes(heading)),
  });
  return shortPrompt;
}

/**
 * Initialize Gemini AI client
 */
function getGenAI(): GoogleGenAI {
  if (genAI !== null) {
    return genAI;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable not set');
  }

  genAI = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 15 * 60 * 1000 },
  });
  logger.info('Gemini AI client initialized');
  return genAI;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN_ESTIMATE);
}

function truncateToLines(text: string, maxLines: number): { text: string; omitted: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, omitted: 0 };
  return {
    text: lines.slice(0, maxLines).join('\n'),
    omitted: lines.length - maxLines,
  };
}

export interface BuildUserPromptResult {
  prompt: string;
  sectionsRemoved: readonly string[];
}


/**
 *  what buildUserPrompt and buildUserPromptWithTokenCap do:
 *
 * 1) Start with full-fidelity prompt
 *    - Take PR metadata (title, description, author, branches).
 *    - Take the full code diff (all changed files).
 *    - Rank all file changes by "signal" (using rankDiffChange).
 *    - Select the top N files to include with full diff blocks.
 *    - Truncate:
 *        • PR description to a max character budget.
 *        • Repository-specific context to a max character budget.
 *        • Per-file diffs to a max number of lines (fetchPRdiff.ts).
 *    - Build a structured prompt:
 *        • PR header (title, description, author, source vs target branches) this is done through ado-client.ts
 *        • Summary of files changed (one bullet per file).
 *        • Detailed diff sections for the top-ranked files (see diff-config.ts and fetchPRdiff.ts).
 *        • Optional repository-specific context. (SettingsHub.tsx)
 *        • A strict JSON-only response contract for the model.(sanitze-html.ts and validateTaskOutput in this file, system-prompt.txt) )
 *
 * 2) Enforce a token budget (buildUserPromptWithTokenCap)
 *    - Estimate the token count of the initial prompt.
 *    - If it is already under TARGET_USER_PROMPT_TOKENS, return as-is.
 *    - Otherwise:
 *        • Rebuild the prompt with stricter limits:
 *            - Shorter PR description.
 *            - Shorter repository context.
 *            - Fewer diff lines per file.
 *            - Fewer files with full diff blocks.
 *        • Re-estimate tokens.
 *        • While still over budget:
 *            - Gradually reduce:
 *                · maxFilesWithDiff (number of files with full diffs),
 *                · maxDiffLinesPerFile (lines per diff block),
 *              but never below a small minimum.
 *            - Rebuild the prompt with the tighter limits.
 *    - Stop when:
 *        • The prompt fits within the token target, or
 *        • Further tightening would not change the limits.
 *
 * Result:
 * - A prompt that preserves the highest-signal information about the PR,
 *   while staying within a strict token budget for the model.
 * 
 * Highsignal information is preserved by: diff-config.ts 
 * ranking function, prioritizing files with more changes and source code extensions, 
 * and by only truncating lower-signal detail (e.g. diff lines) 
 * after exhausting higher-level compression (e.g. summarizing files as bullets, 
 * truncating description/context).
 */
/** Result of generateTestCases; includes optional compression report for observability. */
export interface GenerateTestCasesResult extends TaskWorkItemOutput {
  compressionReport?: { compressionSummary: string; sectionsRemoved: string[] };
}

/**
 * Build compressed user prompt from PR metadata and code diff.
 * Truncates description, context, and per-file diffs to stay under TARGET_USER_PROMPT_TOKENS.
 */
function buildUserPrompt(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff,
  customContext?: string,
  commits: PRCommit[] = [],
  options?: {
    maxDescriptionChars: number;
    maxContextChars: number;
    maxDiffLinesPerFile: number;
    maxFilesWithDiff?: number;
    maxCommits?: number;
    maxCommitMessageChars?: number;
  }
): BuildUserPromptResult {
  const maxDesc = options?.maxDescriptionChars ?? MAX_PR_DESCRIPTION_CHARS;
  const maxCtx = options?.maxContextChars ?? MAX_REPOSITORY_CONTEXT_CHARS;
  const maxLines = options?.maxDiffLinesPerFile ?? MAX_DIFF_LINES_PER_FILE;
  const maxFilesWithDiff = options?.maxFilesWithDiff ?? Math.min(MAX_FILES_WITH_DIFF, codeDiff.changes.length);
  const maxCommits = options?.maxCommits ?? MAX_COMMITS;
  const maxCommitMessageChars = options?.maxCommitMessageChars ?? MAX_COMMIT_MESSAGE_CHARS;
  const rankedChanges = [...codeDiff.changes].sort((left, right) => rankDiffChange(right) - rankDiffChange(left));
  const changesWithDiff = rankedChanges.slice(0, maxFilesWithDiff);

  const description = prMetadata.description?.trim() || 'N/A';
  const descriptionTruncated =
    description.length <= maxDesc
      ? description
      : description.slice(0, maxDesc) + '... (description truncated)';

  let prompt = `Generate test cases for this Pull Request:

PR Title: ${prMetadata.title}
PR Description: ${descriptionTruncated}
Author: ${prMetadata.author}
Source Branch: ${prMetadata.sourceBranch}
Target Branch: ${prMetadata.targetBranch}
`;

  if (commits.length > 0) {
    const shown = commits.slice(0, maxCommits);
    prompt += `\nCommit Messages (${commits.length} total, ${shown.length} shown):\n`;
    for (const c of shown) {
      const firstLine = (c.message.split('\n')[0] ?? '').trim();
      const body = c.message.split('\n').slice(1).join('\n').trim();
      const truncatedFirstLine =
        firstLine.length <= maxCommitMessageChars
          ? firstLine
          : firstLine.slice(0, maxCommitMessageChars) + '... (commit message truncated)';
      prompt += `- ${c.shortSha} ${c.author}: ${truncatedFirstLine}\n`;
      if (body) {
        const truncatedBody =
          body.length <= maxCommitMessageChars
            ? body
            : body.slice(0, maxCommitMessageChars) + '... (commit body truncated)';
        prompt += `    ${truncatedBody.replace(/\n/g, '\n    ')}\n`;
      }
    }
    if (commits.length > shown.length) {
      prompt += `... (${commits.length - shown.length} earlier commits omitted)\n`;
    }
  }

  prompt += `\nFiles changed: ${codeDiff.totalChanges}
`;

  if (typeof codeDiff.filteredChanges === 'number' && codeDiff.filteredChanges > 0) {
    prompt += `Filtered low-signal files: ${codeDiff.filteredChanges}\n`;
  }
  if (typeof codeDiff.truncatedChanges === 'number' && codeDiff.truncatedChanges > 0) {
    prompt += `Additional files omitted from AI analysis budget: ${codeDiff.truncatedChanges}\n`;
  }
  prompt += `Files analyzed in detail: ${codeDiff.changes.length}\n`;

  // Bullet list: one line per file
  for (const c of codeDiff.changes) {
    prompt += `- ${c.filePath} (${c.changeType}) +${c.linesAdded} -${c.linesDeleted}\n`;
  }

  prompt += `\nKey changes (diffs):\n`;

  for (const change of changesWithDiff) {
    if (!change.diffContent) {
      continue;
    }
    const { text, omitted } = truncateToLines(change.diffContent, maxLines);
    prompt += `\n--- ${change.filePath} ---\n${text}`;
    if (omitted > 0) prompt += `\n... (diff truncated, ${omitted} lines omitted)`;
    prompt += '\n';
  }

  const summarizedOnlyCount = Math.max(0, codeDiff.changes.length - changesWithDiff.length);
  if (summarizedOnlyCount > 0) {
    prompt += `\n(${summarizedOnlyCount} analyzed files are summarized above without full diff blocks to preserve prompt quality)\n`;
  }

  if (customContext && customContext.trim().length > 0) {
    const contextTruncated =
      customContext.length <= maxCtx
        ? customContext
        : customContext.slice(0, maxCtx) + '... (context truncated)';
    prompt += `\nRepository-Specific Context:\n${contextTruncated}\n`;
  }

  prompt += `\nReturn JSON only: { "title": "Test Case: <short summary>", "htmlDescription": "<encoded HTML>" }`;

  return { prompt, sectionsRemoved: SECTIONS_REMOVED };
}

/**
 * If prompt exceeds token target, rebuild with stricter limits and optionally fewer files with diffs.
 */
function buildUserPromptWithTokenCap(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff,
  customContext?: string,
  commits: PRCommit[] = []
): BuildUserPromptResult {
  let result = buildUserPrompt(prMetadata, codeDiff, customContext, commits);
  if (estimateTokens(result.prompt) <= TARGET_USER_PROMPT_TOKENS) {
    return result;
  }
  logger.debug('User prompt exceeded token target, applying second-pass compression', {
    estimatedTokens: estimateTokens(result.prompt),
    target: TARGET_USER_PROMPT_TOKENS,
  });
  let strictOptions = {
    maxDescriptionChars: MAX_PR_DESCRIPTION_CHARS_STRICT,
    maxContextChars: MAX_REPOSITORY_CONTEXT_CHARS_STRICT,
    maxDiffLinesPerFile: MAX_DIFF_LINES_PER_FILE_STRICT,
    maxFilesWithDiff: Math.min(MAX_FILES_WITH_DIFF_STRICT, codeDiff.changes.length),
    maxCommits: MAX_COMMITS_STRICT,
    maxCommitMessageChars: MAX_COMMIT_MESSAGE_CHARS_STRICT,
  };
  result = buildUserPrompt(prMetadata, codeDiff, customContext, commits, strictOptions);

  while (estimateTokens(result.prompt) > TARGET_USER_PROMPT_TOKENS) {
    const nextFilesWithDiff = strictOptions.maxFilesWithDiff > 6
      ? Math.max(6, strictOptions.maxFilesWithDiff - 4)
      : strictOptions.maxFilesWithDiff;
    const nextDiffLinesPerFile = strictOptions.maxDiffLinesPerFile > 8
      ? Math.max(8, strictOptions.maxDiffLinesPerFile - 4)
      : strictOptions.maxDiffLinesPerFile;
    const nextMaxCommits = strictOptions.maxCommits > 3
      ? Math.max(3, strictOptions.maxCommits - 2)
      : strictOptions.maxCommits;
    const nextMaxCommitMessageChars = strictOptions.maxCommitMessageChars > 60
      ? Math.max(60, strictOptions.maxCommitMessageChars - 20)
      : strictOptions.maxCommitMessageChars;

    if (
      nextFilesWithDiff === strictOptions.maxFilesWithDiff &&
      nextDiffLinesPerFile === strictOptions.maxDiffLinesPerFile &&
      nextMaxCommits === strictOptions.maxCommits &&
      nextMaxCommitMessageChars === strictOptions.maxCommitMessageChars
    ) {
      break;
    }

    strictOptions = {
      ...strictOptions,
      maxFilesWithDiff: nextFilesWithDiff,
      maxDiffLinesPerFile: nextDiffLinesPerFile,
      maxCommits: nextMaxCommits,
      maxCommitMessageChars: nextMaxCommitMessageChars,
    };
    result = buildUserPrompt(prMetadata, codeDiff, customContext, commits, strictOptions);
  }

  return result;
}

/**
 * Extract JSON from AI response (handle markdown wrappers).
 * Uses brace-matching that respects double-quoted strings so that { or } inside
 * string values (e.g. raw HTML in htmlDescription) do not break extraction.
 * Exported for diagnostic logging when parse fails.
 */
export function extractJSON(response: string): string {
  // Remove markdown code blocks if present
  let cleaned = response.trim();

  // Remove ```json and ``` wrappers
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3);
  }

  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }

  cleaned = cleaned.trim();

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) {
    return cleaned;
  }

  // Brace-matching that respects double-quoted strings (do not count {/} inside strings)
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let endBrace = -1;

  for (let i = firstBrace; i < cleaned.length; i++) {
    const c = cleaned[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inString) {
      if (c === '"' && !escapeNext) {
        inString = false;
        continue;
      }
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (c === '\\') {
        escapeNext = true;
        continue;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }

  if (endBrace !== -1) {
    return cleaned.substring(firstBrace, endBrace + 1);
  }

  // Fallback: first { to last } (original behavior for edge cases)
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

/** Remove/replace JSON-invalid control characters (U+0000–U+001F except \t \n \r) from string */
function sanitizeJsonString(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function safeParseAIResponse(response: string): any {
  const extracted = extractJSON(response);
  const hadMarkdown = response.trim().startsWith('```');
  logger.debug('JSON extraction', {
    extractionLength: extracted.length,
    hadMarkdown,
    extractedPreviewFirst200: extracted.substring(0, 200)
  });

  const toParse = extracted;

  try {
    const parsed = JSON.parse(toParse);
    logger.debug('AI JSON parsed successfully', {
      parseSucceeded: true,
      jsonrepairApplied: false,
      hasTitle: typeof parsed?.title === 'string',
      hasHtmlField: typeof parsed?.htmlDescription === 'string'
    });
    return parsed;
  } catch (firstParseErr) {
    logger.debug('Initial JSON.parse failed, attempting jsonrepair', {
      errorMessage: firstParseErr instanceof Error ? firstParseErr.message : String(firstParseErr),
      errorName: firstParseErr instanceof Error ? firstParseErr.name : 'Unknown'
    });
  }

  try {
    const repaired = jsonrepair(toParse);
    const parsed = JSON.parse(repaired);
    logger.debug('AI JSON repaired and parsed', {
      parseSucceeded: true,
      jsonrepairApplied: true,
      hasTitle: typeof parsed?.title === 'string',
      hasHtmlField: typeof parsed?.htmlDescription === 'string'
    });
    return parsed;
  } catch (err) {
    const sanitized = sanitizeJsonString(toParse);
    try {
      const parsed = JSON.parse(sanitized);
      logger.debug('AI JSON parsed after sanitize (control chars removed)', {
        parseSucceeded: true,
        jsonrepairApplied: false,
        sanitizeApplied: true
      });
      return parsed;
    } catch (_sanitizeErr) {
      // ignore
    }
    try {
      const repaired = jsonrepair(sanitized);
      const parsed = JSON.parse(repaired);
      logger.debug('AI JSON parsed after sanitize + jsonrepair', {
        parseSucceeded: true,
        jsonrepairApplied: true,
        sanitizeApplied: true
      });
      return parsed;
    } catch (finalErr) {
      const errMsg = String(finalErr);
      const posMatch = errMsg.match(/position\s+(\d+)/i);
      logger.error('JSON parse and jsonrepair both failed', {
        errorMessage: finalErr instanceof Error ? finalErr.message : errMsg,
        errorName: finalErr instanceof Error ? finalErr.name : 'Unknown',
        extractionLength: extracted.length,
        first150Chars: extracted.substring(0, 150),
        last100Chars: extracted.substring(Math.max(0, extracted.length - 100)),
        rawResponsePreview: response.substring(0, 300),
        rawResponseEnding: response.substring(Math.max(0, response.length - 200))
      });
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        logger.warn('JSON parse/repair failed at position', {
          position: pos,
          rawSubstringAroundPosition: extracted.substring(Math.max(0, pos - 60), pos + 60)
        });
      }
      throw new Error("Failed to repair AI JSON: " + finalErr);
    }
  }
}

/** Valid HTML block closing tags we can truncate after when the end of the string looks corrupted (legacy decode only). */
const VALID_HTML_ENDINGS = [/<\/table>\s*$/i, /<\/ul>\s*$/i, /<\/ol>\s*$/i, /<\/p>\s*$/i, /<\/h2>\s*$/i, /<\/li>\s*$/i, /<\/td>\s*$/i, /<\/tr>\s*$/i];

/**
 * If decoded HTML ends with invalid UTF-8 or incomplete/garbled content, truncate at the last valid closing tag.
 * Used only for legacy Base64-decoded HTML that may have been truncated or corrupted.
 */
function stripTrailingGarbageFromHtml(html: string): string {
  const last150 = html.substring(Math.max(0, html.length - 150));
  const hasReplacementOrGarbage = /\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(last150);
  if (!hasReplacementOrGarbage) {
    return html;
  }
  let bestEnd = -1;
  for (const re of VALID_HTML_ENDINGS) {
    const match = html.match(re);
    if (match && match.index !== undefined) {
      const endIdx = match.index + match[0].length;
      if (endIdx > bestEnd) bestEnd = endIdx;
    }
  }
  if (bestEnd > 0 && bestEnd < html.length) {
    logger.debug('Stripped trailing garbage from decoded HTML', { originalLength: html.length, trimmedLength: bestEnd });
    return html.substring(0, bestEnd);
  }
  return html;
}

/**
 * Temporary backwards compatibility: if response contains only htmlDescriptionBase64, decode once to HTML.
 * Do not write htmlDescriptionBase64 into the returned object.
 * Applies stripTrailingGarbageFromHtml after decode to handle truncated/corrupted Base64 payloads.
 */
function legacyDecodeHtmlDescriptionBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<')) {
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
    if (decoded && decoded.trim().startsWith('<')) {
      return stripTrailingGarbageFromHtml(decoded.trim());
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Validate Task work item output from AI
 */
export function validateTaskOutput(data: any): TaskWorkItemOutput {
  // Check title field
  if (!data.title || typeof data.title !== 'string' || data.title.trim() === '') {
    throw new Error('Missing required field: title');
  }

  // Check htmlDescription field
  if (!data.htmlDescription || typeof data.htmlDescription !== 'string' || data.htmlDescription.trim() === '') {
    throw new Error('Missing required field: htmlDescription');
  }

  return {
    title: data.title.trim(),
    htmlDescription: data.htmlDescription.trim()
  };
}

interface HtmlHeadingMatch {
  raw: string;
  title: string;
  normalizedTitle: string;
  start: number;
  end: number;
}

const HTML_HEADING_REGEX = /<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi;

function stripInlineTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeadingTitle(value: string): string {
  return stripInlineTags(value)
    .replace(/^\d+\s*([.)\-:]?\s*)?/, '')
    .toLowerCase();
}

function extractHtmlHeadings(html: string): HtmlHeadingMatch[] {
  const matches: HtmlHeadingMatch[] = [];
  const regex = new RegExp(HTML_HEADING_REGEX);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const raw = match[0];
    const title = stripInlineTags(match[2]);
    matches.push({
      raw,
      title,
      normalizedTitle: normalizeHeadingTitle(match[2]),
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return matches;
}

function findNextH2Index(html: string, startIndex: number): number {
  const next = html.slice(startIndex).match(/<h2\b[^>]*>/i);
  return next && next.index != null ? startIndex + next.index : -1;
}

/**
 * Extracts everything from <h2>Summary</h2> through the entire
 * <h2>Impact</h2> section, including all text under both headers.
 * 
 * In JavaScript and TypeScript, indexOf() returns -1 when the substring is not found in the string. 
 * “If the <h2>Summary</h2> header does not exist, return an empty string.”
 * 
 */
export function extractPurposeAndScope(html: string): string {
  const headings = extractHtmlHeadings(html);
  const purposeIndex = headings.findIndex(
    (heading) => heading.normalizedTitle === 'summary' || heading.normalizedTitle === 'purpose'
  );
  if (purposeIndex === -1) return '';

  const scopeIndex = headings.findIndex(
    (heading, index) =>
      index > purposeIndex &&
      (heading.normalizedTitle === 'impact' || heading.normalizedTitle === 'scope of change')
  );

  if (scopeIndex === -1) {
    return html.substring(headings[purposeIndex].start).trim();
  }

  const scopeHeading = headings[scopeIndex];
  const nextH2Index = findNextH2Index(html, scopeHeading.end);
  if (nextH2Index === -1) {
    return html.substring(headings[purposeIndex].start).trim();
  }

  return html.substring(headings[purposeIndex].start, nextH2Index).trim();
}


/**
 * Generate test cases using Gemini AI with retry logic
 */
export async function generateTestCases(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff,
  customContext?: string,
  mode: PromptMode = 'qa',
  commits: PRCommit[] = []
): Promise<GenerateTestCasesResult> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;
 
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logger.info('Generating test cases with AI', {
        prId: prMetadata.prId,
        attempt,
        mode,
        commitsCount: commits.length,
      });

      // On retry (attempt 2), use shortened system prompt (examples omitted) to leave more output budget
      const useShortPrompt = attempt >= 2;
      const sysPrompt = loadSystemPrompt(mode, useShortPrompt);

      // Initialize Gemini
      const ai = getGenAI();

      // Build compressed user prompt (with token cap and optional second pass)
      const { prompt: userPrompt, sectionsRemoved } = buildUserPromptWithTokenCap(
        prMetadata,
        codeDiff,
        customContext,
        commits
      );

      const MAX_OUTPUT_TOKENS = 65536;
      const estimatedUserTokens = estimateTokens(userPrompt);
      logger.debug('Sending prompt to AI', {
        systemPromptLength: sysPrompt.length,
        userPromptLength: userPrompt.length,
        estimatedUserPromptTokens: estimatedUserTokens,
        totalPromptLength: sysPrompt.length + userPrompt.length,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        useShortPrompt,
        attempt,
        commitsIncluded: commits.length,
        compressionSummary: COMPRESSION_SUMMARY,
        sectionsRemoved: [...sectionsRemoved],
      });
      // Generate content using new SDK API
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL_NAME,
        contents: [
          { role: 'user', parts: [{ text: sysPrompt + '\n\n' + userPrompt }] }
        ],
        config: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: ThinkingLevel.HIGH
          },
          responseMimeType: 'application/json',
          responseSchema: AI_RESPONSE_SCHEMA
        }
      });

      const responseAny = response as { text?: string; candidates?: Array<{ finishReason?: string }>; usageMetadata?: Record<string, unknown> };
      const finishReason = responseAny.candidates?.[0]?.finishReason;
      const usageMetadata = responseAny.usageMetadata;
      logger.debug('AI response metadata', {
        prId: prMetadata.prId,
        finishReason: finishReason ?? 'unknown',
        usageMetadata: usageMetadata ?? null,
        attempt
      });
      if (finishReason === 'MAX_TOKENS' || finishReason === 'max_tokens') {
        logger.warn('AI response hit max output tokens', { prId: prMetadata.prId, attempt });
      }

      const text = (response as { text?: string }).text ?? responseAny.text ?? '';

      if (!text) {
        logger.warn('AI returned empty response', { prId: prMetadata.prId, attempt });
        throw new Error('AI returned empty response');
      }

      logger.debug('AI response received', {
        prId: prMetadata.prId,
        responseLength: text?.length || 0,
        rawResponsePreview: text?.substring(0, 300) || 'null',
        rawResponseEnding: text?.substring(Math.max(0, text.length - 200)) || 'null',
        hasCompleteJSON: text?.endsWith('}'),
        attempt
      });

      // Extract and robustly parse JSON using safeParseAIResponse
      let parsed: any;
      try {
        parsed = safeParseAIResponse(text);
      } catch (parseError: unknown) {
        const extracted = extractJSON(text);
        const errMsg = String(parseError);
        const posMatch = errMsg.match(/position\s+(\d+)/i);
        const logPayload: Record<string, unknown> = {
          prId: prMetadata.prId,
          error: errMsg,
          errorName: parseError instanceof Error ? parseError.name : 'Unknown',
          stack: parseError instanceof Error ? parseError.stack : undefined,
          rawResponsePreview: text.substring(0, 500),
          rawResponseEnding: text.substring(Math.max(0, text.length - 200)),
          textType: typeof text,
          rawLength: text.length,
          attempt
        };
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10);
          logPayload.position = pos;
          logPayload.rawSubstringAroundPosition = extracted.substring(Math.max(0, pos - 60), pos + 60);
        }
        logger.error("Failed to parse/repair AI response as JSON", logPayload);
        throw new Error(`Failed to parse AI response: ${parseError}`);
      }

      // Temporary backwards compatibility: if only htmlDescriptionBase64 present, decode once to htmlDescription
      if (parsed.htmlDescriptionBase64 != null && parsed.htmlDescription == null) {
        parsed.htmlDescription = legacyDecodeHtmlDescriptionBase64(
          typeof parsed.htmlDescriptionBase64 === 'string' ? parsed.htmlDescriptionBase64 : String(parsed.htmlDescriptionBase64)
        );
        logger.debug('Legacy htmlDescriptionBase64 decoded to htmlDescription', {
          prId: prMetadata.prId,
          decodedLength: parsed.htmlDescription?.length ?? 0
        });
      }
      if (parsed.htmlDescription != null && typeof parsed.htmlDescription === 'string') {
        parsed.htmlDescription = sanitizeHTML(parsed.htmlDescription, {
          source: 'ai.generateTestCases',
          prId: prMetadata.prId,
          projectName: prMetadata.projectName,
        });
      }

      // Validate task output
      let taskOutput: TaskWorkItemOutput;
      try {
        taskOutput = validateTaskOutput(parsed);
      } catch (validationErr) {
        logger.error('Task output validation failed', {
          prId: prMetadata.prId,
          errorMessage: validationErr instanceof Error ? validationErr.message : String(validationErr),
          hasTitle: !!parsed?.title,
          hasHtmlField: !!(parsed?.htmlDescription != null),
          htmlFieldType: typeof parsed?.htmlDescription,
          attempt
        });
        throw validationErr;
      }

      // Publish every parseable response (non-empty title + htmlDescription already
      // guaranteed by validateTaskOutput). The completeness heuristics below are
      // advisory only: we log when output looks sparse but never reject it, because
      // mode-specific prompts (e.g. deep-review) legitimately emit few sections.
      const htmlLength = taskOutput.htmlDescription.length;
      const headings = extractHtmlHeadings(taskOutput.htmlDescription);
      const sectionTitlesFound = headings.map((heading) => heading.title);
      const hasAutomationNotes = headings.some((heading) => /automation\s*notes/i.test(heading.normalizedTitle));
      const sectionCount = headings.length;

      const ADVISORY_MIN_HTML_LENGTH = 800;
      const ADVISORY_MIN_SECTION_COUNT = 3;
      if (htmlLength < ADVISORY_MIN_HTML_LENGTH || sectionCount < ADVISORY_MIN_SECTION_COUNT) {
        logger.warn('AI response below completeness heuristics (publishing anyway)', {
          prId: prMetadata.prId,
          htmlLength,
          advisoryMinHtmlLength: ADVISORY_MIN_HTML_LENGTH,
          sectionCount,
          advisoryMinSectionCount: ADVISORY_MIN_SECTION_COUNT,
          hasAutomationNotes,
          sectionTitlesFound,
          htmlPreviewFirst200: taskOutput.htmlDescription.substring(0, 200),
          htmlPreviewLast200: taskOutput.htmlDescription.substring(Math.max(0, taskOutput.htmlDescription.length - 200)),
          attempt
        });
      }

      logger.info("Task work item output generated successfully", {
        prId: prMetadata.prId,
        title: taskOutput.title,
        htmlLength: taskOutput.htmlDescription.length,
        hasPurpose: headings.some((heading) => heading.normalizedTitle === 'purpose'),
        hasAutomationNotes,
        sectionCount,
        attempt
      });

      const result: GenerateTestCasesResult = {
        ...taskOutput,
        compressionReport: {
          compressionSummary: COMPRESSION_SUMMARY,
          sectionsRemoved: [...sectionsRemoved],
        },
      };
      return result;

    } catch (error) {
      const errorChainDebug: Array<{ name?: string; message: string; code?: string }> = [];
      {
        let e: unknown = error;
        for (let d = 0; d < 6 && e != null; d++) {
          if (e instanceof Error) {
            const errno = e as NodeJS.ErrnoException;
            errorChainDebug.push({
              name: e.name,
              message: e.message.slice(0, 400),
              code: typeof errno.code === 'string' ? errno.code : undefined,
            });
            e = (e as Error & { cause?: unknown }).cause;
          } else {
            errorChainDebug.push({ message: String(e).slice(0, 400) });
            break;
          }
        }
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      const err = error instanceof Error ? error : new Error(String(error));
      const failureReason = err.message.includes('empty response') ? 'empty_response'
        : err.message.includes('parse') || err.message.includes('JSON') ? 'parse'
        : err.message.includes('Missing required field') ? 'validation'
        : err.message.includes('truncated') ? 'truncation'
        : err.message.includes('rate limit') || err.message.includes('API') ? 'api'
        : 'unknown';

      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`AI generation attempt ${attempt} failed, retrying`, {
          prId: prMetadata.prId,
          error: err.message,
          errorName: err.name,
          failureReason,
          attempt,
          errorChain: errorChainDebug,
        });
      } else {
        logger.error(`AI generation attempt ${attempt} failed (final attempt)`, {
          prId: prMetadata.prId,
          error: err.message,
          errorName: err.name,
          failureReason,
          stack: err.stack,
          attempt,
          errorChain: errorChainDebug,
        });
      }
    }
  }

  // All attempts failed
  throw new Error(`Failed to generate test cases after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'Unknown error'}`);
}
