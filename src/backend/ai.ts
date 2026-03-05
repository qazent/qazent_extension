
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
 * Load system prompt from file (cached)
 */
export function loadSystemPrompt(): string {
  if (systemPrompt !== null) {
    return systemPrompt;
  }

  const promptPath = path.join(process.cwd(), 'system-prompt.txt');
  console.log('[AI] Loading system prompt from:', promptPath);

  try {
    systemPrompt = fs.readFileSync(promptPath, 'utf-8');
    console.log('[AI] System prompt loaded successfully, length:', systemPrompt.length);
    logger.info('System prompt loaded', { length: systemPrompt.length });
    return systemPrompt;
  } catch (error) {
    logger.error('Failed to load system prompt', { promptPath, error: String(error) });
    console.error(`FATAL: Cannot load system-prompt.txt from ${promptPath}`);
    console.error('Current working directory:', process.cwd());
    console.error('Error details:', error);
    console.error('Ensure system-prompt.txt is in the dist/ folder alongside server.js');
    process.exit(1);
  }
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

  // Try to extract JSON between first { and last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

function safeParseAIResponse(response: string): any {
  const extracted = extractJSON(response);
  const hadMarkdown = response.trim().startsWith('```');
  logger.debug('JSON extraction', {
    extractionLength: extracted.length,
    hadMarkdown
  });

  try {
    const parsed = JSON.parse(extracted);
    logger.debug('AI JSON parsed without repair', {
      parseSucceeded: true,
      jsonrepairApplied: false,
      first200Chars: extracted.substring(0, 200)
    });
    return parsed;
  } catch (_) {
    // First parse failed, try jsonrepair
  }

  try {
    const repaired = jsonrepair(extracted);
    logger.debug('AI JSON repaired and parsed', {
      parseSucceeded: false,
      jsonrepairApplied: true,
      first200Chars: repaired.substring(0, 200)
    });
    return JSON.parse(repaired);
  } catch (err) {
    const errMsg = String(err);
    const posMatch = errMsg.match(/position\s+(\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      logger.warn('JSON parse/repair failed at position', {
        position: pos,
        rawSubstringAroundPosition: extracted.substring(Math.max(0, pos - 60), pos + 60)
      });
    }
    throw new Error("Failed to repair AI JSON: " + err);
  }
}

/**
 * Decode htmlDescriptionBase64: if the value is Base64, decode to HTML;
 * if it is already raw HTML (starts with '<'), use as-is for backward compatibility.
 */
function decodeHtmlDescriptionBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<')) {
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
    if (decoded && decoded.trim().startsWith('<')) {
      return decoded.trim();
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

      // Load system prompt
      const sysPrompt = loadSystemPrompt();

      // Initialize Gemini
      const ai = getGenAI();

      // Build user prompt
      const userPrompt = buildUserPrompt(prMetadata, codeDiff, customContext);

      logger.debug('Sending prompt to AI', {
        systemPromptLength: sysPrompt.length,
        userPromptLength: userPrompt.length,
        totalPromptLength: sysPrompt.length + userPrompt.length,
        maxOutputTokens: 16384,
        attempt
      });

      // Generate content using new SDK API
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', // Use stable GA model instead of preview
        contents: [
          { role: 'user', parts: [{ text: sysPrompt + '\n\n' + userPrompt }] }
        ],
        config: {
          temperature: 1,
          maxOutputTokens: 16384, // Increased from 4096; comprehensive 11-section test cases require ~5000-7000 tokens 
          // Maximum input tokens: 1,048,576
          // Maximum output tokens: 65,535 (default)

          responseMimeType: 'application/json'
        }
      });

      const text = response.text; // Direct property access, NOT a method call

      if (!text) {
        throw new Error('AI returned empty response');
      }

      logger.debug('AI response received', {
        prId: prMetadata.prId,
        responseLength: text?.length || 0,
        textPreview: text?.substring(0, 100) || 'null',
        textEnding: text?.substring(text.length - 100) || 'null',
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
          rawResponsePreview: text.substring(0, 500),
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
      if (parsed.htmlDescriptionBase64 && typeof parsed.htmlDescriptionBase64 === 'string') {
        parsed.htmlDescriptionBase64 = decodeHtmlDescriptionBase64(parsed.htmlDescriptionBase64);
      }

      // Validate task output
      const taskOutput = validateTaskOutput(parsed);

      // Validate response completeness to detect truncation (11 sections need substantial content)
      const htmlLength = taskOutput.htmlDescriptionBase64.length;
      const hasAllSections = taskOutput.htmlDescriptionBase64.includes('<h2>Automation Notes</h2>');
      const MIN_HTML_LENGTH = 3000;

      if (htmlLength < MIN_HTML_LENGTH || !hasAllSections) {
        logger.warn('AI response appears truncated', {
          prId: prMetadata.prId,
          htmlLength,
          minRequired: MIN_HTML_LENGTH,
          hasAllSections,
          attempt
        });
        throw new Error('AI response truncated - missing sections');
      }

      logger.info("Task work item output generated successfully", {
        prId: prMetadata.prId,
        title: taskOutput.title,
        htmlLength: taskOutput.htmlDescriptionBase64.length,
        hasPurpose: taskOutput.htmlDescriptionBase64.includes('<h2>Purpose</h2>'),
        hasAutomationNotes: taskOutput.htmlDescriptionBase64.includes('<h2>Automation Notes</h2>'),
        sectionCount: (taskOutput.htmlDescriptionBase64.match(/<h2>/g) || []).length,
        attempt
      });

      return taskOutput;

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`AI generation attempt ${attempt} failed, retrying`, {
          prId: prMetadata.prId,
          error: String(error),
          attempt
        });
        // Continue to next attempt
      } else {
        logger.error(`AI generation attempt ${attempt} failed (final attempt)`, {
          prId: prMetadata.prId,
          error: String(error),
          attempt
        });
      }
    }
  }

  // All attempts failed
  throw new Error(`Failed to generate test cases after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'Unknown error'}`);
}
