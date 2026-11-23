# Gemby AIs

An AI chat app with Supabase accounts, one user-supplied AI key, optional OpenRouter web search, instruction skills, and approval-gated MCP tools. The original chat layout, animations and responsive theme are retained.

## Supabase setup (required for accounts)

1. Create a Supabase project. In its SQL Editor run [`supabase/schema.sql`](supabase/schema.sql). This creates `gemby_profiles` with row-level security; each authenticated user can access only their own row. The app also serves this non-secret SQL at `/schema.sql` and links to it from the sign-in setup help.
2. Enable **Email** authentication in Supabase. Configure the Site URL and allowed Redirect URLs for your deployed site and, if testing locally, `http://localhost:8080/`. Email confirmation and password reset depend on your Supabase email settings and redirect configuration.
3. In Vercel → Project → Settings → Environment Variables add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_ANON_KEY` | Your Supabase **publishable/anon** API key |

   These two values are public browser configuration. **Never use the service-role or secret key** as the anon key. Set them for the relevant Production, Preview and Development environments and redeploy after changes. This app does not use or need a Supabase service-role key.
4. Open Gemby AIs, select **Account**, create an account, and confirm the email if your project requires it. Sign in and add your AI key in Settings. The app needs Supabase configuration and the SQL schema before login and sync can work.

Chats, selected provider/model, skills and non-secret chat preferences are stored in Supabase under the signed-in account. AI keys, Simular keys, and custom connector configurations/headers are **not** synced; they stay unencrypted in browser localStorage, namespaced by account. Supabase session tokens also live in the browser. Anyone with access to the browser profile or running scripts on the site may access local secrets. Use HTTPS, a trusted device and browser, and clear site data on shared devices. Don't put secrets in chats or skills, since those can be synced and sent to your AI provider. Old `fw.*` browser data is left untouched and is not automatically imported. After signing in, use **Account → Import old browser chats** to upload previous chats into that account; old keys and connectors are never imported.

Sync currently saves the account's chat collection as one row; simultaneous edits from different devices are last-write-wins. Use **Retry sync** if a save fails, and check the sync status before leaving or changing devices.

## GitHub sign-in (optional)

GitHub OAuth is separate from Puter and from the GitHub access used to manage this repository. To enable **Continue with GitHub**:

1. In Supabase, open **Authentication → Sign In / Providers → GitHub** and copy the provider's **Callback URL**. It normally looks like `https://<project-ref>.supabase.co/auth/v1/callback`; use the exact URL shown for your project.
2. Open [GitHub OAuth Apps](https://github.com/settings/developers) and create an OAuth App. Set its Homepage URL to your deployed Gemby website and its **Authorization callback URL** to the Supabase callback from step 1. Register it and generate a client secret.
3. In Supabase's GitHub provider settings, enable GitHub and enter the GitHub **Client ID** and **Client Secret**, then save. The secret belongs in Supabase, not Vercel, the browser, this repository, or chat.
4. In Supabase **Authentication → URL Configuration**, set Site URL to your production Gemby URL and add the exact Gemby redirect used by the app to Redirect URLs: your site's origin and path followed by `?github_callback=1` (for a root deployment, for example `https://your-site.example/?github_callback=1`). Also allow the site URL used by email confirmations and password resets. Configure separately for any trusted preview/local origins you use. Never use a broad wildcard for untrusted origins.
5. Deploy the app, open **Account → Continue with GitHub**, and authorize it. GitHub returns to Supabase's callback; Supabase then returns to Gemby. GitHub sign-in and Puter sign-in are separate: after returning from GitHub, connect Puter in Settings if desired.

Supabase manages identities and may automatically link GitHub and email identities that share an eligible verified email. Different emails can result in separate accounts with separate chats. This app does not manually merge accounts; check the Supabase user identities before assuming existing data will appear. GitHub OAuth and account linking have automated mocked tests, but live GitHub/Supabase configuration must be tested in your own project.

## Run locally

Node.js 20 or newer is required. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in your shell (never commit secrets), then:

```bash
npm ci
npm start                 # builds browser auth client and listens on http://localhost:8080
npm test
```

On Vercel, import the repository using the **Other** framework preset. The build command and output directory are in `vercel.json`. Functions proxy NVIDIA, Simular, CodeCraft, Moduck, and Bytez requests to fixed upstream hosts. The chat/tool proxies require a user-supplied bearer token but do not authenticate users themselves. Protect or rate-limit your deployment as appropriate; they are not multi-tenant gateways.

## One AI key

Choose OpenRouter or NVIDIA in the chat header, then add the corresponding API key in **Settings**. Only one browser AI-provider key is stored at a time; switching provider clears it. OpenRouter calls go directly to OpenRouter; NVIDIA calls use the included fixed-destination proxy. Neither silently falls back to a server key. CodeCraft, Moduck, and Bytez are separately selected providers using the Vercel keys described below. AI keys are not sent to MCP servers. A separate connector may require its own credentials—an AI-provider key does not authenticate third-party services.

OpenRouter web search is optional in Settings and may incur charges even for free models. It requires an OpenRouter model/provider that supports the search tool. This OpenRouter search option is not supported with NVIDIA, CodeCraft, Moduck, or Bytez.

Existing `CODECRAFT_ALLOWED_EMAILS`, `MODUCK_ALLOWED_EMAILS`, and `BYTEZ_ALLOWED_EMAILS` environment variables are ignored and can be removed after deploying this version. They no longer restrict access.

## Puter.js AI

At Gemby email/password sign-in, **Also connect Puter** is checked by default. When the Puter SDK is ready, the sign-in click starts both independent sign-ins; complete the Puter popup if requested. Uncheck it to sign in to Gemby only. If Puter is still loading, the popup is blocked or cancelled, or you restored a Gemby session without a fresh sign-in, Gemby remains usable: choose **Puter** in the chat header, open **Settings**, and click **Connect Puter**. Allow popups if your browser blocks them. Gemby sign-in is still required, and after changing Gemby accounts you must connect Puter again (using the checkbox on a fresh sign-in or the Settings button). Puter sign-in is separate and may persist in the browser after a failed Gemby login or after signing out of Gemby; connecting an existing session will use that existing Puter account. Use a trusted device and sign out of Puter separately when appropriate.

Puter does not need a Vercel API key. Its user-pays model, quotas, model availability, and possible charges are controlled by Puter. The picker uses Puter's live model list, so Sonnet or other models appear only when Puter lists them. Your chat history and enabled skill instructions are sent to Puter and its model providers. This integration supports text streaming only, not images, MCP tools, connector proposals, or OpenRouter web search; disable active connectors and OpenRouter web search before using it. Stop closes the local stream, but the bundled SDK cannot guarantee cancellation of an in-flight upstream request or its charges.

The pinned official Puter.js SDK is bundled locally and loaded when the sign-in dialog is opened or the provider is selected. As with any browser SDK, its code runs in the app's browser context. Automated tests mock Puter; real sign-in, popups, model access, streaming and billing have not been verified with a live account.

## CodeCraft on Vercel

CodeCraft is an OpenAI-compatible provider; Gemby AIs uses its fixed `https://codecraftapi.com/v1` endpoint. Set up Supabase first. Then in **Vercel → Project → Settings → Environment Variables** add:

| Name | Value |
| --- | --- |
| `CODECRAFT_API_KEY` | Your CodeCraft API key (`cc_…`) |

Also configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` as described above. Select the desired Production/Preview/Development environments and redeploy. Create/sign in to a Supabase account with a **confirmed email**, select **CodeCraft** in the chat header, and choose a model from the live list. The app does not invent model IDs; select a Sonnet model only if CodeCraft actually lists it. The key needs CodeCraft's inference and `models:read` scopes. Model availability, costs, and quotas are determined by CodeCraft.

The server checks each request's session with Supabase and rejects unconfirmed accounts before it uses the server key. The session is not forwarded to CodeCraft; the CodeCraft key is not returned to the browser or sent to MCP servers. **Any confirmed account can spend the shared key's quota**, including anyone who can register if sign-ups are open. There is no app-level rate or spending limit. Configure provider budgets and rate limits, restrict sign-ups if appropriate, and protect your deployment before production. This feature has automated mocked tests but has not been verified against a live Supabase or CodeCraft account.

## Moduck and Bytez on Vercel

Both providers use server-side keys for any confirmed Supabase account. Set these values in **Vercel → Project → Settings → Environment Variables**, select the environments you use, and redeploy:

| Variable | Value |
| --- | --- |
| `MODUCK_API_KEY` | Your Moduck text-scoped API key |
| `MODUCK_API_BASE_URL` | The HTTPS API service origin supplied by Moduck for your account, without `/v1` (for example, `https://api.moduck.ai`) |
| `BYTEZ_API_KEY` | Your Bytez API key |

Also configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` as above. The Moduck origin is restricted to `moduck.ai` and its subdomains, without credentials, ports, paths, query strings or fragments; if your account uses a different origin, it will not work without a security-reviewed configuration change. Do not paste keys into chat or commit them. After deploying, sign in with a confirmed email, select a provider and choose from its returned model list. Bytez's list is filtered to its open-source chat catalog; some models may require additional access or billing, and its closed-source models may require an additional provider key, which this integration does not configure.

Moduck's documented text contract is non-streaming, limited to ten messages and 4096 UTF-8 bytes of message content. It does not support connector tools, proposals or OpenRouter web search in this integration. For Bytez, streaming and tools depend on the selected model. Both services may charge for use. There is no application-level rate or spending limit: any confirmed account can spend the shared quota, including anyone who can register if sign-ups are open. Configure provider budgets and rate limits, restrict sign-ups if appropriate, and protect your deployment. Neither provider has been tested against a live account; model availability and API behavior must be verified with your own credentials.

## MCP connectors and skills

**box by Simular:** Create a personal key at [box.simular.ai/access](https://box.simular.ai/access), enter it under **Settings → box by Simular MCP**, test the connection, and enable its tools. The server forwards requests only to `https://mcp.box.simular.ai/mcp`; interactive OAuth is not supported.

**Other MCP servers:** In Settings, add an HTTPS Streamable HTTP link or paste configuration JSON:

```json
{
  "mcpServers": {
    "example": { "url": "https://example.com/mcp" },
    "disabled-example": { "url": "https://example.org/mcp", "disabled": true }
  }
}
```

Optional `headers` can contain a bearer token. These configurations are stored locally and are visible in the JSON editor. Remote MCP URLs are contacted directly from the browser and require the server to allow CORS, including required MCP headers. Local/stdio commands, OAuth login, legacy SSE-only endpoints, environment-variable expansion, MCP resources/prompts and server-initiated requests are not supported. Image/audio tool results are omitted. A tool-calling model is required.

When enabled in Settings, the AI can propose a connector name and HTTPS URL, but it cannot provide credentials. You must approve the proposal; it is saved **disabled** until you enable it in Settings. Every MCP tool action also requires approval. Review URLs, names, and arguments carefully: tools may run commands, access data, or change files. Approved tool results and server-provided tool descriptions are sent to the selected AI provider. Never trust instructions in untrusted pages or tool results automatically.

In **Settings → Skills**, enable built-in skills or edit their JSON. Skills are reusable instructions sent to the model, not executable skill packages or automatic `SKILL.md` loaders.

## Verification and limitations

Run `npm test` and `npm run build`. The automated tests mock provider and Supabase calls; they do not prove your Supabase project, email delivery, RLS policies, model provider, MCP server, or Vercel deployment is correctly configured. Test sign-up, password reset, account isolation, sync, and connector access with your own configured project before production. Supabase Auth and email provider limits, Vercel function limits, and AI provider charges apply.

### Model specifications

The model picker shows catalog-reported context and maximum output tokens, parameter count, input modalities, and tool-calling or reasoning controls when the selected provider supplies those fields. Search also matches displayed specifications. Missing data is shown as unavailable rather than guessed from model names. Tool calling does not by itself make a model an agent, and listed model capabilities do not guarantee that Gemby supports them: Puter and Moduck, for example, do not support MCP tools in this integration, and Gemby currently sends text rather than image inputs. Actual limits and availability can vary by provider.
