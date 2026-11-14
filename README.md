# Gemby AIs

An AI chat app (repository: `fluffy-waddle`) with Supabase accounts (email/password, Google and GitHub), one user-supplied AI key at a time for OpenRouter or NVIDIA NIM, an optional server-keyed CodeCraft provider for approved accounts, model-callable web search (Tavily), instruction skills, and approval-gated MCP tools including **box by Simular** (`https://box.simular.ai`).

- **Front end:** a single `index.html` (no framework). `npm run build` writes `public/`, moving the inline script into `/app.js` so the Content-Security-Policy can forbid inline scripts.
- **Server:** `server.js` serves `public/` locally and powers the Vercel functions in `api/`. They are fixed-destination proxies for NVIDIA, box by Simular and CodeCraft, plus the web search route.
- **Database:** Supabase Postgres. `supabase/schema.sql` creates two tables, both with row-level security.

---

## 1. Run locally

Requirements: Node.js 20 or newer. Supabase and Tavily are optional for local work; the app explains what is missing.

```bash
npm ci
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<publishable or anon key>"   # never the service-role/secret key
npm start                 # builds, then serves http://localhost:8080
```

Checks:

```bash
npm test                  # 58 tests (server, client logic, browser DOM with happy-dom)
npm run check             # syntax check of every JS file, unique ids, every $('id') resolves
npm run test:rls          # runs schema.sql + supabase/tests/rls_check.sql in a throwaway local PostgreSQL
npm audit
```

`npm run test:rls` needs PostgreSQL server binaries (`/usr/lib/postgresql/*/bin`). It uses a minimal stand-in for Supabase's `auth` schema (`supabase/tests/local_auth_stub.sql`). `npm test` runs the same check automatically when PostgreSQL is installed, and skips it otherwise.

Never commit `.env` files; `.gitignore` excludes them, and a test fails if one is tracked.

---

## 2. Supabase

### 2.1 Database

1. Create a Supabase project.
2. Open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It is safe to re-run, and you **must** re-run it after upgrading from an earlier version, because it now also creates the quota table and function. It creates:
   - `gemby_profiles`: one row per user holding chats and non-secret settings. RLS lets each authenticated user select, insert, update and delete **only their own row**; `anon` has no access.
   - `gemby_quota` plus the `gemby_consume_quota(bucket, limit)` function: per-user usage counters for the shared server keys (CodeCraft, web search). Clients cannot read or write the table directly. The `security definer` function only ever counts against `auth.uid()`.
3. **Prove RLS on your project:** paste [`supabase/tests/rls_check.sql`](supabase/tests/rls_check.sql) into the SQL Editor and run it. It creates two throwaway users inside a transaction, then checks:
   - Every `public` table has RLS enabled.
   - `anon` can read nothing.
   - User A cannot read, update, delete, upsert or take over user B's row.
   - Quotas are counted per user.
   
   It ends in `ROLLBACK`, so nothing is kept. The expected output is `RLS checks passed`.

### 2.2 Auth settings

In **Authentication → URL Configuration**:

| Setting | Value |
| --- | --- |
| Site URL | your production URL, e.g. `https://gemby.example.com` |
| Redirect URLs | `http://localhost:8080/` · `https://gemby.example.com/` · for Vercel previews `https://*-<your-vercel-team-slug>.vercel.app/**` |

The app only ever asks Supabase to redirect to `<current origin>/`. Post-sign-in navigation is restricted to the in-app routes `#chat` and `#top`, so there is no open redirect.

In **Authentication → Sign In / Providers → Email**, keep Email enabled. "Confirm email" is recommended, and it is required for CodeCraft and web search access.

The client uses Supabase's **PKCE flow**: OAuth, confirmation and reset links come back with a short-lived `?code=` rather than tokens in the URL. A PKCE link signs you in automatically only in the browser that requested it. If someone confirms their email on another device, the address is still confirmed, and the app tells them to sign in with their password.

### 2.3 OAuth: Google and GitHub (optional)

The sign-in dialog shows a "Continue with …" button only for providers your Supabase project reports as enabled. No client secret is ever in this repository or in browser code: secrets go into the Supabase dashboard only.

The callback URL for both providers is:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

**Google**
1. Open [Google Cloud Console](https://console.cloud.google.com/), then **APIs & Services → OAuth consent screen**. Configure the app name, support email and authorized domain (`supabase.co`, plus your own domain).
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: your production URL and `http://localhost:8080`.
   - Authorized redirect URIs: the callback URL above.
3. In Supabase, open **Authentication → Sign In / Providers → Google**. Enable it, paste the Client ID and Client Secret, and save.

**GitHub**
1. In GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Homepage URL: your production URL.
   - Authorization callback URL: the callback URL above.
2. Generate a client secret.
3. In Supabase, open **Authentication → Sign In / Providers → GitHub**. Enable it, paste the Client ID and secret, and save.

Error handling in the app:
- Denied consent, provider errors, expired or cross-browser attempts, and email or identity conflicts (`email_exists`, `identity_already_exists`) are shown as plain messages.
- The error parameters are removed from the address bar.
- Supabase links an OAuth identity to an existing account automatically only when the email is verified on both sides. Otherwise the user is told to sign in the way they did before.

---

## 3. Deploy to Vercel

1. Import the repository in Vercel and choose the **Other** framework preset. `vercel.json` sets the build command (`npm run build`), the output directory (`public`) and the security headers: CSP with `script-src 'self'`, `frame-ancestors 'none'`, `nosniff`, and `no-store` on `/api/*`.
2. Go to **Project → Settings → Environment Variables** and add the variables below for Production, and for Preview and Development if you use them. Redeploy after every change.
3. Add your production and preview URLs to the Supabase Redirect URLs (section 2.2).

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | **yes** | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | **yes** | The publishable or anon key. It is public browser config. **Never** use the service-role or `sb_secret_` key; the server refuses to publish one. |
| `CODECRAFT_API_KEY` | for CodeCraft | Your CodeCraft key (`cc_…`). It stays on the server. |
| `CODECRAFT_ALLOWED_EMAILS` | for CodeCraft | Comma-separated Supabase account emails allowed to spend that key. Empty disables CodeCraft. |
| `CODECRAFT_MAX_TOKENS` | optional | Hard cap on `max_tokens` per request (default `4096`). |
| `CODECRAFT_MAX_BODY_KB` | optional | Maximum request body (default `256`). |
| `CODECRAFT_REQUESTS_PER_MINUTE` / `_PER_DAY` | optional | Per-user quota (defaults `6` / `200`). |
| `TAVILY_API_KEY` | for web search | Tavily key (`tvly-…`) from [tavily.com](https://tavily.com). It stays on the server. |
| `SEARCH_ALLOWED_EMAILS` | optional | Restrict search to these emails. Empty means any **confirmed** account. |
| `SEARCH_REQUESTS_PER_MINUTE` / `_PER_DAY` | optional | Per-user quota (defaults `10` / `100`). |

No other environment variables are read. OpenRouter and NVIDIA keys are **never** read from the server: users supply their own.

---

## 4. AI providers

- **OpenRouter and NVIDIA NIM: the user's own key.** Enter it in **Settings**. Only one browser-stored AI key exists at a time: switching provider clears it, and the app never falls back to a server key. OpenRouter is called directly from the browser. NVIDIA goes through the fixed-destination proxy (`/api/nvidia/*`), because NVIDIA does not allow browser CORS.
- **Model lists are loaded live.** OpenRouter's list carries pricing and capabilities, so the picker shows *Free*, *Vision*, *Tools* and long-context badges only when OpenRouter reports them. It defaults to free models only, with a toggle to show all. NVIDIA's public list has no capability data, so it shows no badges. No model IDs are hard-coded. If a saved model disappears, the app switches to an available one and says so.
- **Errors** for 401/402/404/413/429/5xx, timeouts (90 seconds without data), offline state and in-stream provider errors are shown with a Retry button. The text already streamed is kept and saved, marked as failed or stopped. Keys are redacted from any error text.

### CodeCraft (server key, approved accounts only)

The server checks every request against Supabase (`/auth/v1/user`) and requires a **confirmed** email listed in `CODECRAFT_ALLOWED_EMAILS` before it uses the key. It then:
- Validates the body, drops unknown fields such as `n`, and caps `max_tokens` and the body size.
- Applies the per-user minute and day quotas through the database function. This **fails closed** if `schema.sql` has not been re-run.
- Forwards the request to `https://codecraftapi.com/v1` with the server key.

The Supabase session is never forwarded to CodeCraft, and the key never reaches the browser or MCP servers. The model list comes from CodeCraft itself, so a Claude Sonnet model appears only if CodeCraft returns it for your key.

**Remaining risk:** quotas limit requests, not money. Every allowlisted account can spend up to its quota × `CODECRAFT_MAX_TOKENS` on your bill. Keep the allowlist short and set a budget or spending limit in the CodeCraft dashboard.

---

## 5. Web search

- Turn it on per chat with the 🌐 button in the composer. A default for new chats is in Settings.
- When `TAVILY_API_KEY` is set, the model gets a `web_search` tool:
  - The reply shows "Searching the web for '…'", then the query that ran and how many results came back.
  - It ends with a **Sources** list of titles and links (http/https only).
  - At most 5 searches per reply.
  - The server route is limited to confirmed accounts (optionally an allowlist) and has per-user quotas.
- Results are passed to the model as **untrusted data**. A system instruction tells the model not to follow instructions found in tool or search output. Search results cannot trigger MCP tools, because every MCP tool call still needs your approval.
- Without Tavily, OpenRouter users fall back to OpenRouter's built-in search plugin, which may charge their OpenRouter account. NVIDIA and CodeCraft then have no search.
- Queries are sent to Tavily, and results are sent to your chosen AI provider.

---

## 6. MCP connectors, box by Simular, and skills

- **box by Simular:** create a personal key at [box.simular.ai/access](https://box.simular.ai/access) and enter it under **Settings → box by Simular MCP**. Requests go through `/api/box`, which forwards only to `https://mcp.box.simular.ai/mcp`.
- **Other servers:** add an HTTPS Streamable HTTP endpoint or paste `{"mcpServers": {...}}` JSON (optionally with `headers` for a bearer token). Browsers contact these directly, so the server must allow CORS, including the MCP headers.
- **Approval gates:**
  - The AI may *propose* a connector (name and HTTPS URL only, with no credentials and no local or private addresses). You approve it in a dialog, and it is then saved **disabled**.
  - **Every** tool call opens a dialog showing the tool, the server and the exact arguments, with **Allow once** or **Deny**. Deny has initial focus, and Escape denies.
  - Switching account denies anything pending.
- **Isolation:**
  - AI-provider keys are never sent to MCP servers, and each connector has its own headers.
  - Connector names and URLs sync per account. Tokens, and URLs containing query strings, stay on the device.
  - Signing out (or into another account) deletes the previous account's local keys and connector tokens from the browser.
- **Errors** are specific: timeout (30 seconds), 401/403 auth failure, CORS or unreachable, wrong transport (405/406/415), rate limit, and server error. A failing tool reports the error back to the model instead of ending the reply.
- **Not supported** (and rejected with a message):
  - stdio or local command servers (impossible in a browser or on Vercel)
  - legacy SSE-only endpoints
  - interactive OAuth-protected MCP servers
  - environment-variable placeholders
  - MCP resources and prompts, and server-initiated requests

  Image and audio tool results are replaced with a text note. A model that supports tool calling is required.
- **Skills** are reusable instructions sent as a system message (Settings → Skills). They are not executable packages.

---

## 7. Data, sync and security model

- **Synced to Supabase (per account, protected by RLS):** chats, provider and model choice, preferences, skills, and connector names and URLs.
- **Local only (browser `localStorage`, unencrypted, namespaced per account):**
  - the AI key, box key and connector tokens
  - deleted on sign-out or when another account signs in on the same browser
- **Sync is last-write-wins for the whole chat collection.** When you return to a tab, the app pulls newer data saved on another device, but only if this device has nothing unsynced. Otherwise this device's next save wins. Use **Retry sync** if a save fails.
- **Stale-async protection:** account loads, sync writes, CodeCraft model lists, chat streams, tool approvals and connector proposals are tied to an account generation token or abort controller. A response that started under account A is discarded after switching to B or signing out.
- **Expired sessions** clear the account state and prompt you to sign in again.
- Supabase session tokens live in the browser, like any Supabase app. Use HTTPS, and clear site data on shared devices. Don't put secrets in chats or skills: those are synced and sent to your AI provider.
- Old pre-account browser chats (`fw.chats`) can be imported from **Account → Import old browser chats**. Keys and connectors are never imported.

---

## 8. What is and isn't verified

**Verified by automated tests (mocked network):**
- Server checks: CodeCraft authorization, caps and quotas; search authorization and sanitizing; body limits; CSP and Vercel header parity; no server-key fallback.
- Client checks:
  - OAuth callback errors and redirect validation; PKCE configuration.
  - Sign-out and account-switch secret removal; stale async across account switches.
  - Streaming partial and error paths, timeouts.
  - The search tool flow; MCP approval gates and error mapping; connector sync without tokens.
- RLS against a real PostgreSQL with a stubbed `auth` schema.

**Checked in Chromium with mocked services, at 1280px and 360px:**
- No horizontal overflow, console errors or CSP violations; inline scripts are blocked.
- Stick-to-bottom, scroll restore, model picker, approval dialog, drawer and reduced motion all behave correctly.

**Not verified live**, because no real credentials were available:
- Supabase email delivery, OAuth with real Google or GitHub apps, and a real Supabase project's RLS.
- OpenRouter, NVIDIA, CodeCraft (including whether it lists Sonnet for your key), Tavily, box by Simular, and third-party MCP servers.
- Vercel deployment and the on-screen keyboard behavior on real iOS and Android devices.

Run `supabase/tests/rls_check.sql` and walk through sign-up, OAuth, reset, sync and connectors on your own deployment before relying on it.

`proxy/worker.js` is an optional, unused Cloudflare Worker alternative for NVIDIA CORS. The app does not reference it.
