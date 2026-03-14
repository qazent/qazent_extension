
/**
 * AI integration module using Google Gemini
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { CodeDiff, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './utils/logger';
import { sanitizeHTML } from './utils/sanitize-html';
import { jsonrepair } from "jsonrepair";

/** Target user prompt size to avoid MAX_TOKENS and truncation (tokens). */
const TARGET_USER_PROMPT_TOKENS = 5000;
/** Approximate chars per token for estimation. */
const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Max PR description chars in prompt. */
const MAX_DESCRIPTION_CHARS = 800;
/** Max repository context chars in prompt. */
const MAX_CONTEXT_CHARS = 2000;
/** Max diff lines per file in prompt (first pass). */
const MAX_DIFF_LINES_PER_FILE = 15;
/** Stricter limits for second pass when over token budget. */
const MAX_DESCRIPTION_CHARS_STRICT = 500;
const MAX_CONTEXT_CHARS_STRICT = 1500;
const MAX_DIFF_LINES_PER_FILE_STRICT = 8;
/** When over budget, include full (truncated) diff only for first N files; rest bullet-only. */
const MAX_FILES_WITH_DIFF_STRICT = 12;

export const COMPRESSION_SUMMARY =
  'User prompt is capped by (1) including at most 25–30 changed files and up to 2000 characters of diff per file, (2) truncating PR description to the first 500–800 characters and repository context to 1500–2000 characters, (3) replacing per-file blocks with a one-line bullet per file (path, type, +lines/-lines), (4) keeping only the first portion of each file\'s diff (first hunks / ~15 lines), and (5) using a single short JSON output instruction. Optional token estimation triggers a second pass that further shortens description, context, and per-file diffs if the prompt still exceeds 5000 tokens. All critical PR and file-level context is retained for test case generation; only redundant or excessive detail is removed.';

const SECTIONS_REMOVED = [
  'Full PR description → summarized to first 500–800 chars',
  'Per-file "File:/Type:/Lines Added:/Lines Deleted:" blocks → replaced by one-line bullet list',
  'Full diff content per file → truncated to first ~15 lines (or ~8 on second pass)',
  'Repository-Specific Context → truncated to 1500–2000 chars',
  'Redundant JSON structure block → replaced by one-line instruction',
  'Excess files → only first 25–30 files included; "(N more files not shown)" in summary if applicable',
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

let systemPrompt: string | null = null;
let genAI: GoogleGenAI | null = null;

/**
 * Load system prompt from file (cached).
 * If useShortPrompt is true, returns a version with long examples stripped to leave more output budget (e.g. for retries after MAX_TOKENS).
 */
export function loadSystemPrompt(useShortPrompt = false): string {
  if (systemPrompt === null) {
    const promptPath = path.join(process.cwd(), 'system-prompt.txt');
    console.log('[AI] Loading system prompt from:', promptPath);

    try {
      systemPrompt = fs.readFileSync(promptPath, 'utf-8');
      console.log('[AI] System prompt loaded successfully, length:', systemPrompt.length);
      logger.info('System prompt loaded', { length: systemPrompt.length });
    } catch (error) {
      logger.error('Failed to load system prompt', { promptPath, error: String(error) });
      console.error(`FATAL: Cannot load system-prompt.txt from ${promptPath}`);
      console.error('Current working directory:', process.cwd());
      console.error('Error details:', error);
      console.error('Ensure system-prompt.txt is in the dist/ folder alongside server.js');
      process.exit(1);
    }
  }

  if (!useShortPrompt) {
    return systemPrompt;
  }

  // Omit the long "## Example 1" through "## Example 3" blocks to leave more output tokens for the model
  const example1Start = systemPrompt.indexOf('## Example 1: API Endpoint Change');
  const qualityStandardsStart = systemPrompt.indexOf('## Quality Standards for Generated Test Cases');
  if (example1Start === -1 || qualityStandardsStart === -1 || qualityStandardsStart <= example1Start) {
    return systemPrompt;
  }
  const shortPrompt = systemPrompt.substring(0, example1Start).trim() + '\n\n' + systemPrompt.substring(qualityStandardsStart).trim();
  logger.debug('Using short system prompt (examples omitted)', {
    fullLength: systemPrompt.length,
    shortLength: shortPrompt.length
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

  genAI = new GoogleGenAI({ apiKey });
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
  options?: {
    maxDescriptionChars: number;
    maxContextChars: number;
    maxDiffLinesPerFile: number;
    maxFilesWithDiff?: number;
  }
): BuildUserPromptResult {
  const maxDesc = options?.maxDescriptionChars ?? MAX_DESCRIPTION_CHARS;
  const maxCtx = options?.maxContextChars ?? MAX_CONTEXT_CHARS;
  const maxLines = options?.maxDiffLinesPerFile ?? MAX_DIFF_LINES_PER_FILE;
  const maxFilesWithDiff = options?.maxFilesWithDiff ?? codeDiff.changes.length;

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

Files changed: ${codeDiff.totalChanges}
`;

  // Bullet list: one line per file
  for (const c of codeDiff.changes) {
    prompt += `- ${c.filePath} (${c.changeType}) +${c.linesAdded} -${c.linesDeleted}\n`;
  }

  const moreFiles = codeDiff.totalChanges - codeDiff.changes.length;
  if (moreFiles > 0) {
    prompt += `(${moreFiles} more files not shown)\n`;
  }

  prompt += `\nKey changes (diffs):\n`;

  for (let i = 0; i < codeDiff.changes.length; i++) {
    const change = codeDiff.changes[i];
    const includeDiff = i < maxFilesWithDiff;
    if (includeDiff && change.diffContent) {
      const { text, omitted } = truncateToLines(change.diffContent, maxLines);
      prompt += `\n--- ${change.filePath} ---\n${text}`;
      if (omitted > 0) prompt += `\n... (diff truncated, ${omitted} lines omitted)`;
      prompt += '\n';
    }
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
  customContext?: string
): BuildUserPromptResult {
  let result = buildUserPrompt(prMetadata, codeDiff, customContext);
  if (estimateTokens(result.prompt) <= TARGET_USER_PROMPT_TOKENS) {
    return result;
  }
  logger.debug('User prompt exceeded token target, applying second-pass compression', {
    estimatedTokens: estimateTokens(result.prompt),
    target: TARGET_USER_PROMPT_TOKENS,
  });
  result = buildUserPrompt(prMetadata, codeDiff, customContext, {
    maxDescriptionChars: MAX_DESCRIPTION_CHARS_STRICT,
    maxContextChars: MAX_CONTEXT_CHARS_STRICT,
    maxDiffLinesPerFile: MAX_DIFF_LINES_PER_FILE_STRICT,
    maxFilesWithDiff: Math.min(MAX_FILES_WITH_DIFF_STRICT, codeDiff.changes.length),
  });
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

/**
 * Extracts everything from <h2>Purpose</h2> through the entire
 * <h2>Scope of Change</h2> section, including all text under both headers.
 * 
 * In JavaScript and TypeScript, indexOf() returns -1 when the substring is not found in the string. 
 * “If the <h2>Purpose</h2> header does not exist, return an empty string.”
 * 
 */
export function extractPurposeAndScope(html: string): string {
  const purposeHeader = '<h2>Purpose</h2>';
  const scopeHeader = '<h2>Scope of Change</h2>';

  // Find Purpose start
  const purposeIdx = html.indexOf(purposeHeader);
  if (purposeIdx === -1) return '';

  // Find Scope of Change start
  const scopeIdx = html.indexOf(scopeHeader, purposeIdx + purposeHeader.length);
  if (scopeIdx === -1) {
    // No Scope of Change, return everything from Purpose to end
    return html.substring(purposeIdx).trim();
  }

  // Find the next <h2> after Scope of Change
  const nextHeaderIdx = html.indexOf('<h2>', scopeIdx + scopeHeader.length);

  if (nextHeaderIdx === -1) {
    // No further sections, return to end
    return html.substring(purposeIdx).trim();
  }

  // Return Purpose → end of Scope of Change section
  return html.substring(purposeIdx, nextHeaderIdx).trim();
}


/**
 * Generate test cases using Gemini AI with retry logic
 */
export async function generateTestCases(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff,
  customContext?: string
): Promise<GenerateTestCasesResult> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logger.info('Generating test cases with AI', { prId: prMetadata.prId, attempt });

      // On retry (attempt 2), use shortened system prompt (examples omitted) to leave more output budget
      const useShortPrompt = attempt >= 2;
      const sysPrompt = loadSystemPrompt(useShortPrompt);

      // Initialize Gemini
      const ai = getGenAI();

      // Build compressed user prompt (with token cap and optional second pass)
      const { prompt: userPrompt, sectionsRemoved } = buildUserPromptWithTokenCap(
        prMetadata,
        codeDiff,
        customContext
      );

      const MAX_OUTPUT_TOKENS = 32768;
      const estimatedUserTokens = estimateTokens(userPrompt);
      logger.debug('Sending prompt to AI', {
        systemPromptLength: sysPrompt.length,
        userPromptLength: userPrompt.length,
        estimatedUserPromptTokens: estimatedUserTokens,
        totalPromptLength: sysPrompt.length + userPrompt.length,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        useShortPrompt,
        attempt,
        compressionSummary: COMPRESSION_SUMMARY,
        sectionsRemoved: [...sectionsRemoved],
      });

      // Generate content using new SDK API
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview', // TODO: LATEST, please migrate quickly to the next-gen API and model versions as they become available
        contents: [
          { role: 'user', parts: [{ text: sysPrompt + '\n\n' + userPrompt }] }
        ],
        config: {
          temperature: 0.35, // Adjusted for more focused output; can be tuned based on observed response quality
          maxOutputTokens: MAX_OUTPUT_TOKENS,
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
        parsed.htmlDescription = sanitizeHTML(parsed.htmlDescription);
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

      // Validate response completeness to detect truncation (11 sections need substantial content)
      const htmlLength = taskOutput.htmlDescription.length;
      const hasAutomationNotes = taskOutput.htmlDescription.includes('<h2>Automation Notes</h2>');
      const sectionCount = (taskOutput.htmlDescription.match(/<h2>/g) || []).length;
      const MIN_HTML_LENGTH = 2500;
      const LONG_FORM_MIN_LENGTH = 5000;
      const MIN_SECTION_COUNT = 9;
      const LONG_FORM_MIN_LENGTH_RELAXED = 3500;
      const MIN_SECTION_COUNT_RELAXED = 7;

      const useRelaxedValidation = attempt >= 2;
      const minLengthForSections = useRelaxedValidation ? LONG_FORM_MIN_LENGTH_RELAXED : LONG_FORM_MIN_LENGTH;
      const minSectionCount = useRelaxedValidation ? MIN_SECTION_COUNT_RELAXED : MIN_SECTION_COUNT;

      const lengthOk = htmlLength >= MIN_HTML_LENGTH;
      const sectionsOk = hasAutomationNotes || (htmlLength >= minLengthForSections && sectionCount >= minSectionCount);

      if (!lengthOk || !sectionsOk) {
        const h2Titles = (taskOutput.htmlDescription.match(/<h2>[^<]*<\/h2>/g) || []).map((h: string) => h.replace(/<\/?h2>/g, '').trim());
        logger.warn('AI response appears truncated', {
          prId: prMetadata.prId,
          htmlLength,
          minRequired: MIN_HTML_LENGTH,
          lengthOk,
          sectionsOk,
          hasAutomationNotes,
          sectionCount,
          minSectionCount,
          longFormMinLength: minLengthForSections,
          useRelaxedValidation,
          sectionTitlesFound: h2Titles,
          htmlPreviewFirst200: taskOutput.htmlDescription.substring(0, 200),
          htmlPreviewLast200: taskOutput.htmlDescription.substring(Math.max(0, taskOutput.htmlDescription.length - 200)),
          attempt
        });
        throw new Error('AI response truncated - missing sections');
      }

      if (useRelaxedValidation && !hasAutomationNotes) {
        logger.info('Accepted AI response using relaxed validation on retry', {
          prId: prMetadata.prId,
          sectionCount,
          htmlLength,
          attempt
        });
      }

      logger.info("Task work item output generated successfully", {
        prId: prMetadata.prId,
        title: taskOutput.title,
        htmlLength: taskOutput.htmlDescription.length,
        hasPurpose: taskOutput.htmlDescription.includes('<h2>Purpose</h2>'),
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
          attempt
        });
      } else {
        logger.error(`AI generation attempt ${attempt} failed (final attempt)`, {
          prId: prMetadata.prId,
          error: err.message,
          errorName: err.name,
          failureReason,
          stack: err.stack,
          attempt
        });
      }
    }
  }

  // All attempts failed
  throw new Error(`Failed to generate test cases after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'Unknown error'}`);
}
