# Zoho OAuth & Permissions Setup Prerequisites

## 1. Zoho Organization Account

### Requirements

Before integrating the HR Chat Assistant with Zoho APIs, ensure the following prerequisites are completed:

* Active Zoho account
* Admin access to Zoho People organization
* Permission to create OAuth clients in Zoho API Console

---

# API Console Setup

## 2. Create Server-to-Server OAuth Client

### Step 1: Open Zoho API Console

Navigate to:

* Zoho API Console

---

### Step 2: Create OAuth Client

1. Click **Add Client**
2. Select:

   * **Server-based Applications**
3. Fill the required fields:

   * Client Name
   * Homepage URL
   * Authorized Redirect URI

---

### Development Redirect URI Example

```env
http://localhost:3000/auth/callback
```

### Production Redirect URI Example

```env
https://yourdomain.com/auth/callback
```

---

### Step 3: Save Credentials

After successful client creation, Zoho will generate:

* Client ID
* Client Secret

Store them securely in backend environment variables.

---

## Backend Environment Configuration

```env
ZOHO_CLIENT_ID=xxxx
ZOHO_CLIENT_SECRET=xxxx
ZOHO_REDIRECT_URI=http://localhost:3000/auth/callback
```

---

# Zoho People Permissions Setup

## 3. Enable Employee Access Permissions

### Navigation Path

```text
Zoho People
→ Settings
→ Manage Accounts
→ User Access Control
→ Function Based Permissions
```

---

## 4. Enable Permissions For

Grant permissions to:

* Team Members
* Employee Self Service Users

---

## 5. Required Module Access

Enable access for the following modules based on application requirements:

| Module           | Required |
| ---------------- | -------- |
| Leave            | Yes      |
| Attendance       | Yes      |
| Employee Profile | Yes      |
| Shift            | Optional |
| Timesheet        | Optional |
| Holidays         | Yes      |
| Salary/Payroll   | Optional |

---

## 6. Common Permission Errors

If permissions or scopes are missing, APIs may return:

```text
No permission
Invalid OAuth scope
Unauthorized
```

---

# Required OAuth Scopes

## 7. Minimum Required Scopes

Include the following scopes while generating OAuth authorization tokens:

```env
ZOHOPEOPLE.employee.ALL
ZOHOPEOPLE.forms.ALL
ZOHOPEOPLE.leave.ALL
ZOHOPEOPLE.attendance.ALL
```

---

## 8. Payroll/Salary Scope

For payroll or salary APIs, additionally include:

```env
ZOHOPEOPLE.payroll.ALL
```

---

# OAuth Authorization URL Example

## 9. OAuth Login URL

```text
https://accounts.zoho.in/oauth/v2/auth?
scope=ZOHOPEOPLE.employee.ALL,ZOHOPEOPLE.leave.ALL&
client_id=YOUR_CLIENT_ID&
response_type=code&
access_type=offline&
redirect_uri=http://localhost:3000/auth/callback

# HR Chat Assistant - Technical Documentation

## 1. System Overview

This project is a full-stack HR assistant that:
- Authenticates users via Zoho OAuth.
- Fetches personal HR data (profile, leave, holidays, salary, attendance) from Zoho People APIs.
- Answers policy questions using a local vector index + optional Ollama summarization/classification.
- Serves a React frontend from the same Node/Express backend.

Main runtime entrypoint:
- `index.js`

Core backend modules:
- Routing/API: `src/routes/apiRoutes.js`
- Chat orchestration: `src/services/chatService.js`
- HR business/data layer: `src/services/hrDataService.js`
- Zoho API client: `src/services/zohoPeopleService.js`
- Zoho OAuth: `src/services/zohoAuthService.js`
- User token store: `src/services/zohoTokenStore.js`
- Session + OAuth state store: `src/services/authSessionService.js`
- Policy retrieval layer: `src/services/policyService.js`
- Local vector index: `src/services/vectorDbService.js`
- Optional LLM integration: `src/services/llmService.js`
- Storage abstraction (Postgres/memory): `src/services/localDbService.js`

Frontend:
- React app root: `src/client/main.jsx`
- Styling: `src/client/styles.css`
- Build config: `vite.config.mjs`

---

```

## 2. Runtime Architecture

## 2.1 Process model

A single Node process runs:
- Express API on `/api/*`
- Static frontend assets from `public/`

At startup (`index.js`):
1. Loads env vars (`dotenv`).
2. Initializes middleware (`express.json`, static files, trust proxy).
3. Mounts routes (`/api`).
4. Logs runtime config for DB, OAuth, and Ollama.

## 2.2 Storage model

`localDbService` provides key-value style collections backed by:
- Postgres table (default): `app_kv_records`
- In-memory store when `NODE_ENV=test`

Collections used:
- `sessions`: auth sessions
- `oauthStates`: OAuth anti-CSRF state
- `zohoTokensByEmail`: per-user Zoho tokens
- `vectorDocuments`: policy vectors + metadata

---

## 3. Environment and Configuration

Source of truth for expected vars:
- `.env.example`

Important groups:

1. App runtime
- `PORT`

2. DB backend
- `DB_PROVIDER` (expected `postgres` in normal runtime)
- `DATABASE_URL`
- `DB_TABLE_NAME`

3. Zoho OAuth (per-user sign-in)
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REDIRECT_URI` (optional override)
- `ZOHO_ACCOUNTS_BASE_URL`
- `ZOHO_OAUTH_SCOPES`

4. Zoho People endpoints
- `ZOHO_PEOPLE_BASE_URL`
- `ZOHO_COMPENSATION_BASE_URL`
- `ZOHO_EMPLOYEE_IDENTIFIER_FIELD`
- `ZOHO_SALARY_IDENTIFIER_FIELD`

5. Legacy/shared service token fallback
- `ZOHO_REFRESH_TOKEN`

6. Ollama
- `ENABLE_OLLAMA_SUMMARY`
- `OLLAMA_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_TIMEOUT_MS`
- `OLLAMA_NUM_PREDICT`
- `OLLAMA_INTENT_NUM_PREDICT`

7. Policy reindex flag
- `REINDEX_POLICIES`

---

## 4. Authentication and Session Flow

## 4.1 Cookie model

Cookies are handled manually via `src/utils/httpCookies.js`.

Auth cookie names (`apiRoutes.js`):
- `hr_auth_session` - user session ID
- `hr_oauth_state` - OAuth state verifier

Cookie options:
- `HttpOnly`
- `SameSite=Lax`
- `Secure` only when request is HTTPS / forwarded HTTPS

## 4.2 OAuth login sequence

Endpoints:
- `GET /api/auth/zoho/login`
- `GET /api/auth/zoho/callback`

Flow:
1. Frontend redirects user to `/api/auth/zoho/login?returnTo=...`.
2. Backend creates OAuth state record (`authSessionService.createOAuthState`) with TTL 10 min.
3. Backend sets `hr_oauth_state` cookie and redirects to Zoho authorization URL.
4. Zoho redirects to `/api/auth/zoho/callback?code=...&state=...`.
5. Backend validates cookie state + DB state.
6. Exchanges auth code for tokens (`zohoAuthService.exchangeCodeForTokens`).
7. Fetches user profile (`zohoAuthService.getUserInfo`).
8. Extracts email and stores tokens in `zohoTokensByEmail` (`zohoTokenStore.upsertUserTokens`).
9. Creates app session (`authSessionService.createSession`) with 7-day TTL.
10. Sets `hr_auth_session` cookie and redirects back to original `returnTo`.

## 4.3 Session validation on requests

`requireAuth(...)` middleware pattern in `apiRoutes.js`:
1. Reads `hr_auth_session` cookie.
2. Loads session from `sessions` collection.
3. If valid, attaches:
- `req.authSession`
- `req.authContext` with `getAccessToken()` backed by `zohoTokenStore.getValidAccessToken(email)`.
4. If missing/expired, returns 401 with `loginUrl`.

## 4.4 Logout behavior

`POST /api/auth/logout`:
- Deletes user tokens from `zohoTokensByEmail`.
- Deletes session from `sessions`.
- Clears auth cookie.

---

## 5. Token Storage and Refresh Lifecycle

Module: `src/services/zohoTokenStore.js`

Per-user key:
- normalized email (lowercased)

Stored fields:
- `accessToken`
- `refreshToken`
- `expiresAt` (epoch ms)
- `tokenType`
- `scope`
- `accountsBaseUrl`
- `user`
- `updatedAt`

Refresh behavior (`getValidAccessToken`):
1. Load token record by email.
2. If access token valid (with 60s buffer), return it.
3. If expired and no refresh token: delete record, return auth-expired error.
4. If refresh token exists: call `zohoAuthService.refreshAccessToken`.
5. Persist refreshed token payload.
6. Return new access token.
7. On refresh failure: delete token record and return auth-expired error.

Error contract:
- Custom expired error code: `ZOHO_TOKEN_EXPIRED`
- API layer maps this to 401 and asks user to sign in again.

---

## 6. HR Data Retrieval and Business Logic

Module: `src/services/hrDataService.js`

## 6.1 Current employee resolution

`getCurrentEmployee({ currentUser, authContext })`:
- Pulls employees via Zoho API.
- Matches signed-in user to employee by email first, then name.
- Falls back to single employee if only one record exists.

## 6.2 Employee identifier fallback strategy

For Zoho calls, service tries multiple candidate IDs in order.

General endpoints use candidates from:
- `ZOHO_EMPLOYEE_IDENTIFIER_FIELD` (if set)
- `employeeId`
- `zohoId`
- `recordId`
- `email`

Salary endpoints use:
- `ZOHO_SALARY_IDENTIFIER_FIELD` (if set)
- `recordId`

## 6.3 Leave apply flow

`applyLeaveFromMessage` pipeline:
1. Parse date(s), leave type hint, reason from user message.
2. Fetch leave report and resolve likely leave type.
3. Fetch booked-and-balance report and try to remap leave type (preferred by business logic).
4. Construct payload for `addLeaveRequest`.
5. Submit leave request to Zoho.
6. On invalid leave type errors, fetch master leave type details and retry with remapped type.

## 6.4 Attendance flow

`recordAttendance` maps check-in/check-out to Zoho attendance API.
- Timestamp `now` is formatted using configured timezone/date format.
- Supports additional geolocation metadata fields if supplied.

---

## 7. Zoho API Integration Details

Module: `src/services/zohoPeopleService.js`

Authorization model:
- Prefer `authContext.getAccessToken()` for signed-in user token.
- Else support explicit `authContext.refreshToken` refresh path.
- Else fallback to app-level `ZOHO_REFRESH_TOKEN` token (legacy/shared mode).

Key calls:
- Employees: `/people/api/forms/employee/getRecords`
- Leave report: `/people/api/v2/leavetracker/reports/user`
- Holidays: `/people/api/leave/v2/holidays/get`
- Salary: `/api/compensation/v1/salary/{record}`
- Attendance: `/people/api/attendance`
- Leave request: `/people/api/v3/leave-tracker/leaves`

---

## 8. Chat and Intent Routing Flow

Module: `src/services/chatService.js`

Intent set:
- `details`, `leave`, `holiday`, `salary`, `attendance`, `policy`, plus `policy-list`

Routing process per message:
1. Local heuristics (`detectIntent`).
2. Optional LLM intent classification (`llmService.classifyIntent`) with policy list context.
3. Reconciliation guard (`reconcileIntent`) prioritizes safety rules (e.g., salary policy -> `policy`, not `salary`).
4. Dispatches to flow handler:
- Employee info flows
- Attendance action
- Policy answer/list

Session memory:
- In-memory `Map` inside `ChatService` for pending selection state (not persisted).
- API session ID (frontend localStorage) used for chat continuity.

Personal mode enforcement:
- `/api/chat` always passes `personalMode: true`.
- Data-returning intents resolve current signed-in employee and prevent arbitrary user access.

---

## 9. Policy Ingestion, Vector Search, and AI Answering

## 9.1 Policy source

Source file:
- `src/data/hrPoliceis.txt`

Parser (`policyService.parsePoliciesFromText`) expects sections separated by `---` and metadata lines:
- `title:`
- `category:`
- `source:`
followed by content body.

## 9.2 Ingestion lifecycle

On first policy usage (`ensurePolicyDocumentsIngested`):
1. Builds policy documents (`id`, metadata, content, aliases).
2. Checks existing vector IDs in `vectorDocuments`.
3. Reingests when missing docs or `REINDEX_POLICIES=true`.

Manual seed script:
- `npm run seed:policies` -> `scripts/seed-policies.js`

## 9.3 Vector implementation

`vectorDbService` uses a lightweight local embedding strategy:
- Tokenization with stop-word filtering.
- Hashing tokens (`sha256`) into a fixed 256-dim vector.
- L2 normalization.
- Cosine similarity search.

Policy retrieval:
- `findPolicyForQuestion()` -> top-1 hit above `minScore=0.08`.

## 9.4 How policies are fed to AI

When answering policy questions:
1. Retrieve best policy document from vector DB.
2. Build LLM prompt with strict source-limited instructions and injected policy content.
3. Call Ollama `/api/generate` (if enabled/reachable).
4. If LLM returns content: mark `answerSource=ollama-from-vector-db`.
5. Else fallback to direct policy text rendering from vector source.

For intent classification, the LLM prompt includes:
- full label schema
- routing rules
- list of available policy titles/categories as context

---

## 10. API Surface (Personal Mode)

Auth/session:
- `GET /api/status`
- `GET /api/auth/zoho/login`
- `GET /api/auth/zoho/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Employee-scoped operations (auth required):
- `GET /api/employees` (returns only current user employee)
- `GET /api/leave-report/:employeeId` (must reference current user)
- `GET /api/holidays/:employeeId` (must reference current user)
- `GET /api/salary/:employeeId` (must reference current user)
- `POST /api/attendance`
- `POST /api/chat`

Disabled legacy shared endpoints exist at root-level routes (`/employees`, etc.) and return HTTP 410.

---

## 11. Frontend Flow (React App)

Main file:
- `src/client/main.jsx`

Client state:
- `sessionId` in `localStorage` (`hr-chat-session-id`)
- `auth` from `/api/auth/me`
- message history in component state

Startup flow:
1. Load auth via `/api/auth/me`.
2. If unauthenticated: show sign-in prompt.
3. If authenticated: auto-send empty chat message to fetch greeting/quick actions.

Chat send flow:
1. POST `/api/chat` with `{ sessionId, message, action }`.
2. Show optimistic “Thinking...” placeholder.
3. Render returned `messages[]` with optional cards/options.

Sign in/out:
- Sign in button redirects to `/api/auth/zoho/login` with `returnTo`.
- Sign out calls `/api/auth/logout`, clears UI/chat state, rotates client session ID.

UI action buttons:
- Quick actions map to server action payloads (`quick_intent` etc.) and are sent through same `/api/chat` endpoint.

---

## 12. Security and Access Controls

1. API access control
- All sensitive endpoints use `requireAuth`.
- Current-user-only enforcement on leave/holiday/salary endpoints.

2. Session handling
- HTTP-only session cookies.
- OAuth state anti-CSRF validation.
- OAuth state consumed once and deleted.

3. Token handling
- Zoho tokens persisted server-side only.
- Tokens keyed by normalized email.
- Refresh token invalidation clears stored credentials.

4. Data leakage minimization
- `/api/employees/raw` blocked in personal mode.
- `/api/employees` only returns current authenticated employee.

---

## 13. Build, Run, and Ops Notes

Commands (`package.json`):
- `npm run dev` - Vite dev server
- `npm run build` - React build to `public/`
- `npm start` - Node server (`index.js`)
- `npm run seed:policies` - force policy ingest
- `npm test` - Node test runner

Vite config (`vite.config.mjs`):
- Root: `src/client`
- Build output: `public`
- Dev proxy: `/api -> http://localhost:3000`

---

## 14. Known Implementation Characteristics

1. `ChatService` conversational state is in-memory only; it resets on server restart.
2. Policy source file path is `src/data/hrPoliceis.txt` (spelling as in repo).
3. `src/data/hrPolicies.js` exists but active ingestion currently reads `hrPoliceis.txt`.
4. Both React (`src/client`) and static (`public/app.js`) frontends exist; current build path uses React source.
5. In test mode DB provider is memory, not Postgres.

---

## 15. End-to-End Flow Summary

User asks policy question:
1. Frontend sends message to `/api/chat` with session ID.
2. API authenticates session cookie and builds `authContext`.
3. Chat service classifies intent (`policy`) with local + LLM router.
4. Policy service ensures vector docs are ingested.
5. Vector DB returns best policy document.
6. LLM service drafts source-constrained answer from that policy content.
7. Response returns to UI with message + metadata (`answerSource`, model, source).

User asks HR data question (leave/salary/etc):
1. Intent resolved.
2. Current employee resolved from Zoho user info.
3. HR data service calls Zoho People with per-user access token.
4. Token store refreshes access token transparently if needed.
5. Raw data normalized/formatted.
6. Optional Ollama summarization applied.
7. Final answer returned with structured data blocks for UI rendering.
