/**
 * Environment validation helpers for backend services.
 */

import * as logger from './logger';

export class MissingEnvironmentVariableError extends Error {
  readonly variableNames: readonly string[];

  constructor(variableNames: readonly string[]) {
    super(`Missing required environment variable${variableNames.length === 1 ? '' : 's'}: ${variableNames.join(', ')}`);
    this.name = 'MissingEnvironmentVariableError';
    this.variableNames = variableNames;
  }
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === '') {
    throw new MissingEnvironmentVariableError([name]);
  }

  return value.trim();
}

function getMissingEnv(requiredVariables: readonly string[]): string[] {
  return requiredVariables.filter((name) => {
    const value = process.env[name];
    return !value || value.trim() === '';
  });
}

export function validateServerEnvironment(requiredVariables: readonly string[]): void {
  const missing = getMissingEnv(requiredVariables);

  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export function validateQueueEnvironment(): void {
  const missing = getMissingEnv(['UPSTASH_REDIS_URL', 'UPSTASH_REDIS_TOKEN']);

  if (missing.length > 0) {
    throw new MissingEnvironmentVariableError(missing);
  }
}
