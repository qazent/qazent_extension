/**
 * Configuration Service
 * Manages backend URL configuration using Azure DevOps Extension Data Service
 */

import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IExtensionDataService } from "azure-devops-extension-api";

const CONFIG_COLLECTION = "config";
const CONFIG_DOCUMENT_ID = "backend-settings";
const DEFAULT_BACKEND_URL = "api.qazent.com";

interface BackendConfigDocument {
  id: string;
  backendUrl: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Get configured backend URL from extension storage, or return default if not set
 */
export async function getBackendUrl(): Promise<string> {
  try {
    const dataService = await SDK.getService<IExtensionDataService>(
      CommonServiceIds.ExtensionDataService
    );

    const dataManager = await dataService.getExtensionDataManager(
      "QAZent.pr-assistant-extension",
      await SDK.getAccessToken()
    );

    const document = await dataManager.getDocument(
      CONFIG_COLLECTION,
      CONFIG_DOCUMENT_ID
    ) as BackendConfigDocument;

    return document.backendUrl || DEFAULT_BACKEND_URL;
  } catch (err: any) {
    const typeKey = err?.typeKey || "";

    // Normal for first-time use - document doesn't exist yet
    if (
      typeKey === "DocumentNotFoundException" ||
      typeKey === "CollectionNotFoundException"
    ) {
      console.log("Backend URL not configured, using default");
      return DEFAULT_BACKEND_URL;
    }

    // Network or auth errors - log and return default
    console.error("Failed to load backend URL:", err);
    return DEFAULT_BACKEND_URL;
  }
}

/**
 * Save backend URL to extension storage
 * @throws Error if URL validation fails or storage operation fails
 */
export async function setBackendUrl(url: string): Promise<void> {
  // Validate URL format first
  const validation = validateBackendUrl(url);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  try {
    const dataService = await SDK.getService<IExtensionDataService>(
      CommonServiceIds.ExtensionDataService
    );

    const dataManager = await dataService.getExtensionDataManager(
      "QAZent.pr-assistant-extension",
      await SDK.getAccessToken()
    );

    const user = SDK.getUser();
    const document: BackendConfigDocument = {
      id: CONFIG_DOCUMENT_ID,
      backendUrl: url,
      updatedAt: new Date().toISOString(),
      updatedBy: user.displayName || user.name || "Unknown"
    };

    await dataManager.setDocument(CONFIG_COLLECTION, document);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to save backend URL: ${message}`);
  }
}

/**
 * Validate backend URL format
 * @returns Object with valid flag and optional error message
 */
export function validateBackendUrl(url: string): { valid: boolean; error?: string } {
  // Check if URL is empty
  if (!url || url.trim() === "") {
    return { valid: false, error: "URL is required" };
  }

  // Check if URL starts with http:// or https://
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { valid: false, error: "URL must start with http:// or https://" };
  }

  // Check if URL is parseable
  try {
    new URL(url);
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}
