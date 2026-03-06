/**
 * Mock for Azure DevOps extension SDK/API so Jest can run tests that import
 * backendClient or React components without loading AMD (define) bundles.
 */

export const init = jest.fn().mockResolvedValue(undefined);
export const getAccessToken = jest.fn().mockResolvedValue('mock-token');
export const getConfiguration = jest.fn().mockReturnValue({});
export const getExtensionContext = jest.fn().mockReturnValue({ id: 'test-extension-id', extensionId: 'pr-testcase-generator' });
export const getContributionId = jest.fn().mockReturnValue('pr-assistant-hub');
export const getHost = jest.fn().mockReturnValue({ name: 'test-host' });
export const ready = jest.fn().mockResolvedValue(undefined);
export const register = jest.fn();
export const getUser = jest.fn().mockReturnValue({ displayName: 'Test User' });

const mockLocationService = {
  getServiceLocation: jest.fn().mockResolvedValue('https://dev.azure.com/test'),
};
export const getService = jest.fn().mockResolvedValue(mockLocationService);

export default {
  init,
  getAccessToken,
  getConfiguration,
  getExtensionContext,
  getContributionId,
  getHost,
  ready,
  register,
  getService,
  getUser,
};
