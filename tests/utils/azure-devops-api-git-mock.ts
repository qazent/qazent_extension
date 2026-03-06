/**
 * Mock for azure-devops-extension-api/Git so Jest can run
 * without loading AMD bundles.
 */

export const GitRestClient = jest.fn().mockImplementation(() => ({}));
export const GitRepository = {};
