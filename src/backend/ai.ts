
/**
 * AI integration module using Google Gemini
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { CodeDiff, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './utils/logger';
import { jsonrepair } from "jsonrepair";


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

/**
 * Construct user prompt from PR metadata and code diff
 */
function buildUserPrompt(prMetadata: PRMetadata, codeDiff: CodeDiff, customContext?: string): string {
  let prompt = `Generate test cases for this Pull Request:

PR Title: ${prMetadata.title}
PR Description: ${prMetadata.description || 'N/A'}
Author: ${prMetadata.author}
Source Branch: ${prMetadata.sourceBranch}
Target Branch: ${prMetadata.targetBranch}

Code Changes Summary:
- Total files changed: ${codeDiff.totalChanges}

Detailed Changes:
`;

  for (const change of codeDiff.changes) {
    prompt += `
File: ${change.filePath}
Type: ${change.changeType}
Lines Added: ${change.linesAdded}
Lines Deleted: ${change.linesDeleted}

Diff:
${change.diffContent}
`;
  }

  // Append custom context if provided
  if (customContext && customContext.trim().length > 0) {
    prompt += `\n\nRepository-Specific Context:\n${customContext}\n`;
  }

  prompt += `
Please provide test cases in the following JSON structure:
{
  "title": "Test Case: <short summary>",
  "htmlDescriptionBase64": "<Base64-encoded string of the full HTML only, not raw HTML>"
}`;

  return prompt;
}

/**
 * Extract JSON from AI response (handle markdown wrappers).
 * Uses brace-matching that respects double-quoted strings so that { or } inside
 * string values (e.g. raw HTML in htmlDescriptionBase64) do not break extraction.
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

/** Result of pre-parse repair of htmlDescriptionBase64 in raw JSON text */
interface RepairResult {
  json: string;
  wasRepaired: boolean;
}

/**
 * If the value of "htmlDescriptionBase64" in the extracted JSON is raw HTML (starts with '<'),
 * Base64-encode it in place so the JSON becomes parseable. Mixed content (Base64 then <) is
 * treated as raw HTML and fully Base64-encoded.
 */
function repairHtmlDescriptionBase64InJson(extracted: string): RepairResult {
  const key = '"htmlDescriptionBase64"';
  const keyIdx = extracted.indexOf(key);
  if (keyIdx === -1) {
    return { json: extracted, wasRepaired: false };
  }

  const afterKey = keyIdx + key.length;
  const colonIdx = extracted.indexOf(':', afterKey);
  if (colonIdx === -1 || colonIdx > afterKey + 10) {
    return { json: extracted, wasRepaired: false };
  }

  let valueStart = colonIdx + 1;
  while (valueStart < extracted.length && /[\s]/.test(extracted[valueStart])) {
    valueStart++;
  }
  if (valueStart >= extracted.length || extracted[valueStart] !== '"') {
    return { json: extracted, wasRepaired: false };
  }
  valueStart += 1; // first char of value

  let valueEnd = valueStart;
  let escape = false;
  while (valueEnd < extracted.length) {
    const c = extracted[valueEnd];
    if (escape) {
      escape = false;
      valueEnd++;
      continue;
    }
    if (c === '\\') {
      escape = true;
      valueEnd++;
      continue;
    }
    if (c === '"') {
      break;
    }
    valueEnd++;
  }

  if (valueEnd >= extracted.length) {
    return { json: extracted, wasRepaired: false };
  }

  const value = extracted.substring(valueStart, valueEnd);
  const trimmed = value.trim();
  const looksLikeRawHtml = trimmed.startsWith('<') || (trimmed.length > 0 && /<[a-zA-Z]/.test(trimmed));
  if (!looksLikeRawHtml) {
    return { json: extracted, wasRepaired: false };
  }

  const base64Value = Buffer.from(value, 'utf-8').toString('base64');
  const before = extracted.substring(0, valueStart);
  const after = extracted.substring(valueEnd);
  const json = before + base64Value + after;
  return { json, wasRepaired: true };
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

  let toParse = extracted;
  const repairResult = repairHtmlDescriptionBase64InJson(extracted);
  if (repairResult.wasRepaired) {
    toParse = repairResult.json;
    logger.debug('Pre-parse repair: htmlDescriptionBase64 raw HTML → Base64', {
      repairedLength: toParse.length
    });
  }

  try {
    const parsed = JSON.parse(toParse);
    logger.debug('AI JSON parsed successfully', {
      parseSucceeded: true,
      jsonrepairApplied: false,
      htmlDescriptionBase64Repaired: repairResult.wasRepaired,
      hasTitle: typeof parsed?.title === 'string',
      hasHtmlField: typeof parsed?.htmlDescriptionBase64 === 'string'
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
      htmlDescriptionBase64Repaired: repairResult.wasRepaired,
      hasTitle: typeof parsed?.title === 'string',
      hasHtmlField: typeof parsed?.htmlDescriptionBase64 === 'string'
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

/**
 * Decode htmlDescriptionBase64: if the value is Base64, decode to HTML;
 * if it is already raw HTML (starts with '<'), use as-is for backward compatibility.
 */
function decodeHtmlDescriptionBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<')) {
    logger.debug('htmlDescriptionBase64: using raw HTML fallback', { valueLength: trimmed.length });
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
    if (decoded && decoded.trim().startsWith('<')) {
      logger.debug('htmlDescriptionBase64: decoded from Base64', { decodedLength: decoded.length });
      return stripTrailingGarbageFromHtml(decoded.trim());
    }
    logger.debug('htmlDescriptionBase64: Base64 decode did not yield HTML, using original', {
      decodedLength: decoded?.length ?? 0,
      decodedPreview: decoded?.substring(0, 80)
    });
    return trimmed;
  } catch (decodeErr) {
    logger.warn('htmlDescriptionBase64: Base64 decode failed, using original value', {
      errorMessage: decodeErr instanceof Error ? decodeErr.message : String(decodeErr),
      valueLength: trimmed.length,
      valuePreview: trimmed.substring(0, 80)
    });
    return trimmed;
  }
}

/** Valid HTML block closing tags we can truncate after when the end of the string looks corrupted */
const VALID_HTML_ENDINGS = [/<\/table>\s*$/i, /<\/ul>\s*$/i, /<\/ol>\s*$/i, /<\/p>\s*$/i, /<\/h2>\s*$/i, /<\/li>\s*$/i, /<\/td>\s*$/i, /<\/tr>\s*$/i];

/**
 * If decoded HTML ends with invalid UTF-8 or incomplete/garbled content, truncate at the last valid closing tag.
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
 * Validate Task work item output from AI
 */
export function validateTaskOutput(data: any): TaskWorkItemOutput {
  // Check title field
  if (!data.title || typeof data.title !== 'string' || data.title.trim() === '') {
    throw new Error('Missing required field: title');
  }

  // Check htmlDescriptionBase64 field
  if (!data.htmlDescriptionBase64 || typeof data.htmlDescriptionBase64 !== 'string' || data.htmlDescriptionBase64.trim() === '') {
    throw new Error('Missing required field: htmlDescriptionBase64');
  }

  return {
    title: data.title.trim(),
    htmlDescriptionBase64: data.htmlDescriptionBase64.trim()
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
): Promise<TaskWorkItemOutput> {
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

      // Build user prompt
      const userPrompt = buildUserPrompt(prMetadata, codeDiff, customContext);

      const MAX_OUTPUT_TOKENS = 32768;
      logger.debug('Sending prompt to AI', {
        systemPromptLength: sysPrompt.length,
        userPromptLength: userPrompt.length,
        totalPromptLength: sysPrompt.length + userPrompt.length,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        useShortPrompt,
        attempt
      });

      // Generate content using new SDK API
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', // Use stable GA model instead of preview
        contents: [
          { role: 'user', parts: [{ text: sysPrompt + '\n\n' + userPrompt }] }
        ],
        config: {
          temperature: 0.7,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json'
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

      // Decode htmlDescriptionBase64 (Base64 → HTML) or use raw HTML as-is (fallback)
      const rawValueLength = parsed.htmlDescriptionBase64?.length ?? 0;
      if (parsed.htmlDescriptionBase64 && typeof parsed.htmlDescriptionBase64 === 'string') {
        parsed.htmlDescriptionBase64 = decodeHtmlDescriptionBase64(parsed.htmlDescriptionBase64);
      }
      logger.debug('After decode: html length', {
        prId: prMetadata.prId,
        rawValueLength,
        decodedLength: parsed.htmlDescriptionBase64?.length ?? 0,
        startsWithAngle: parsed.htmlDescriptionBase64?.trim().startsWith('<') ?? false
      });

      // Validate task output
      let taskOutput: TaskWorkItemOutput;
      try {
        taskOutput = validateTaskOutput(parsed);
      } catch (validationErr) {
        logger.error('Task output validation failed', {
          prId: prMetadata.prId,
          errorMessage: validationErr instanceof Error ? validationErr.message : String(validationErr),
          hasTitle: !!parsed?.title,
          hasHtmlField: !!(parsed?.htmlDescriptionBase64 != null),
          htmlFieldType: typeof parsed?.htmlDescriptionBase64,
          attempt
        });
        throw validationErr;
      }

      // Validate response completeness to detect truncation (11 sections need substantial content)
      const htmlLength = taskOutput.htmlDescriptionBase64.length;
      const hasAutomationNotes = taskOutput.htmlDescriptionBase64.includes('<h2>Automation Notes</h2>');
      const sectionCount = (taskOutput.htmlDescriptionBase64.match(/<h2>/g) || []).length;
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
        const h2Titles = (taskOutput.htmlDescriptionBase64.match(/<h2>[^<]*<\/h2>/g) || []).map((h: string) => h.replace(/<\/?h2>/g, '').trim());
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
          htmlPreviewFirst200: taskOutput.htmlDescriptionBase64.substring(0, 200),
          htmlPreviewLast150: taskOutput.htmlDescriptionBase64.substring(Math.max(0, taskOutput.htmlDescriptionBase64.length - 150)),
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
        htmlLength: taskOutput.htmlDescriptionBase64.length,
        hasPurpose: taskOutput.htmlDescriptionBase64.includes('<h2>Purpose</h2>'),
        hasAutomationNotes,
        sectionCount,
        attempt
      });

      return taskOutput;

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
