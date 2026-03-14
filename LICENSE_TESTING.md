# License Testing Instructions

This document explains how to test license functionality in the PR Assistant extension frontend (Azure DevOps) and how to seed the Supabase database so the backend returns the expected license status. It uses the test org **https://dev.azure.com/qazent/test-extension**, with backend on **Render** and database on **Supabase**.

---

## Overview

The extension exposes a **License** panel under Project Settings. It calls the backend (e.g. `https://api.qazent.com`) for:

- **GET /license/status** – Current license status for the organization (active, expired, none, invalid, suspended).
- **POST /license/activate** – Activate a license key (validated via Lemon Squeezy).

Status is resolved by **organization slug** only. For `https://dev.azure.com/qazent/test-extension` the slug is **`qazent`**. The backend looks up `license_records` by this slug.

---

## What uses the database vs Lemon Squeezy API

**Lemon Squeezy API** is used only when:

- A user clicks **Activate** and submits a license key: the backend calls Lemon Squeezy to **validate** the key and get metadata (variant, expiry, activation limit). Validation and activation decisions (is the key valid? expired? disabled?) come from Lemon Squeezy.

**The database (Supabase)** is used for:

1. **License status (GET /license/status)** – The backend does **not** call Lemon Squeezy for status. It reads only from the database: one row per organization in `license_records`. So the badge (Active, Expired, No license), plan name, and expiry shown in the License panel all come from the database.
2. **Storing the result of activation** – After a successful Lemon Squeezy validation, the backend writes (or updates) a row in `license_records` and optionally `license_seat_assignments`, so that future status requests for that org return the right data.
3. **Enforcing one org per key** – Before accepting an activation, the backend checks the database to see if that license key (by hash) is already assigned to another Azure DevOps org.
4. **Seat limits** – Seat usage and limits are stored and checked in the database (and aligned with Lemon Squeezy metadata when activating).
5. **Webhooks** – When Lemon Squeezy sends webhooks (e.g. order_created, subscription_cancelled, license_key_updated), the backend updates the database so that status and plan stay in sync with Lemon Squeezy (e.g. subscription cancelled → mark license as inactive/expired in the DB).

So: **validation/activation** = Lemon Squeezy API; **what the frontend shows as “current license”** = database.

---

## How does the extension know if the license is valid?

There are two separate mechanisms; both matter for the paid/BYOL extension (e.g. `future_vss-extension.json`).

### 1. Azure DevOps marketplace (contribution visibility)

For **Paid** / **BYOL** extensions, the **Azure DevOps host** decides which contributions are visible using the **ContributionLicensingBehaviorType** for each contribution:

- **AlwaysInclude** (override in manifest) – The contribution is always shown. The extension uses this for **license-hub**, **pr-assistant-tab**, and **ai-context-settings-hub** so that: (1) users can always open the License panel to activate a key; (2) the PR Assistant tab and Settings hub are always visible, allowing the frontend to load and run backend-based license gating (GET /license/status) and show a “No valid license” message instead of the features disappearing.
- **OnlyIfLicensed** (default when not overridden) – The contribution is only shown when the host considers the **user licensed for the extension**. If `pr-assistant-tab` and `ai-context-settings-hub` are not set to AlwaysInclude, the marketplace hides them for unlicensed users and the frontend license-gate code never runs, so users see no explanation.
- **OnlyIfUnlicensed** – The contribution is only shown when the user is *not* licensed (e.g. for an “upgrade” or “buy” prompt).

So **when** are `ai-context-settings-hub` and `pr-assistant-tab` turned on? They are shown when the marketplace considers the user/org **licensed** for the extension. For **Paid** extensions that use **Microsoft’s commerce** (purchase/trial via the marketplace), “licensed” means the org has purchased or is within the trial period. For **BYOL** extensions, the marketplace does not handle the sale; Microsoft’s docs say the publisher provides the billing and licensing mechanism and that “in the future we remove the paid licensing check.” For BYOL today it is not fully documented when the host treats a user as “licensed”; it may be tied to installation, trial, or a separate entitlement. So:

- **In practice:** If you need **reliable** gating so that the PR tab and Settings hub are only usable when your **own** license (e.g. Lemon Squeezy + your backend) is valid, the safest approach is to **also** check your backend (GET /license/status) inside those hubs and show a “No license” or redirect when status is not active. The marketplace then controls first-level visibility; your backend controls actual feature access. A ready-to-use Cursor implementation prompt for this is in [docs/CURSOR_PROMPT_LICENSE_GATE.md](docs/CURSOR_PROMPT_LICENSE_GATE.md).
- **Summary:** The extension “knows” for visibility because the host only shows contributions that are not `AlwaysInclude` when it considers the user licensed. The extension does not call an API for this; the host hides the menu items when the user is not considered licensed. No extension code runs for hidden contributions.

### 2. Your backend (License panel and status)

The **License panel** is the only place in the extension that explicitly asks “does this org have a valid license?”:

- It calls **GET /license/status** on your backend (Render), sending the user’s Azure DevOps token and org URL.
- The backend looks up the org (e.g. slug `qazent`) in the **database** (Supabase) and returns `status`, `planName`, `expiresAt`, etc. It does **not** call Lemon Squeezy for this; it only reads from your DB.

So for the License panel, the extension “knows” by **calling your backend**; your backend “knows” from the **database** (and optionally from webhooks that keep the DB in sync with Lemon Squeezy).

The **PR Assistant tab** and **Settings hub** call the backend **GET /license/status** on load; when status is not `active`, they show a “No valid license” message and direct users to **Project Settings → QAZent - License**. For this gating to run, those contributions must be **AlwaysInclude** in the manifest so the marketplace does not hide them for unlicensed users.

---

## Prerequisites

- Access to the Azure DevOps org: **https://dev.azure.com/qazent/test-extension** (signed in as the test user, e.g. **oskisj8@gmail.com**).
- Backend on **Render** with:
  - **DATABASE_URL** – Supabase Postgres connection string (Session mode, port 5432, or Transaction pooler 6543).
  - **LICENSE_HASH_SALT** – Required for activation (any non-empty secret).
  - Optionally: **LICENSE_ALLOWED_PRODUCT_IDS=1400862** (product variant ID for Lemon Squeezy).
- **Supabase** project whose DB is used by Render via `DATABASE_URL`. Tables `license_records` and `license_seat_assignments` are created automatically by the backend on first use; you can also run the seed SQL below after the backend has created them (or create them manually using the schema in the backend).

---

## Opening the License Panel

1. Go to **https://dev.azure.com/qazent/test-extension**.
2. Open any **Project** (or the default project).
3. Go to **Project Settings** (gear icon in the bottom-left).
4. Under the project settings list, open **QAZent - License**.

The panel loads the License hub. It will call the backend (`backendUrl` from the extension manifest, e.g. `https://api.qazent.com`) with your Azure DevOps token and org URL.

---

## Testing Status (No License)

**Before seeding:**

1. Open the License panel as above.
2. You should see:
   - Status badge: **No license**
   - Message like: *"No license found for this organization. Enter a license key to activate."*
3. The **Enter License Key** section is available; you can paste a key and click **Activate** (activation requires a valid Lemon Squeezy key and backend config).

This confirms the frontend and backend are talking and that no license is stored for the org yet.

---

## Seeding the Database

Seeding is for **status and UI testing** without a real Lemon Squeezy key. The backend looks up licenses by **organization** = **`qazent`** (slug from the org URL).

### Tables

- **license_records** – One row per organization (org is UNIQUE). Drives status, plan name, expiry, seats.
- **license_seat_assignments** – Optional; links a user to a license for seat usage. Not required to show “Active” status.

### Step 1: Ensure tables exist

If the backend (Render) has already handled at least one license request, it will have created the tables. Otherwise, trigger any license endpoint once (e.g. open the License panel) so the backend can create them, or create them manually from `src/backend/license/postgres-store.ts` (CREATE TABLE statements).

### Step 2: Insert a license record for `qazent`

Run the following in the **Supabase SQL Editor** (or any Postgres client connected to the same DB as `DATABASE_URL`):

```sql
-- Seed: active license for org slug 'qazent'
-- Use a placeholder hash (64 hex chars); this row is for status display only, not for activation with this key.
INSERT INTO license_records (
  id,
  license_key_hash,
  lemon_license_id,
  lemon_order_id,
  lemon_customer_id,
  organization,
  status,
  plan,
  seats_used,
  seats_limit,
  expires_at,
  created_at,
  updated_at
) VALUES (
  'a1b2c3d4-e5f6-4789-a012-3456789abcde',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  NULL,
  NULL,
  NULL,
  'qazent',
  'active',
  'Pro',
  0,
  5,
  NOW() + INTERVAL '1 year',
  NOW(),
  NOW()
) ON CONFLICT (id) DO NOTHING;
```

- **organization** must be **`qazent`** (backend derives this from `https://dev.azure.com/qazent/...`).
- **license_key_hash** is a placeholder (64-char hex). Do not use a real key hash unless you intend to test activation with that key.
- **status** = `'active'`, **plan** = `'Pro'`, **expires_at** = future date so the panel shows “Active” and an expiry.

### Step 3 (optional): Assign a seat for the test user

To align seat counts with a specific user (e.g. **oskisj8@gmail.com**), add a seat row. The **user_id** in the database is the **Azure DevOps user GUID**, not the email. You can:

- Get it from backend logs (e.g. after opening the License panel or attempting activation), or
- Get it from Azure DevOps (user profile or API).

Replace `YOUR_ADO_USER_GUID` below with that GUID:

```sql
-- Optional: assign one seat for the test user (replace YOUR_ADO_USER_GUID with the real Azure DevOps user ID)
INSERT INTO license_seat_assignments (
  id,
  license_id,
  organization,
  user_id,
  created_at
) VALUES (
  'b2c3d4e5-f6a7-4890-b123-4567890bcdef',
  'a1b2c3d4-e5f6-4789-a012-3456789abcde',
  'qazent',
  'YOUR_ADO_USER_GUID',
  NOW()
) ON CONFLICT (license_id, organization, user_id) DO NOTHING;
```

Then update **seats_used** on the license record if you want it to match:

```sql
UPDATE license_records
SET seats_used = (
  SELECT COUNT(*) FROM license_seat_assignments
  WHERE license_id = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
),
updated_at = NOW()
WHERE id = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
```

---

## Testing Status (With Seed)

**After seeding `license_records` for `qazent`:**

1. Open the License panel again (or click **Refresh status**).
2. You should see:
   - Status badge: **Active**
   - Plan name: **Pro** (or whatever you set in `plan`)
   - Expires: the date you set in `expires_at`
   - Message indicating the license is active.

If you still see “No license”, check:

- **organization** in the row is exactly **`qazent`** (lowercase, no extra path).
- Render is using the same Supabase DB as where you ran the INSERT (`DATABASE_URL`).
- You are in the org **https://dev.azure.com/qazent/...** (backend derives the slug from the request).

---

## Testing Activation (Optional)

To test **activation** with a real Lemon Squeezy license key:

1. On **Render**, set:
   - **LICENSE_HASH_SALT**
   - **LEMON_SQUEEZY_API_KEY** (recommended)
   - Optionally **LICENSE_ALLOWED_PRODUCT_IDS=1400862** (product variant ID).
2. In the License panel, paste a valid Lemon Squeezy license key and click **Activate**.
3. The backend validates the key with Lemon Squeezy, then creates or updates `license_records` and `license_seat_assignments` in Supabase. You should see **Active** and a success message.

If you had a seed row for `qazent`, activation with a key tied to the same org may update that row (e.g. plan, expiry, hash). Seeding is mainly for status/UI; activation overwrites/upserts by key hash and org.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| **401 / 403** | Token or org URL: ensure you’re signed in to Azure DevOps and the backend receives `Authorization: Bearer <token>` and `X-Ado-Org-Url: https://dev.azure.com/qazent` (or similar). |
| **“No license” after seed** | (1) `organization` in DB is exactly `qazent`. (2) Render’s `DATABASE_URL` points to the same Supabase DB where you inserted. (3) You’re in the correct org in the browser. |
| **Activation fails** | Valid key, Lemon Squeezy API key on Render, `LICENSE_HASH_SALT` set. If you use product restrictions, add `LICENSE_ALLOWED_PRODUCT_IDS=1400862`. |
| **CORS errors** | Backend allows `dev.azure.com` origins; ensure the request is from the extension in that org. |

---

## Reference

- **Azure DevOps org:** https://dev.azure.com/qazent/test-extension  
- **Org slug (DB):** `qazent`  
- **Test user email:** oskisj8@gmail.com (for seats, use ADO user GUID in `user_id`)  
- **Product variant ID:** 1400862 (optional in `LICENSE_ALLOWED_PRODUCT_IDS`)  
- **Backend:** Render (env: `DATABASE_URL`, `LICENSE_HASH_SALT`, etc.)  
- **Database:** Supabase (Postgres)
