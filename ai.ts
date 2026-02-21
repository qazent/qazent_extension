/**
 * AI integration module using Google Gemini
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import { CodeDiff, GeneratedTestCase, PRMetadata } from './types';
import * as logger from './logger';


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
let genAI: GoogleGenerativeAI | null = null;

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
function getGenAI(): GoogleGenerativeAI {
  if (genAI !== null) {
    return genAI;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable not set');
  }

  genAI = new GoogleGenerativeAI(apiKey);
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
  "title": "Test case title",
  "purpose": "Why this testing is needed",
  "scopeOfChange": "What areas are affected",
  "preconditions": ["condition 1", "condition 2"],
  "testSteps": ["step 1", "step 2"],
  "expectedResults": ["result 1", "result 2"],
  "negativeScenarios": ["scenario 1"],
  "edgeCases": ["edge case 1"],
  "regressionAreas": ["area 1"],
  "dataRequirements": ["data 1"],
  "automationNotes": "Notes about automation potential"
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

/**
 * Validate and fill missing fields in AI response
 */
function validateAndFillDefaults(data: Partial<GeneratedTestCase>): GeneratedTestCase {
  const defaults: GeneratedTestCase = {
    title: data.title || 'Test Case: Untitled',
    purpose: data.purpose || 'N/A',
    scopeOfChange: data.scopeOfChange || 'N/A',
    preconditions: Array.isArray(data.preconditions) ? data.preconditions : [],
    testSteps: Array.isArray(data.testSteps) ? data.testSteps : ['Review changes'],
    expectedResults: Array.isArray(data.expectedResults) ? data.expectedResults : ['Changes reviewed'],
    negativeScenarios: Array.isArray(data.negativeScenarios) ? data.negativeScenarios : [],
    edgeCases: Array.isArray(data.edgeCases) ? data.edgeCases : [],
    regressionAreas: Array.isArray(data.regressionAreas) ? data.regressionAreas : [],
    dataRequirements: Array.isArray(data.dataRequirements) ? data.dataRequirements : [],
    automationNotes: data.automationNotes || 'N/A'
  };

  // Ensure test steps and expected results have same length
  if (defaults.testSteps.length > defaults.expectedResults.length) {
    const diff = defaults.testSteps.length - defaults.expectedResults.length;
    for (let i = 0; i < diff; i++) {
      defaults.expectedResults.push('N/A');
    }
  } else if (defaults.expectedResults.length > defaults.testSteps.length) {
    const diff = defaults.expectedResults.length - defaults.testSteps.length;
    for (let i = 0; i < diff; i++) {
      defaults.testSteps.push('N/A');
    }
  }

  const missingFields: string[] = [];
  if (!data.title) missingFields.push('title');
  if (!data.purpose) missingFields.push('purpose');
  if (!data.testSteps || data.testSteps.length === 0) missingFields.push('testSteps');
  if (!data.expectedResults || data.expectedResults.length === 0) missingFields.push('expectedResults');

  if (missingFields.length > 0) {
    logger.warn('AI response missing fields, using defaults', { missingFields });
  }

  return defaults;
}

/**
 * Generate test cases using Gemini AI
 */
export async function generateTestCases(
  prMetadata: PRMetadata,
  codeDiff: CodeDiff
): Promise<GeneratedTestCase> {
  try {
    logger.info('Generating test cases with AI', { prId: prMetadata.prId });

    // Load system prompt

    const sysPrompt = loadSystemPrompt();

    // Initialize Gemini
    const ai = getGenAI();
    const model = ai.getGenerativeModel({
      model: 'gemini-3-pro-preview', // Use latest available model
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    });

    // Build user prompt
    const userPrompt = buildUserPrompt(prMetadata, codeDiff);

    logger.debug('Sending prompt to AI', {
      systemPromptLength: sysPrompt.length,
      userPromptLength: userPrompt.length
    });

    // Generate content
    const result = await model.generateContent([
      { text: sysPrompt },
      { text: userPrompt }
    ]);

    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error('AI returned empty response');
    }

    logger.debug('AI response received', { responseLength: text.length });

    // Extract and parse JSON
      const jsonText = extractJSON(text);

      let parsed: Partial<GeneratedTestCase>;

      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError) {
        logger.error("Failed to parse AI response as JSON", {
          prId: prMetadata.prId,
          error: String(parseError),
          extractedJSONPreview: jsonText.substring(0, 500),
          rawResponsePreview: text.substring(0, 500)
        });

        throw new Error(`Failed to parse AI response as JSON: ${parseError}`);
      }

      // Validate and fill defaults
      const testCase = validateAndFillDefaults(parsed);

      logger.info("Test case generated successfully", {
        prId: prMetadata.prId,
        title: testCase.title,
        stepsCount: testCase.testSteps.length
      });

    return testCase;

  } catch (error) {
    logger.error('Gemini API error', {
      prId: prMetadata.prId,
      error: String(error)
    });
    throw new Error(`Gemini API error: ${error}`);
  }
}
