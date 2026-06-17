/**
 * Best-effort structural repair for AI-generated HTML, applied before sanitization.
 *
 * Large language models frequently emit code inside <pre><code> blocks without
 * HTML-escaping the code (raw `<`, `>`, `&`) and sometimes fail to close the
 * block. Both problems corrupt rendering: an unescaped `<` opens a phantom tag,
 * and an unclosed <pre><code> swallows the rest of the document as preformatted
 * text. The generic sanitizer only discards disallowed tags/attributes; it does
 * not escape stray code or balance wrappers, so malformed output passes straight
 * through.
 *
 * This module walks every <pre> block, HTML-escapes its (code) contents, and
 * guarantees the <pre>/<code> wrappers are balanced. Well-formed input is
 * returned effectively unchanged (already-escaped entities are not re-escaped).
 */

/** Matches a <pre ...> opener (not <presentation> etc.). */
const PRE_OPEN_REGEX = /<pre\b[^>]*>/i;

/** Matches an optional <code ...> immediately following the <pre> opener. */
const CODE_OPEN_REGEX = /^\s*<code\b[^>]*>/i;

/**
 * Matches the earliest code-block closer. Order matters: a combined
 * `</code></pre>` is preferred over a lone `</pre>` or `</code>` so we consume
 * both wrappers when present.
 */
const CLOSER_REGEX = /<\/code>\s*<\/pre>|<\/pre>|<\/code>/i;

/** Matches HTML break tags (<br>, <br/>, <br />) in any casing. */
const BR_TAG_REGEX = /<br\s*\/?>/gi;

/**
 * Convert break tags to real newlines. Inside a <pre> block newlines already
 * render as line breaks, so a model-emitted <br/> is redundant; without this it
 * would be escaped to visible `<br/>` text by escapeCodeContent.
 */
function convertBreaksToNewlines(content: string): string {
  return content.replace(BR_TAG_REGEX, '\n');
}

/**
 * Escape the textual contents of a code block so raw `<`, `>`, and `&` render
 * literally instead of being parsed as markup. Existing entities (e.g. `&gt;`)
 * are preserved to avoid double-escaping.
 */
function escapeCodeContent(content: string): string {
  return content
    .replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Repair AI-generated HTML by escaping code-block contents and balancing
 * <pre>/<code> wrappers. Content outside <pre> blocks is left untouched.
 */
export function repairHtmlCodeBlocks(html: string): string {
  if (!html) return html;

  let out = '';
  let rest = html;

  while (true) {
    const open = rest.match(PRE_OPEN_REGEX);
    if (!open || open.index === undefined) {
      out += rest;
      break;
    }

    // Emit everything before the <pre> verbatim (real document structure).
    out += rest.slice(0, open.index);
    let after = rest.slice(open.index + open[0].length);

    out += '<pre>';

    // Preserve an immediate <code> wrapper if present.
    const codeOpen = after.match(CODE_OPEN_REGEX);
    const hasCode = Boolean(codeOpen);
    if (codeOpen) {
      out += '<code>';
      after = after.slice(codeOpen[0].length);
    }

    const closeTag = hasCode ? '</code></pre>' : '</pre>';
    const closer = after.match(CLOSER_REGEX);

    if (!closer || closer.index === undefined) {
      // Unclosed block: escape the remainder and close it. There is no further
      // structured content to lose because nothing closed the block.
      out += escapeCodeContent(convertBreaksToNewlines(after)) + closeTag;
      break;
    }

    out += escapeCodeContent(convertBreaksToNewlines(after.slice(0, closer.index))) + closeTag;
    rest = after.slice(closer.index + closer[0].length);
  }

  return out;
}

export { escapeCodeContent };
