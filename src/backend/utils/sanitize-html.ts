import sanitizeHtml, { type IOptions } from 'sanitize-html';
import * as logger from './logger';

/**
 * Only allow the formatting our generated descriptions and PR summaries need.
 * Everything else is discarded before the content is persisted in Azure DevOps.
 */
const SANITIZE_OPTIONS: IOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'em',
    'h2',
    'h3',
    'h4',
    'hr',
    'i',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    ol: ['start', 'type'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
};

export interface SanitizeHTMLContext {
  source: string;
  prId?: number;
  projectName?: string;
  workItemId?: number;
}

function stripControlCharacters(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function sanitizeHTML(html: string, context?: SanitizeHTMLContext): string {
  if (!html) return '';

  const normalized = stripControlCharacters(html);
  const sanitized = sanitizeHtml(normalized, SANITIZE_OPTIONS).trim();

  if (sanitized !== html.trim()) {
    logger.warn('HTML sanitization modified content', {
      source: context?.source ?? 'unknown',
      prId: context?.prId,
      projectName: context?.projectName,
      workItemId: context?.workItemId,
      originalLength: html.length,
      normalizedLength: normalized.length,
      sanitizedLength: sanitized.length,
      removedCharactersEstimate: Math.max(0, normalized.length - sanitized.length),
      controlCharactersRemoved: html.length - normalized.length,
    });
  }

  return sanitized;
}
