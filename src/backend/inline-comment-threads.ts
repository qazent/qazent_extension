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

export function buildThreadContext({
  filePath,
  line,
  side,
  lineLength,
}: {
  filePath: string;
  line: number;
  side: InlineCommentSide;
  lineLength?: number;
}): ThreadContext {
  const offsetEnd = Math.max(1, lineLength ?? 1);
  const start: CommentPosition = { line, offset: 1 };
  const end: CommentPosition = { line, offset: offsetEnd };
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
  const candidate = value as Partial<RawInlineComment> & { line?: unknown; severity?: unknown };
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
  return {
    filePath: candidate.filePath,
    line,
    side: candidate.side,
    contentHtml: candidate.contentHtml,
    ...(severity === 'Blocker' || severity === 'Major' || severity === 'Minor' || severity === 'Nit'
      ? { severity }
      : {}),
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
