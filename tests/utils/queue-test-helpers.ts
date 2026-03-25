import { enqueuePRJob } from '../../src/backend/queue/enqueue';
import { QueuedJobAuth, QueuedPRJob } from '../../src/backend/types';

export function createTestJob(overrides?: Partial<QueuedPRJob>): QueuedPRJob {
  return {
    jobId: overrides?.jobId ?? 'job-123',
    prId: overrides?.prId ?? 101,
    repo: overrides?.repo ?? 'repo-1',
    filesChanged: overrides?.filesChanged ?? ['src/example.ts'],
    timestamp: overrides?.timestamp ?? Date.now(),
    attempt: overrides?.attempt ?? 0,
    organizationUrl: overrides?.organizationUrl ?? 'https://dev.azure.com/myorg',
    requestedBy: overrides?.requestedBy ?? {
      id: 'user-1',
      displayName: 'Test User'
    }
  };
}

export function createTestAuth(overrides?: Partial<QueuedJobAuth>): QueuedJobAuth {
  return {
    accessToken: overrides?.accessToken ?? 'jwt-token',
    organizationUrl: overrides?.organizationUrl ?? 'https://dev.azure.com/myorg',
    tokenSource: 'sdk',
    storedAt: overrides?.storedAt ?? Date.now(),
    expiresAt: overrides?.expiresAt,
    requestedBy: overrides?.requestedBy ?? {
      id: 'user-1',
      displayName: 'Test User'
    }
  };
}

export async function enqueueTestJob(
  jobOverrides?: Partial<QueuedPRJob>,
  authOverrides?: Partial<QueuedJobAuth>
): Promise<{ job: QueuedPRJob; auth: QueuedJobAuth }> {
  const job = createTestJob(jobOverrides);
  const auth = createTestAuth(authOverrides);
  await enqueuePRJob(job, auth);
  return { job, auth };
}
