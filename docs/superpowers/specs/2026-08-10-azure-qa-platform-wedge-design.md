# Azure QA Platform Wedge — Design Spec

**Date:** 2026-08-10  
**Product:** QAZent PR Assistant (Azure DevOps extension)  
**Status:** Approved for implementation planning  

## 1. Context

QAZent PR Assistant is a low-download Azure DevOps Marketplace extension competing with CodeRabbit. Today it offers manual, one-shot AI analysis from PR diffs (QA / Code Review / Deep Review modes), optional custom context, and output as a Task work item and/or PR comment. Auto-review via webhooks is intentionally disabled.

**Strategic choice for this initiative:** grow Marketplace installs and trial activations by owning an **Azure-native QA wedge** (Boards + Test Plans), not by matching CodeRabbit on auto-review or chatty multi-file review.

**Primary buyer:** QA / test leads.  
**Growth levers:** product depth *and* Marketplace listing, weighted equally.  
**Constraint:** remain **fully manual** (user clicks Analyze). No auto-analyze on PR create/update in this phase.

## 2. Goals and non-goals

### Goals

1. Position the product as *the AI QA layer inside Azure DevOps*: PR diffs → structured test assets in Boards / Test Plans.
2. Make the first successful Analyze produce a **native ADO artifact** (preferably a Test Case) worth keeping.
3. Align Marketplace overview, screenshots, and GIFs with that Boards/Test Plans story so installs and trials rise.
4. Preserve privacy posture: diff + PR metadata + commit messages + optional custom context only; user OAuth; no full-repo indexing.

### Non-goals (this phase)

- Auto-review / re-enabled service-hook analyze on PR create or update
- CodeRabbit-style inline multi-file review chat as the growth bet
- Full-repository or whole-file AI indexing beyond the PR diff
- Multi-turn refine chat (deferred; may return under a later “time-to-wow” initiative)
- Batch analyze across many PRs; dashboard widgets

### Success signals

- Primary: Marketplace installs and trial activations
- Secondary: share of QA-mode runs that create or link a **Test Case** (vs Task-only), once the feature ships

## 3. Positioning

**One-liner:** AI-powered test asset generation from real PR diffs, delivered as Azure Boards / Test Plans work — native to Azure DevOps.

**Vs CodeRabbit:** CodeRabbit wins on always-on code review. QAZent wins on **QA-native ADO artifacts** (Test Case WIT, Boards traceability, optional Test Plans suites), shift-left testing, and simple flat pricing — without requiring write/manage-code permissions or full-repo access.

## 4. Feature set (MVP)

Ordered for growth impact vs complexity. All flows remain click-to-Analyze.

### 4.1 Native Test Case work items (core)

- When the project process supports it, create a **Test Case** work item from QA-mode output (not only Task).
- Map AI output into Test Case fields: **v1 writes title + structured HTML into Description** (screenshot-friendly, process-agnostic). **Steps-field mapping** (Microsoft.VSTS.TCM.Steps or process-equivalent) is best-effort when field refs are confirmed; otherwise Description-only is success.
- If Test Case is unavailable, fall back to the configured alternate type (default **Task**) with clear user messaging.

### 4.2 Work item type and process awareness

- **Settings** store project defaults (preferred WIT, fallback WIT, optional default suite).
- **Hub** shows those defaults and allows a per-run override (WIT, parent, suite) without requiring a settings round-trip.
- Allowed types: Test Case, Task, Bug, User Story (allowlist).
- Detect types available in the project; do not silently fail when the preferred type is missing.
- Persist defaults in extension data (same pattern as existing AI context settings).

### 4.3 PR ↔ work item traceability

- Always link created work items to the PR via the existing artifact-link pattern.
- Optional: link to an **existing parent** work item (e.g. User Story / Feature) chosen by the QA lead at generate time or from settings.

### 4.4 Structured QA output tuned for ADO

- Retain QA structure: Purpose, Scope, Preconditions, Steps, Edge cases, Regression areas (and related sections already in the system prompt).
- Shape HTML (and later step fields) so results read well in Boards and in Marketplace screenshots.
- Review / Deep Review modes keep current Task/comment-oriented behavior; wedge features are **QA-mode primary**.

### 4.5 Thin Test Plans hook (phase 1b)

- Optional after generation (or via settings default): **Add to Test Suite** — select plan + suite, or use a configured default suite.
- If Test Plans is not licensed or APIs are unavailable, hide this path; core value still ships via Test Case WIT alone.

### 4.6 Listing and first-run mirror (same release theme)

- Rewrite Marketplace overview around QA outcomes (PR → Test Case in Boards, optional suite), not “another AI code reviewer.”
- GIF / screenshots showing Analyze → Test Case (+ optional suite).
- Hub empty / first-run copy: one sentence + primary CTA aligned with that story.

### Explicitly deferred

Multi-turn chat, inline review comments, auto-analyze, batch PRs, dashboards, configurable labels / regenerate-only UX (except where already trivial and needed for the above).

## 5. Architecture and data flow

Keep the existing spine; extend the **create** path.

```
User clicks Analyze (QA mode)
        ↓
POST /generate-tests
  (unchanged core: fetch diff + metadata → Gemini → title + htmlDescription)
        ↓
Extension applies prefs: workItemType, optional parentId, optional suite
        ↓
POST /create-work-item (extended)
  • workItemType (Test Case | Task | Bug | User Story, allowlisted)
  • field mapping for Test Case (description / steps)
  • PR artifact link (existing)
  • optional parent relation
        ↓
[phase 1b] POST /add-to-test-suite (optional)
  • planId + suiteId → add Test Case to suite
        ↓
Existing optional PR comment + label
```

### Component changes

| Component | Responsibility |
|-----------|----------------|
| **PR hub** | WIT selector; optional parent WI; optional add-to-suite; success UI with Boards / Test Plans links |
| **Settings hub** | Defaults: preferred WIT, fallback type, optional default suite; messaging when Test Case unavailable |
| **`ado-client`** | Generic create by type; process/type probe; Test Case field mapping; suite add API |
| **`server.ts` routes** | Accept new fields on create-work-item; new optional suite endpoint |
| **AI / system prompt** | QA structure unchanged in spirit; optional prompt tweak when target WIT is Test Case (step-friendly output) |
| **Marketplace content** | `overview.md` (+ assets) aligned to Boards/Test Plans story |

### Constraints to preserve

- Authenticate with the signed-in user’s Azure DevOps OAuth token (no long-lived server PAT for the main flow)
- Diff-only (+ metadata, commits, custom context) for AI
- Manual Analyze only
- Sanitize HTML before persistence (existing sanitizer path)

## 6. Error handling and edge cases

| Case | Behavior |
|------|----------|
| No Test Case type in process | Fall back to configured alternate (default Task); inform user; link to settings if useful |
| Test Case exists but Steps fields differ by process | v1 success = Description HTML; Steps mapping only when confirmed for that process |
| Missing create / Test Plans permissions | Surface clear ADO error; keep generated output visible in hub so work is not lost |
| Test Plans / suite APIs unavailable | Hide suite UI; Test Case (or fallback WIT) path still works |
| Invalid parent work item id | Skip parent link; still create item + PR link |
| Non-QA modes | No change to wedge defaults; do not force Test Case for review modes |

## 7. Rollout phases

1. **v1:** Work item type selection + Test Case creation + PR link + Marketplace listing refresh (overview + visuals)
2. **v1.1:** Parent work item link + default suite / add-to-suite
3. **Measure:** installs, trial starts, % of QA runs creating a Test Case

## 8. Testing strategy

- **Unit:** WIT allowlist validation; Test Case field mapping; fallback when preferred type missing
- **Integration (mocked ADO):** create Test Case + PR artifact link; optional suite add
- **Hub / settings UI:** selectors, fallback messaging, success links
- **Manual:** Agile, Scrum, and at least one custom process project; org with and without Test Plans

## 9. Open decisions resolved in this spec

| Topic | Decision |
|-------|----------|
| Growth priority | Installs / trial activations |
| Buyer | QA / test leads |
| Product vs listing | Equal weight |
| Auto-review | Out of scope; stay manual |
| Strategic approach | Azure QA platform wedge (not time-to-wow-first, not review-parity-first) |
| Test Plans | In design as phase 1b; v1 can ship without it |

## 10. Relationship to existing docs

- Supersedes the growth *direction* implied by competing on review-chat alone.
- Complements `docs/future-features.md` items that remain useful (configurable label, optional comment/label, regenerate/preview, link to existing WI) but those are **not** the primary wedge unless they directly support Test Case / Plans delivery.
- Does not re-enable the commented webhook path in `server.ts`.
