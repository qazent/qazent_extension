/**
 * Azure DevOps OAuth Token Validator
 *
 * Validates Azure DevOps access tokens obtained from SDK.getAccessToken()
 * by making a test API call to Azure DevOps connectionData endpoint.
 *
 * Implements caching to reduce API calls and improve performance.
 */
/**
 * User identity extracted from validated token
 */
export interface UserIdentity {
    id: string;
    displayName: string;
    email: string | null;
    organization: string;
}
/**
 * Validate Azure DevOps OAuth token
 *
 * @param token - Azure DevOps access token from SDK.getAccessToken()
 * @param orgUrl - Expected organization URL (e.g., https://dev.azure.com/myorg)
 * @returns User identity if token is valid
 * @throws Error if token is invalid or validation fails
 */
export declare function validateAzureDevOpsToken(token: string, orgUrl: string): Promise<UserIdentity>;
/**
 * Clear token from cache
 * Useful for testing or forcing re-validation
 */
export declare function clearTokenCache(token: string): void;
/**
 * Get cache statistics (for monitoring/debugging)
 */
export declare function getCacheStats(): {
    size: number;
    entries: number;
};
