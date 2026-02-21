/**
 * AI integration module using Google Gemini
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { CodeDiff, PRMetadata, TaskWorkItemOutput } from './types';
import * as logger from './logger';
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

  try {
    systemPrompt = fs.readFileSync(promptPath, 'utf-8');
    logger.info('System prompt loaded', { length: systemPrompt.length });
    return systemPrompt;
  } catch (error) {
    logger.error('Failed to load system prompt', { promptPath, error: String(error) });
    console.error(`FATAL: Cannot load system-prompt.txt from ${promptPath}`);
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
function buildUserPrompt(prMetadata: PRMetadata, codeDiff: CodeDiff): string {
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

  prompt += `
Please provide test cases in the following JSON structure:
{
  "title": "Test Case: <short summary>",
  "htmlDescription": "<complete HTML document with all 9 sections>"
}`;

  return prompt;
}

/**
 * Extract JSON from AI response (handle markdown wrappers)
 */
function extractJSON(response: string): string {
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

function safeParseAIResponse(response: string) {
  const extracted = extractJSON(response);

  try {
    const repaired = jsonrepair(extracted);
    return JSON.parse(repaired);
  } catch (err) {
    throw new Error("Failed to repair AI JSON: " + err);
  }
}

/**
 * Validate Task work item output from AI
 */
function validateTaskOutput(data: any): TaskWorkItemOutput {
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
 * Generate test cases using Gemini AI with retry logic
 */
export async function generateTestCases(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff
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
      const userPrompt = buildUserPrompt(prMetadata, codeDiff);

      logger.debug('Sending prompt to AI', {
        systemPromptLength: sysPrompt.length,
        userPromptLength: userPrompt.length,
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
          maxOutputTokens: 4096,
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
        attempt
      });

      // Extract and robustly parse JSON using safeParseAIResponse
      let parsed: any;
      try {
        parsed = safeParseAIResponse(text);
      } catch (parseError) {
        logger.error("Failed to parse/repair AI response as JSON", {
          prId: prMetadata.prId,
          error: String(parseError),
          errorName: parseError instanceof Error ? parseError.name : 'Unknown',
          rawResponsePreview: text.substring(0, 500),
          textType: typeof text,
          rawLength: text.length,
          attempt
        });
        throw new Error(`Failed to parse AI response: ${parseError}`);
      }

      // Validate task output
      const taskOutput = validateTaskOutput(parsed);

      logger.info("Task work item output generated successfully", {
        prId: prMetadata.prId,
        title: taskOutput.title,
        htmlLength: taskOutput.htmlDescription.length,
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
