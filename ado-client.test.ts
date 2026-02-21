/**
 * Unit tests for Azure DevOps client artifact URI construction
 */

import { buildPRArtifactUri } from './ado-client';
import { PRMetadata } from './types';
import { describe, it, expect } from '@jest/globals';


describe('buildPRArtifactUri', () => {
    const mockMetadata: PRMetadata = {
    prId: 2,
    title: "Test PR",
    description: "Some description",
    repositoryId: "e5f6g7h8-i9j0-1234-5678-abcdef123456",
    repositoryName: "my-repo",
    projectName: "my-project",
    projectId: "a1b2c3d4-e5f6-7890-abcd-1234567890ab",
    sourceBranch: "refs/heads/feature/test",
    targetBranch: "refs/heads/main",
    author: "John Doe",
    authorEmail: "john@example.com",
    createDate: new Date(),
    branchName: "feature/test"
  };
  console.log(mockMetadata);

  it('should construct correct vstfs artifact URI format', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).toBe(
      'vstfs:///Git/PullRequestId/a1b2c3d4-e5f6-7890-abcd-1234567890ab%2Fe5f6g7h8-i9j0-1234-5678-abcdef123456%2F2'
    );
  });

  it('should start with vstfs:/// protocol', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).toMatch(/^vstfs:\/\/\/Git\/PullRequestId\//);
  });

  it('should contain exactly 2 URL-encoded separators (%2F)', () => {
    const result = buildPRArtifactUri(mockMetadata);
    const separatorCount = (result.match(/%2F/g) || []).length;
    expect(separatorCount).toBe(2);
  });

  it('should preserve projectId GUID exactly', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).toContain(mockMetadata.projectId);
  });

  it('should preserve repositoryId GUID exactly', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).toContain(mockMetadata.repositoryId);
  });

  it('should end with PR ID number', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).toMatch(/\/2$/);
  });

  it('should handle numeric prId correctly', () => {
    const metadata = { ...mockMetadata, prId: 123 };
    const result = buildPRArtifactUri(metadata);
    expect(result).toMatch(/%2F123$/);
  });

  it('should handle large PR ID numbers', () => {
    const metadata = { ...mockMetadata, prId: 999999 };
    const result = buildPRArtifactUri(metadata);
    expect(result).toMatch(/%2F999999$/);
  });

  it('should throw error when projectId is missing', () => {
    const metadata = { ...mockMetadata, projectId: '' };
    expect(() => buildPRArtifactUri(metadata)).toThrow('Missing required IDs for PR artifact URI construction');
  });

  it('should throw error when repositoryId is missing', () => {
    const metadata = { ...mockMetadata, repositoryId: '' };
    expect(() => buildPRArtifactUri(metadata)).toThrow('Missing required IDs for PR artifact URI construction');
  });

  it('should throw error when prId is null', () => {
    const metadata = { ...mockMetadata, prId: null as any };
    expect(() => buildPRArtifactUri(metadata)).toThrow('Missing required IDs for PR artifact URI construction');
  });

  it('should throw error when prId is undefined', () => {
    const metadata = { ...mockMetadata, prId: undefined as any };
    expect(() => buildPRArtifactUri(metadata)).toThrow('Missing required IDs for PR artifact URI construction');
  });

  it('should handle lowercase GUIDs', () => {
    const metadata = {
      ...mockMetadata,
      projectId: 'aabbccdd-eeff-1122-3344-556677889900',
      repositoryId: 'ffeeddcc-bbaa-9988-7766-554433221100'
    };
    const result = buildPRArtifactUri(metadata);
    expect(result).toContain('aabbccdd-eeff-1122-3344-556677889900');
    expect(result).toContain('ffeeddcc-bbaa-9988-7766-554433221100');
  });

  it('should handle uppercase GUIDs', () => {
    const metadata = {
      ...mockMetadata,
      projectId: 'AABBCCDD-EEFF-1122-3344-556677889900',
      repositoryId: 'FFEEDDCC-BBAA-9988-7766-554433221100'
    };
    const result = buildPRArtifactUri(metadata);
    expect(result).toContain('AABBCCDD-EEFF-1122-3344-556677889900');
    expect(result).toContain('FFEEDDCC-BBAA-9988-7766-554433221100');
  });

  it('should handle mixed case GUIDs', () => {
    const metadata = {
      ...mockMetadata,
      projectId: 'AaBbCcDd-EeFf-1122-3344-556677889900',
      repositoryId: 'FfEeDdCc-BbAa-9988-7766-554433221100'
    };
    const result = buildPRArtifactUri(metadata);
    expect(result).toContain('AaBbCcDd-EeFf-1122-3344-556677889900');
    expect(result).toContain('FfEeDdCc-BbAa-9988-7766-554433221100');
  });

  it('should handle prId of 0', () => {
    const metadata = { ...mockMetadata, prId: 0 };
    // prId 0 is technically invalid for Azure DevOps, but should not throw due to falsy check
    // The function checks for null/undefined, not falsy values
    const result = buildPRArtifactUri(metadata);
    expect(result).toMatch(/%2F0$/);
  });

  it('should produce consistent results for same input', () => {
    const result1 = buildPRArtifactUri(mockMetadata);
    const result2 = buildPRArtifactUri(mockMetadata);
    expect(result1).toBe(result2);
  });

  it('should produce different URIs for different PRs', () => {
    const metadata1 = { ...mockMetadata, prId: 1 };
    const metadata2 = { ...mockMetadata, prId: 2 };
    const result1 = buildPRArtifactUri(metadata1);
    const result2 = buildPRArtifactUri(metadata2);
    expect(result1).not.toBe(result2);
  });

  it('should produce different URIs for different projects', () => {
    const metadata1 = { ...mockMetadata, projectId: '11111111-1111-1111-1111-111111111111' };
    const metadata2 = { ...mockMetadata, projectId: '22222222-2222-2222-2222-222222222222' };
    const result1 = buildPRArtifactUri(metadata1);
    const result2 = buildPRArtifactUri(metadata2);
    expect(result1).not.toBe(result2);
  });

  it('should produce different URIs for different repositories', () => {
    const metadata1 = { ...mockMetadata, repositoryId: '11111111-1111-1111-1111-111111111111' };
    const metadata2 = { ...mockMetadata, repositoryId: '22222222-2222-2222-2222-222222222222' };
    const result1 = buildPRArtifactUri(metadata1);
    const result2 = buildPRArtifactUri(metadata2);
    expect(result1).not.toBe(result2);
  });

  it('should not include organization URL', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).not.toContain('dev.azure.com');
    expect(result).not.toContain('http');
    expect(result).not.toContain('https');
  });

  it('should not include human-readable names', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).not.toContain(mockMetadata.projectName);
    expect(result).not.toContain(mockMetadata.repositoryName);
  });

  it('should not include _git path', () => {
    const result = buildPRArtifactUri(mockMetadata);
    expect(result).not.toContain('_git');
  });

  it('should not contain unencoded forward slashes after protocol', () => {
    const result = buildPRArtifactUri(mockMetadata);
    const afterProtocol = result.substring('vstfs:///'.length);
    const unencodedSlashes = afterProtocol.split('/').length - 1;
    // Should only have one unencoded slash in "Git/PullRequestId"
    expect(unencodedSlashes).toBe(1);
  });
});

