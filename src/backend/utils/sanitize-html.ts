/**
 * Sanitize AI-generated HTML before saving or sending to downstream systems.
 * Strips null bytes and control characters that can break display or storage.
 */
export function sanitizeHTML(html: string): string {
  if (!html) return '';
  return html
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim();
}
