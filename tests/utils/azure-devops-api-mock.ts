/**
 * Mock for azure-devops-extension-api (main module) so Jest can run
 * without loading AMD bundles.
 */

export const CommonServiceIds = {
  LocationService: 'location',
  ProjectPageService: 'ms.vss-work-web.project-page-service',
  ExtensionDataService: 'ms.vss-features.extension-data-service',
};
const mockGetRepositories = jest.fn().mockResolvedValue([]);
export const getClient = jest.fn().mockReturnValue({ getRepositories: mockGetRepositories });
export const getService = jest.fn().mockResolvedValue({});

// Stub types / no-op implementations
export const IProjectPageService = {};
export const IExtensionDataService = {};
export const IExtensionDataManager = {};
export const ILocationService = {};
