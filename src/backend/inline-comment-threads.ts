import { CodeDiff, DiffChange } from './types';
import { MAX_INLINE_COMMENTS, normalizeDiffPath, toAdoThreadFilePath } from './diff-config';
import * as logger from './utils/logger';

export type InlineCommentSide = 'left' | 'right';
export type InlineCommentSkipReason = 'unknown_file' | 'invalid_line' | 'side_mismatch' | 'missing_iteration';
export type InlineCommentSeverity = 'Blocker' | 'Major' | 'Minor' | 'Nit';

export interface RawInlineComment {
  filePath: string;
  line: number;
  side: InlineCommentSide;
  contentHtml: string;
  severity?: InlineCommentSeverity;
  offset?: number;
  endOffset?: number;
  suggestedCode?: string;
}

export interface CommentPosition {
  line: number;
  offset: number;
}

export interface ThreadContext {
  filePath: string;
  leftFileEnd: CommentPosition | null;
  leftFileStart: CommentPosition | null;
  rightFileEnd: CommentPosition | null;
  rightFileStart: CommentPosition | null;
}

export interface PullRequestThreadContext {
  changeTrackingId: number;
  iterationContext: {
    firstComparingIteration: number;
    secondComparingIteration: number;
  };
}

export interface ResolvedInlineCommentThread {
  comments: Array<{
    parentCommentId: 0;
    content: string;
    commentType: 1;
  }>;
  status: 1;
  threadContext: ThreadContext;
  pullRequestThreadContext: PullRequestThreadContext;
}

export interface SkippedInlineComment {
  filePath?: string;
  line?: number;
  reason: InlineCommentSkipReason;
}

export interface ResolveInlineCommentThreadsResult {
  inlineComments: ResolvedInlineCommentThread[];
  acceptedComments: RawInlineComment[];
  skippedInlineComments: SkippedInlineComment[];
}

export function parseNumericLine(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

const SEVERITY_RANK: Record<string, number> = {
  Blocker: 0,
  Major: 1,
  Minor: 2,
  Nit: 3,
};

function stripLineNumberAnnotations(line: string): string {
  return line.replace(/^(?:old:\d+\s+)?(?:new:\d+\s+)?/, '');
}

function parseUnifiedBodyLine(line: string): { kind: 'add' | 'del' | 'ctx'; text: string } | null {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return null;
  }
  if (line.startsWith('+')) {
    return { kind: 'add', text: line.startsWith('+ ') ? line.slice(2) : line.slice(1) };
  }
  if (line.startsWith('-')) {
    return { kind: 'del', text: line.startsWith('- ') ? line.slice(2) : line.slice(1) };
  }
  if (line.startsWith(' ')) {
    return { kind: 'ctx', text: line.startsWith('  ') ? line.slice(2) : line.slice(1) };
  }
  return null;
}

export function getLineTextFromUnifiedDiff(
  diffContent: string,
  line: number,
  side: InlineCommentSide
): string | undefined {
  if (!diffContent || line < 1) {
    return undefined;
  }

  let oldLine = 0;
  let newLine = 0;
  for (const raw of diffContent.split('\n')) {
    const body = stripLineNumberAnnotations(raw);
    const hunk = body.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    const parsed = parseUnifiedBodyLine(body);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === 'add') {
      if (side === 'right' && newLine === line) {
        return parsed.text;
      }
      newLine += 1;
      continue;
    }
    if (parsed.kind === 'del') {
      if (side === 'left' && oldLine === line) {
        return parsed.text;
      }
      oldLine += 1;
      continue;
    }
    if ((side === 'left' ? oldLine : newLine) === line) {
      return parsed.text;
    }
    oldLine += 1;
    newLine += 1;
  }
  return undefined;
}

function firstCodeSnippet(contentHtml: string): string | undefined {
  const withoutPre = contentHtml.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
  const match = withoutPre.match(/<code>([\s\S]*?)<\/code>/i);
  const snippet = match?.[1]?.replace(/<[^>]+>/g, '').trim();
  return snippet || undefined;
}

export function applySuggestedCode(
  contentHtml: string,
  options?: { suggestedCode?: string }
): string {
  const suggestedCode = options?.suggestedCode;
  if (typeof suggestedCode !== 'string' || suggestedCode.trim() === '') {
    return contentHtml;
  }
  if (/<strong>\s*Suggested code:\s*<\/strong>/i.test(contentHtml)) {
    return contentHtml;
  }
  return `${contentHtml}<p><strong>Suggested code:</strong></p><pre><code>${suggestedCode}</code></pre>`;
}

function clampCommentOffset(value: number | undefined, fallback: number, maxOffset: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return Math.min(Math.max(1, fallback), maxOffset);
  }
  const oneBased = value === 0 ? 1 : value;
  return Math.min(Math.max(1, oneBased), maxOffset);
}

export function resolveCommentSpanOffsets({
  lineText,
  startOffset,
  endOffset,
  contentHtml,
}: {
  lineText?: string;
  startOffset?: number;
  endOffset?: number;
  contentHtml?: string;
}): { start: number; end: number } {
  const length = lineText?.length ?? 0;
  const hasExplicit = typeof startOffset === 'number' || typeof endOffset === 'number';
  if (hasExplicit) {
    const maxOffset = Math.max(1, length, startOffset ?? 0, endOffset ?? 0);
    const start = clampCommentOffset(startOffset, 1, maxOffset);
    const end = clampCommentOffset(endOffset, length || maxOffset, maxOffset);
    return end < start ? { start, end: start } : { start, end };
  }

  if (lineText && contentHtml) {
    const snippet = firstCodeSnippet(contentHtml);
    if (snippet) {
      const index = lineText.indexOf(snippet);
      if (index >= 0) {
        return { start: index + 1, end: index + snippet.length };
      }
    }
  }

  if (!lineText || length === 0) {
    return { start: 1, end: 1 };
  }

  const startIndex = lineText.search(/\S/);
  if (startIndex < 0) {
    return { start: 1, end: Math.max(1, length) };
  }
  let endIndex = length - 1;
  while (endIndex > startIndex && /\s/.test(lineText[endIndex] ?? '')) {
    endIndex -= 1;
  }
  return { start: startIndex + 1, end: endIndex + 1 };
}

export function buildThreadContext({
  filePath,
  line,
  side,
  lineLength,
  startOffset,
  endOffset,
}: {
  filePath: string;
  line: number;
  side: InlineCommentSide;
  lineLength?: number;
  startOffset?: number;
  endOffset?: number;
}): ThreadContext {
  const maxOffset = Math.max(1, lineLength ?? 0, startOffset ?? 0, endOffset ?? 0);
  const startOffsetResolved = clampCommentOffset(startOffset, 1, maxOffset);
  const endOffsetResolved = clampCommentOffset(endOffset ?? lineLength, maxOffset, maxOffset);
  const start: CommentPosition = { line, offset: startOffsetResolved };
  const end: CommentPosition = {
    line,
    offset: Math.max(startOffsetResolved, endOffsetResolved),
  };
  const adoPath = toAdoThreadFilePath(filePath);

  if (side === 'left') {
    return {
      filePath: adoPath,
      leftFileStart: start,
      leftFileEnd: end,
      rightFileStart: null,
      rightFileEnd: null,
    };
  }

  return {
    filePath: adoPath,
    leftFileStart: null,
    leftFileEnd: null,
    rightFileStart: start,
    rightFileEnd: end,
  };
}

export function buildPullRequestThreadContext({
  changeTrackingId,
  latestIterationId,
  firstComparingIteration,
}: {
  changeTrackingId: number;
  latestIterationId: number;
  firstComparingIteration?: number;
}): PullRequestThreadContext {
  const first =
    typeof firstComparingIteration === 'number' &&
    Number.isInteger(firstComparingIteration) &&
    firstComparingIteration >= 1 &&
    firstComparingIteration <= latestIterationId
      ? firstComparingIteration
      : 1;
  return {
    changeTrackingId,
    iterationContext: {
      firstComparingIteration: first,
      secondComparingIteration: latestIterationId,
    },
  };
}

function findChange(codeDiff: CodeDiff, filePath: string): DiffChange | undefined {
  const needle = normalizeDiffPath(filePath).toLowerCase();
  return codeDiff.changes.find(
    (change) => normalizeDiffPath(change.filePath).toLowerCase() === needle
  );
}

export function coerceRawComment(value: unknown): RawInlineComment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<RawInlineComment> & {
    line?: unknown;
    offset?: unknown;
    endOffset?: unknown;
    suggestedCode?: unknown;
    severity?: unknown;
  };
  const line = parseNumericLine(candidate.line);
  if (
    typeof candidate.filePath !== 'string' ||
    typeof line !== 'number' ||
    (candidate.side !== 'left' && candidate.side !== 'right') ||
    typeof candidate.contentHtml !== 'string'
  ) {
    return null;
  }
  const severity = candidate.severity;
  const offset = parseNumericLine(candidate.offset);
  const endOffset = parseNumericLine(candidate.endOffset);
  const suggestedCode =
    typeof candidate.suggestedCode === 'string' && candidate.suggestedCode.trim() !== ''
      ? candidate.suggestedCode
      : undefined;
  return {
    filePath: candidate.filePath,
    line,
    side: candidate.side,
    contentHtml: applySuggestedCode(candidate.contentHtml, { suggestedCode }),
    ...(severity === 'Blocker' || severity === 'Major' || severity === 'Minor' || severity === 'Nit'
      ? { severity }
      : {}),
    ...(typeof offset === 'number' && offset >= 0 ? { offset } : {}),
    ...(typeof endOffset === 'number' && endOffset >= 0 ? { endOffset } : {}),
    ...(suggestedCode ? { suggestedCode } : {}),
  };
}

function skip(
  skippedInlineComments: SkippedInlineComment[],
  reason: InlineCommentSkipReason,
  filePath?: string,
  line?: number
): void {
  skippedInlineComments.push({ filePath, line, reason });
  logger.warn('Skipping inline comment', { reason, filePath, line });
}

export function resolveInlineCommentThreads(
  raw: unknown,
  codeDiff: CodeDiff
): ResolveInlineCommentThreadsResult {
  const items = Array.isArray(raw) ? raw : [];
  const skippedInlineComments: SkippedInlineComment[] = [];
  const ranked: Array<{
    thread: ResolvedInlineCommentThread;
    accepted: RawInlineComment;
    rank: number;
  }> = [];

  for (const item of items) {
    const comment = coerceRawComment(item);
    if (!comment) {
      skip(skippedInlineComments, 'invalid_line');
      continue;
    }

    const change = findChange(codeDiff, comment.filePath);
    if (!change) {
      skip(skippedInlineComments, 'unknown_file', comment.filePath, comment.line);
      continue;
    }

    if (comment.line < 1) {
      skip(skippedInlineComments, 'invalid_line', comment.filePath, comment.line);
      continue;
    }

    if (comment.side === 'right' && change.changeType === 'delete') {
      skip(skippedInlineComments, 'side_mismatch', comment.filePath, comment.line);
      continue;
    }

    if (comment.side === 'left' && change.changeType === 'add') {
      skip(skippedInlineComments, 'side_mismatch', comment.filePath, comment.line);
      continue;
    }

    const lineCount = comment.side === 'right' ? change.newLineCount : change.oldLineCount;
    if (typeof lineCount === 'number' && comment.line > lineCount) {
      skip(skippedInlineComments, 'invalid_line', comment.filePath, comment.line);
      continue;
    }
    if (typeof lineCount !== 'number') {
      logger.warn('Inline comment line counts missing; posting without range check', {
        filePath: comment.filePath,
        line: comment.line,
      });
    }

    if (
      typeof change.changeTrackingId !== 'number' ||
      typeof codeDiff.latestIterationId !== 'number'
    ) {
      skip(skippedInlineComments, 'missing_iteration', comment.filePath, comment.line);
      continue;
    }

    const lineText = getLineTextFromUnifiedDiff(change.diffContent, comment.line, comment.side);
    const span = resolveCommentSpanOffsets({
      lineText,
      startOffset: comment.offset,
      endOffset: comment.endOffset,
      contentHtml: comment.contentHtml,
    });

    ranked.push({
      rank: SEVERITY_RANK[comment.severity ?? ''] ?? 4,
      accepted: comment,
      thread: {
        comments: [
          {
            parentCommentId: 0,
            content: comment.contentHtml,
            commentType: 1,
          },
        ],
        status: 1,
        threadContext: buildThreadContext({
          filePath: comment.filePath,
          line: comment.line,
          side: comment.side,
          lineLength: lineText?.length,
          startOffset: span.start,
          endOffset: span.end,
        }),
        pullRequestThreadContext: buildPullRequestThreadContext({
          changeTrackingId: change.changeTrackingId,
          latestIterationId: codeDiff.latestIterationId,
          firstComparingIteration: codeDiff.firstComparingIteration,
        }),
      },
    });
  }

  ranked.sort((left, right) => left.rank - right.rank);
  const dropped = ranked.slice(MAX_INLINE_COMMENTS);
  if (dropped.length > 0) {
    logger.warn('Dropped extra inline comments after severity cap', { dropped: dropped.length });
    for (const entry of dropped) {
      skip(skippedInlineComments, 'invalid_line', entry.accepted.filePath, entry.accepted.line);
    }
  }

  const kept = ranked.slice(0, MAX_INLINE_COMMENTS);
  return {
    inlineComments: kept.map((entry) => entry.thread),
    acceptedComments: kept.map((entry) => entry.accepted),
    skippedInlineComments,
  };
}
