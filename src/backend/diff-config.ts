import { DiffChange, DiffChangeType } from './types';

export const GEMINI_MODEL_NAME = 'gemini-3.1-pro-preview';
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TARGET_USER_PROMPT_TOKENS = 12000;

export const MAX_PR_DESCRIPTION_CHARS = 1600;
export const MAX_REPOSITORY_CONTEXT_CHARS = 4000;
export const MAX_DIFF_LINES_PER_FILE = 80;
export const MAX_FILES_WITH_DIFF = 32;

export const MAX_PR_DESCRIPTION_CHARS_STRICT = 900;
export const MAX_REPOSITORY_CONTEXT_CHARS_STRICT = 2500;
export const MAX_DIFF_LINES_PER_FILE_STRICT = 24;
export const MAX_FILES_WITH_DIFF_STRICT = 20;

export const DIFF_MAX_CHARS_PER_FILE = 6000;
export const DIFF_CONTEXT_LINES = 8;
export const MAX_SYNTHETIC_DIFF_LINES = 120;
export const MAX_FILES_FOR_AI = 120;
export const ITERATION_CHANGES_PAGE_SIZE = 200;

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.cs', '.java', '.kt', '.go', '.py', '.rb', '.php',
  '.swift', '.scala', '.rs', '.sql', '.yml', '.yaml',
  '.xml', '.html', '.css', '.scss'
]);

const HIGH_SIGNAL_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'webpack.config.js',
  'webpack.config.ts'
]);

export function classifyChangeType(changeType: unknown): DiffChangeType {
  const changeTypeStr = String(changeType ?? '').toLowerCase();
  if (changeTypeStr.includes('add')) {
    return 'add';
  }
  if (changeTypeStr.includes('delete')) {
    return 'delete';
  }
  return 'edit';
}

export function normalizeDiffPath(filePath: string): string {
  return filePath.replace(/^\/+/, '');
}

export function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split('\n').length;
}

export function getFallbackLineMetrics(changeType: DiffChangeType): { linesAdded: number; linesDeleted: number } {
  if (changeType === 'add') {
    return { linesAdded: 10, linesDeleted: 0 };
  }
  if (changeType === 'delete') {
    return { linesAdded: 0, linesDeleted: 10 };
  }
  return { linesAdded: 5, linesDeleted: 5 };
}

export function rankDiffChange(change: DiffChange): number {
  const normalizedPath = normalizeDiffPath(change.filePath).toLowerCase();
  const baseName = normalizedPath.split('/').pop() ?? normalizedPath;
  const extension = baseName.includes('.') ? `.${baseName.split('.').pop()}` : '';
  const totalTouchedLines = change.linesAdded + change.linesDeleted;

  let score = Math.min(totalTouchedLines, 400);

  if (change.changeType === 'add') {
    score += 45;
  } else if (change.changeType === 'edit') {
    score += 30;
  } else {
    score += 18;
  }

  if (SOURCE_FILE_EXTENSIONS.has(extension)) {
    score += 30;
  }

  if (HIGH_SIGNAL_FILE_NAMES.has(baseName)) {
    score += 15;
  }

  if (/\/tests?\//.test(normalizedPath) || /\.(spec|test)\./.test(baseName)) {
    score += 10;
  }

  if (/\/migrations?\//.test(normalizedPath) || extension === '.sql') {
    score += 8;
  }

  return score;
}
