# Future Features – High Value, Low Complexity

Investigation of the current pipeline, features, and architecture with recommended next steps for the Azure DevOps PR Assistant extension.

---

## Current Pipeline (6 steps)

| Step | Description | Backend / ADO |
|------|-------------|----------------|
| 1 | Validate PR metadata (repo, project) | — |
| 2 | Analyze code diff | `GET` diff, send to AI |
| 3 | Generate AI test case | `POST /generate-tests` (Gemini), returns title + HTML description |
| 4 | Create work item | `POST /create-work-item` → ADO Task, linked to PR |
| 5 | Post PR comment | `POST /post-pr-comment` → work item link + optional Purpose/Scope comment |
| 6 | Post PR label | `POST /post-pr-label` → label e.g. "Test Case Generated" |

**Existing surface:** PR tab ("Generate Testcase"), Settings hub (project/repo AI context), backend (auth, rate limits, health). Webhook/queue exists in code but is disabled.

---

## Recommended Future Features (high value, not complex)

### 1. **Configurable PR label name**  
**Value:** High – teams can use their own tags (e.g. "QA", "Ready for QA", "Test Case Generated").  
**Complexity:** Low.  
**Implementation:**  
- Add a field in **AI Context Settings** (or contribution `backendUrl`-style) for “PR label when test case is generated”.  
- Store in extension data (project/repo level).  
- In the hub, read the value and pass it to `postPRLabel` instead of the hardcoded `'Test Case Generated'`.  
- Backend already accepts `labelName`; no API change.

---

### 2. **Work item type selection (Task / Bug / User Story)**  
**Value:** High – teams use different WITs for test cases.  
**Complexity:** Low.  
**Implementation:**  
- In the hub, add a dropdown (e.g. Task, Bug, User Story) or read from project process.  
- Pass `workItemType` in the create-work-item request body.  
- Backend: extend `handleCreateWorkItem` and `createTaskWorkItem` (or a small wrapper) to call `witApi.createWorkItem(..., workItemType)` instead of hardcoded `'Task'`.  
- Validate allowed types (e.g. from process or allowlist) to avoid abuse.

---

### 3. **Optional “Post comment” and “Add label”**  
**Value:** Medium–high – some teams want only the work item, no PR comment or label.  
**Complexity:** Low.  
**Implementation:**  
- Add two checkboxes (or two settings) in the hub: “Post comment on PR”, “Add label to PR” (default both true).  
- Or store in extension data (project/repo) and read on load.  
- In the pipeline, skip `postPRComment` / `postPRLabel` when unchecked.  
- No new backend endpoints; same APIs, called conditionally.

---

### 4. **“Regenerate” (preview without creating work item)**  
**Value:** High – users can regenerate or refine the test case before committing.  
**Complexity:** Medium–low.  
**Implementation:**  
- Add a “Regenerate” (or “Preview only”) button that calls only `POST /generate-tests` and shows the result in a card.  
- Reuse existing `TestCaseCard`-style UI; do **not** call create-work-item / comment / label.  
- Optional: “Regenerate with refinement” and pass current description or user text as `customContext`.  
- No new backend endpoints; reuse `/generate-tests`.

---

### 5. **Link PR to an existing work item**  
**Value:** High – traceability when the test case is tracked in an existing item.  
**Complexity:** Low–medium.  
**Implementation:**  
- In the hub, add an action “Link this PR to work item” plus work item ID input.  
- Backend: new endpoint (e.g. `POST /link-pr-to-work-item`) that takes `prId`, `projectName`, `repositoryId`, `workItemId`.  
- Use existing `buildPRArtifactUri` and Work Item Tracking API to add an ArtifactLink relation from the work item to the PR.  
- Requires one new endpoint and one ADO WIT call (add relation); no AI.

---

### 6. **Success message: “Label added”**  
**Value:** Low–medium – clarity that the label step ran.  
**Complexity:** Trivial.  
**Implementation:**  
- In the hub, when showing the final success message, append a line like “A comment and label have been added to this PR” (or vary text if comment/label are optional once feature 3 exists).

---

## Not recommended for “low complexity” (for reference)

- **Webhook re-enable** – Requires token storage and frontend token push; higher complexity and security surface.  
- **Dashboard widget** (“PRs with test case generated”) – New contribution type and REST usage; medium effort.  
- **Batch generate for multiple PRs** – Rate limits, error handling, and UX make it more complex.  
- **@mention reviewers in comment** – Need PR reviewers API and escaping; medium complexity.

---

## Suggested order of implementation

1. **Configurable PR label** (1) – quick win, no backend change.  
2. **Optional comment/label** (3) – improves fit for different team policies.  
3. **Work item type** (2) – one backend parameter and validation.  
4. **Regenerate / preview** (4) – improves UX with existing API.  
5. **Link PR to work item** (5) – one new endpoint, high traceability value.

This keeps the extension focused on the current “generate test case → work item → PR comment + label” flow while making it more configurable and adding a low-friction “preview/regenerate” and “link to existing item” path.
