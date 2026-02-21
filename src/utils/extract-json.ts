import { PRMetadata } from "../../types";
import * as logger from "../../logger";

/**
 * Extract the first valid JSON object from an AI response.
 * Handles nested braces, markdown, commentary, and trailing text.
 */
export function extractJSON(
  text: string,
  prMetadata?: PRMetadata,
  loggerInstance?: typeof logger
): string {
  if (loggerInstance) {
    loggerInstance.debug("AI raw response (first 500 chars)", {
      prId: prMetadata?.prId,
      preview: text.substring(0, 500)
    });
  }

  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}") {
      depth--;

      // Found the matching closing brace for the first JSON object
      if (depth === 0 && start !== -1) {
        const jsonText = text.substring(start, i + 1);

        if (loggerInstance) {
          loggerInstance.debug("Extracted JSON block", {
            prId: prMetadata?.prId,
            extractedLength: jsonText.length,
            extractedPreview: jsonText.substring(0, 300)
          });
        }

        return jsonText;
      }
    }
  }

  if (loggerInstance) {
    loggerInstance.error("No JSON object found in AI response", {
      prId: prMetadata?.prId,
      responsePreview: text.substring(0, 500)
    });
  }

  throw new Error("No valid JSON object found in AI response");
}