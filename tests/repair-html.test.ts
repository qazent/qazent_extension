import { repairHtmlCodeBlocks, escapeCodeContent } from '../src/backend/utils/repair-html';

describe('escapeCodeContent', () => {
  it('escapes raw <, >, and & characters', () => {
    expect(escapeCodeContent('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('does not double-escape existing entities', () => {
    expect(escapeCodeContent('a &gt; b &amp;&amp; c')).toBe('a &gt; b &amp;&amp; c');
  });

  it('escapes a bare ampersand but preserves numeric/hex entities', () => {
    expect(escapeCodeContent('Tom & Jerry &#10; &#x41;')).toBe('Tom &amp; Jerry &#10; &#x41;');
  });
});

describe('repairHtmlCodeBlocks', () => {
  it('returns empty/falsy input unchanged', () => {
    expect(repairHtmlCodeBlocks('')).toBe('');
  });

  it('leaves content without code blocks untouched', () => {
    const html = '<h2>Findings</h2><p><strong>Severity:</strong> Blocker</p>';
    expect(repairHtmlCodeBlocks(html)).toBe(html);
  });

  it('escapes raw code inside a well-formed <pre><code> block', () => {
    const html = '<pre><code>if (a < b && c > d) {}</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>'
    );
  });

  it('preserves already-escaped code without double-escaping', () => {
    const html = '<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(html);
  });

  it('keeps surrounding document structure intact while escaping the block', () => {
    const html =
      '<p><strong>Problem:</strong> bad</p><pre><code>vector<int> v;</code></pre><p><strong>Why:</strong> fix</p>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<p><strong>Problem:</strong> bad</p><pre><code>vector&lt;int&gt; v;</code></pre><p><strong>Why:</strong> fix</p>'
    );
  });

  it('auto-closes an unterminated <pre><code> block at end of input', () => {
    const html = '<p>intro</p><pre><code>int x = a < b;';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<p>intro</p><pre><code>int x = a &lt; b;</code></pre>'
    );
  });

  it('adds a missing </code> when only </pre> closes the block', () => {
    const html = '<pre><code>a > b</pre>';
    expect(repairHtmlCodeBlocks(html)).toBe('<pre><code>a &gt; b</code></pre>');
  });

  it('handles multiple code blocks and only escapes their contents', () => {
    const html =
      '<pre><code>a < 1</code></pre><p>mid</p><pre><code>b > 2</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>a &lt; 1</code></pre><p>mid</p><pre><code>b &gt; 2</code></pre>'
    );
  });

  it('recovers a runaway first block that contains raw markup, keeping the tail well-formed', () => {
    // Mirrors the production failure: an unescaped/unclosed first code block
    // whose raw content includes what should be later structural tags. The
    // first </code></pre> bounds the block; everything after renders normally.
    const html =
      '<pre><code>bool ok = list->count() > 1 && other;</code></pre>' +
      '<p><strong>Why:</strong> restores logic</p><h2>Verdict</h2>';
    const repaired = repairHtmlCodeBlocks(html);

    expect(repaired).toContain('<pre><code>bool ok = list-&gt;count() &gt; 1 &amp;&amp; other;</code></pre>');
    expect(repaired).toContain('<p><strong>Why:</strong> restores logic</p><h2>Verdict</h2>');
  });

  it('normalizes attributes on pre/code openers to plain wrappers', () => {
    const html = '<pre class="x"><code data-lang="cpp">a < b</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe('<pre><code>a &lt; b</code></pre>');
  });

  it('converts <br/>, <br>, and <br /> inside a code block to newlines', () => {
    const html = '<pre><code>a();<br/>b();<br>c();<br />d();</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe('<pre><code>a();\nb();\nc();\nd();</code></pre>');
  });

  it('escapes raw markup while converting breaks in the same code block', () => {
    const html = '<pre><code>vector<int> v;<br/>v.push_back(1);</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>vector&lt;int&gt; v;\nv.push_back(1);</code></pre>'
    );
  });

  it('leaves <br/> outside code blocks intact', () => {
    const html = '<p>line one<br/>line two</p><pre><code>a();<br/>b();</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<p>line one<br/>line two</p><pre><code>a();\nb();</code></pre>'
    );
  });

  it('dedents a code block while keeping relative indentation', () => {
    const html = '<pre><code>    if (x) {\n        return;\n    }</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>if (x) {\n    return;\n}</code></pre>'
    );
  });

  it('strips a leading blank line before dedenting', () => {
    const html = '<pre><code>\n        if (!item.filament_preset)\n            continue;</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>if (!item.filament_preset)\n    continue;</code></pre>'
    );
  });

  it('expands leading tabs so nested code stays aligned', () => {
    const html = '<pre><code>\tif (x)\n\t\treturn;</code></pre>';
    expect(repairHtmlCodeBlocks(html)).toBe(
      '<pre><code>if (x)\n    return;</code></pre>'
    );
  });
});
