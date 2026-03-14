# Cursor prompt: License gate for PR tab and Settings hub

Copy the block below into Cursor to implement backend-enforced license gating.

---

## Prompt (copy from here)

Implement license gating so the **PR Assistant tab** (Generate Testcase) and the **Settings hub** (QAZent - AI Context Settings) are only usable when the backend reports an active license. The backend is the single source of truth; call it on load and block the main UI until the license is valid.

### Requirements

1. **On load (after SDK init and once backendUrl is available)**  
   In both hubs, call the existing **GET /license/status** via `getLicenseStatus(baseUrl)` from `src/license/api.ts`. Use the same `backendUrl` each hub already gets (or should get) from the extension contribution: `SDK.getExtensionContext()` → find contribution by `SDK.getContributionId()` → `contribution.properties.backendUrl`, with fallback `'https://api.qazent.com'`.

2. **When status is not `'active'`**  
   Do not render the main hub content (PR form and generate button, or settings form). Instead show a single, clear **“No valid license”** state:
   - Short message, e.g. “A valid license is required to use this feature.”
   - Instruct users to activate a license: “Go to **Project Settings → QAZent - License** to enter your license key.”
   - Use the same Fluent UI theme (e.g. `FluentProvider`, `webLightTheme`) and styling as the rest of the extension. No need for a redirect; just replace the main content with this message.

3. **When status is `'active'`**  
   Render the existing hub content as today (no change in behavior).

4. **Loading and errors**  
   - While the license check is in progress, show a loading state (e.g. Spinner with “Checking license…”).
   - If the request fails (network or server error), treat it as **no valid license**: show the same “No valid license” message and the same hint to go to Project Settings → QAZent - License. Optionally append a short line like “If the problem persists, check your network or try again later.”

### Files to change

- **`src/hub/PRAssistantHub.tsx`**  
  - In the init path (e.g. in the same `useEffect` where you set `backendUrl` and load PR context), after `backendUrl` is set, call `getLicenseStatus(backendUrl)`.
  - Add state for license gate: e.g. `licenseStatus: 'loading' | 'active' | 'none'` (or reuse the response `status`).
  - If `licenseStatus !== 'active'`, render only the license-gate UI (message + “Go to Project Settings → QAZent - License”). Otherwise render the existing PR hub content.

- **`src/settings/SettingsHub.tsx`**  
  - Ensure `backendUrl` is available (same pattern as PRAssistantHub: extension context → contribution by contributionId → `properties.backendUrl`). If it is not currently stored, add state for it and set it in init.
  - In init, after SDK ready and backendUrl available, call `getLicenseStatus(backendUrl)`.
  - Add the same license-gate state and conditional: if not active, render only the “No valid license” message and the same hint; otherwise render the existing settings form.

### Implementation notes

- Reuse **`getLicenseStatus`** and **`LicenseStatusResponse`** from **`src/license/api.ts`**. No backend or API changes.
- Keep the gate logic minimal and consistent in both hubs (same copy and behavior). You may introduce a small shared component (e.g. `LicenseGateMessage`) or a shared snippet to avoid duplication.
- Do not change the License panel (`src/license/`) or the backend; only add the check and the “No valid license” UI in the two hubs above.

---

## End of prompt
