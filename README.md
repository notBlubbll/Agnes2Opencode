# Agnes2Opencode

OpenAI-compatible proxy server for [Agnes AI](https://agnes-ai.com), providing access to Agnes LLM models through a unified API. Zero external dependencies — uses only Node.js built-in modules.

<img width="1135" height="896" alt="image" src="https://github.com/user-attachments/assets/3e964418-44bc-4b1e-b6b7-cf5b3ed7a64d" />

<img width="638" height="159" alt="image" src="https://github.com/user-attachments/assets/1a963114-d3c9-4e3c-9ac6-9516957b793e" />

<img width="1301" height="866" alt="image" src="https://github.com/user-attachments/assets/c2dd6e32-9f06-464c-ae68-c7d7f87c91c7" />


## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Streaming Support** — SSE streaming for chat completions
- **Tool Schema Normalization** — Resolves `$ref` and `$defs` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, model/key management, real-time stats, plan status
- **Platform Login** — Login with Agnes AI account credentials, session persistence, auto-login on restart
- **Multi-Account Support** — Add multiple platform accounts, each with its own API key and credentials
- **Auto-Config** — Automatically configures opencode provider on startup
- **Dynamic Model Fetch** — Fetches available models from `https://apihub.agnes-ai.com/v1/models`
- **Model Remapping** — Transparently translates legacy model IDs (`sapiens-ai/agnes-1.5-pro` → `agnes-2.0-flash`)
- **Response Caching** — LRU cache for non-streaming responses (configurable TTL and max size)
- **Multi-Key Support** — Rotate between multiple Agnes AI API keys with fingerprint-based sticky sessions
- **AI Wallpaper** — Generate AI backgrounds via `agnes-image-2.1-flash` using any API token, auto-enabled when a key is saved
- **Plan Status** — View subscription status, usage windows, and billing info from the dashboard
- **Retry Logic** — Automatic retry with exponential backoff for transient errors (model unavailable, query engine)
- **Test Mode** — Mock responses for development without consuming API credits
- **Test Chat Bar** — Quick in-dashboard chat with `agnes-2.0-flash` or `agnes-1.5-flash` to verify your API key (visible only when at least one key is configured)
- **Zero Dependencies** — No npm packages required

## Available Models

| Model ID | Name | Capabilities |
|----------|------|-------------|
| `agnes-2.0-flash` | Agnes 2.0 Flash | Text generation, tool calling, 256K context |
| `agnes-1.5-flash` | Agnes 1.5 Flash | Text generation, tool calling, 256K context |
| `agnes-image-2.0-flash` | Agnes Image 2.0 Flash | Image generation (text/image → image) |
| `agnes-image-2.1-flash` | Agnes Image 2.1 Flash | Image generation (text/image → image) |
| `agnes-video-v2.0` | Agnes Video V2.0 | Video generation (text/image → video) |

Legacy model IDs (`sapiens-ai/agnes-1.5-pro`, `sapiens-ai/agnes-1.5-lite`, etc.) are automatically remapped to their current equivalents.

Models are dynamically fetched from `https://apihub.agnes-ai.com/v1/models` on startup with a 5-minute cache TTL.

## How the Free Tier Works

- **Indefinitely Free:**
  The proprietary baseline models — such as Agnes-2.0-Flash — are free to use without a time trial or credit card.

- **Rate Limits:**
  Free tier: 8 RPM (Request Per Minute). Paid plans have a 5-hour request limit: Starter: 1,500 / 5h | Plus: 7,500 / 5h | Pro: 30,000 / 5h

Consider subscribing to keep the service up and available for everyone if you like it. [View Plans & Pricing](https://platform.agnes-ai.com/subscribe/subscription?from=website)

## Quick Start

```bash
# Clone and start (zero deps — no npm install needed)
cd AGNES-PROXY
node proxy.js

# Or use launcher (auto-detects Bun, falls back to Node)
start.cmd

# Or Node-only launcher
start-node.cmd

# Open dashboard
open http://localhost:8080
```

## Authentication

Get an Agnes AI API key from [agnes-ai.com](https://agnes-ai.com).

Add to `.config/config.json`:

```json
{
  "API_KEY": "cpk-your-agnes-api-key"
}
```

Or set environment variable:

```bash
set AGNES_API_KEY=cpk-your-agnes-api-key
node proxy.js
```

## Configuration

Edit `.config/config.json` or set environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `LISTEN_ADDR` | Proxy listen address | `127.0.0.1:8080` |
| `UPSTREAM_BASE_URL` | Agnes AI API URL | `https://apihub.agnes-ai.com` |
| `API_KEY` | Agnes AI API key | — |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `API_KEYS` | Client API keys for proxy auth | `[]` (open access) |
| `TOKENS` | Array of `{name, token, platformUsername, platformPassword}` for multi-key support | auto-populated |
| `ENABLED_MODELS` | Models visible to clients | all fetched models |
| `CACHE_TTL` | Response cache TTL | `60s` |
| `CACHE_MAX_SIZE` | Max cached responses | `100` |
| `CACHE_ENABLED` | Enable response caching | `true` |
| `WALLPAPER_MODE` | Wallpaper source: `none`, `bing`, or `ai` | `bing` |
| `WALLPAPER_PROMPT` | Prompt for AI wallpaper generation | `realistic vibrant colorful mountain range landscape` |
| `TEST_MODE` | Return mock responses without calling upstream | `false` |
| `LOCAL_OVERWRITE` | Force a single dashboard locale (e.g. `de`, `fr`, `ja`). When set, the autotranslate toggle is locked ON and the browser locale is ignored. Also forces `de` when `TEST_MODE=true`. | `null` |

### Multi-Key Management

The proxy supports multiple Agnes AI API keys. Set `TOKENS` in config:

```json
{
  "TOKENS": [
    { "name": "Key 1", "token": "cpk-key-1" },
    { "name": "Key 2", "token": "cpk-key-2" }
  ]
}
```

Each token can also store platform credentials for auto-login:

```json
{
  "TOKENS": [
    {
      "name": "Key 1",
      "token": "cpk-key-1",
      "platformUsername": "user@example.com",
      "platformPassword": "secret",
      "platformToken": "",
      "platformUser": null
    }
  ]
}
```

Manage keys via the **Dashboard → Manage Keys** modal (inline add/edit/delete).

### Key Rotation & Session Tracking

The proxy automatically rotates tokens across conversations using **fingerprint-based session tracking**.
Each conversation is identified by an MD5 hash of the first user message (skipping auto title prompts).
Follow-up requests (tool calls, continuations) in the same conversation are pinned to the same token
automatically. A global session counter increments for each new conversation.

New conversations are stamped with `[KeyName|sessN]` in the first user message for server-side traceability.

### Proxy API Keys

By default the proxy is open access. To restrict access, set `API_KEYS`:

```json
{
  "API_KEYS": ["my-secret-key-1", "my-secret-key-2"]
}
```

Clients must include the key:

```bash
curl -H "x-api-key: my-secret-key-1" http://localhost:8080/v1/models
curl -H "Authorization: Bearer my-secret-key-1" http://localhost:8080/v1/models
```

## Usage

### OpenAI-Compatible

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'not-needed'
});
const response = await client.chat.completions.create({
  model: 'agnes-2.0-flash',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### opencode Integration

The proxy auto-configures opencode on startup. Restart opencode after starting the proxy, then select the `agnes` provider.

Provider config is written to `~/.config/opencode/opencode.json`. A backup (`openconfig.b4agnes.json`) is created before the first edit. Legacy `zenith` and `stepfun` providers are removed automatically.

## Dashboard

Access at `http://localhost:8080`:

- **Plan Status** — Subscription name, expiry, 5-hour and weekly usage bars (or "No Plan" card with login/subscribe CTA)
- **Cache Stats** — Real-time cache hits, misses, evictions
- **API Key Status** — Online/Offline indicator per key
- **SS Mode** — Blur sensitive tokens for screenshots
- **Liquid Glass Effects** — Canvas-generated SVG displacement maps with refraction profiles
- **Model Management** — Toggle models on/off with capability badges (reasoning, tools, vision, context)
- **Test Chat** — Quick chat with `agnes-2.0-flash` or `agnes-1.5-flash` under the Models block, with the last 4 messages, local `HH:MM` timestamps, and a clear button. Hidden when no API key is configured.
- **API Key Manager** — Add/edit/delete API keys with inline editing, platform account info display
- **Platform Login** — Login with Agnes AI account, add multiple accounts, view account info, logout
- **Retrieve Keys from Platform** — Fetch API keys from logged-in platform account, select and apply with auto-fill
- **Apply API Key Modal** — Post-login modal that fetches platform keys, shows previews, fetches full key on selection
- **Wallpaper Toggle** — Switch between None, Bing, and AI Image modes with configurable prompt (auto-enables AI on key save)
- **Collapsible Sections** — Models, API Key, Quick Actions, Environment, Proxy Configuration
- **Auto-refresh** — Health check every 15s, plan status every 30s
- **Autotranslate (beta)** — Bottom-left checkbox that translates every UI string via Agnes AI. When `TEST_MODE` is on or `LOCAL_OVERWRITE` is set in config, the toggle is forced ON and locked.

### Autotranslate (i18n)

The dashboard ships with an English-only UI. Toggling **autotranslate (beta)** in the bottom-left corner:

1. Detects the browser locale (or honors the proxy-side `forced_locale`)
2. Shows a fullscreen black "Translating" overlay
3. Fetches `/api/i18n?locale=<xx>&generate=1`, which calls Agnes AI (`agnes-2.0-flash`) to translate the entire UI string catalog in batches of 30
4. Caches the result on disk at `.cache/i18n/<locale>.json` for instant reuse on next startup
5. Applies the translations in place across every `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` element, then hides the overlay

Locale resolution priority (highest to lowest):

1. `?locale=<xx>` URL query parameter
2. `config.localOverwrite` (forced by server)
3. `config.testMode === true` → forces `de`
4. `localStorage.preferredLocale` (user's previous toggle state)
5. `navigator.languages[0]`
6. `en`

The proxy prefetches translations on startup whenever a forced locale is in effect, so the very first dashboard load is already translated.

## API Endpoints

### Core API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check with API key status, uptime, platform login status, token state, cache stats |
| `GET` | `/v1/models` | OpenAI models list |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (streaming, retry, caching) |

### Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` | `/api/config` | Read/write proxy configuration |
| `GET` | `/api/validate` | Validate API key against upstream |
| `GET` | `/api/models` | List available model IDs with metadata |
| `GET` | `/api/bg` | Wallpaper image (Bing daily, AI-generated, or 204 none) |
| `POST` | `/api/generate-image` | Generate AI wallpaper, save to `.cache/ai-paper.jpg` |
| `GET` / `POST` | `/api/keys` | Multi-key CRUD (add/update/delete, includes `platformUsername`) |
| `GET` | `/api/account` | Platform user data (`{ logged_in, user }`) |
| `GET` | `/api/plan-status` | Subscription plan status with usage windows |
| `POST` | `/api/login` | Platform login with `{ username, password }` |
| `POST` | `/api/logout` | Clear platform session and saved credentials |
| `GET` | `/api/platform/user` | Platform user info (requires login) |
| `GET` | `/api/platform/keys` | Fetch API keys from platform (`GET /api/token`) with plan name and username |
| `GET` | `/api/platform/token/:id/key` | Fetch full API key value from platform (`POST /api/token/:id/key`) |
| `GET` / `DELETE` | `/api/cache` | View/clear response cache |
| `GET` | `/api/i18n?locale=<xx>[&generate=1]` | Fetch translated UI strings; `&config=1` returns the effective forced locale. `&generate=1` triggers Agnes translation on first use, then caches. |

## Architecture

```
proxy.js
├── Config System         — JSON + env vars, per-token credentials, duration parsing
├── LRU Response Cache    — MD5-keyed, configurable TTL/max size, streaming excluded
├── UpstreamClient        — HTTP client for apihub.agnes-ai.com
│   ├── getUserInfo()     — GET /v1/models (validate key, 10s timeout)
│   └── chatCompletions() — POST /v1/chat/completions (streaming-aware, configurable timeout)
├── Platform Login        — Login/session management for platform account
│   ├── loginToPlatform() — POST /api/user/login (15s timeout, persists to config)
│   ├── platformGetUserInfo() — GET /api/user/self
│   ├── platformGetUserKeys() — GET /api/token (list platform API keys)
│   ├── platformGetTokenKey(id) — POST /api/token/:id/key (fetch full key value)
│   ├── platformGetSubscriptionPlanName() — GET /api/user/subscription (plan name)
│   └── platformSession   — Token + user + expiry state
├── Model Registry        — Fallback models, dynamic fetch (5min TTL), legacy remapping
├── Tool Schema Norm.     — $ref resolution, nullable simplification, type normalization
├── Retry Logic           — Up to 3 attempts, exponential backoff (5s/10s/15s)
├── HTTP Handlers         — OpenAI + management endpoints
├── Request Router        — Pathname-based routing
├── AI Wallpaper          — Generates images via /v1/images/generations, preloads to disk
├── Session Tracking      — Fingerprint-based sticky sessions with message stamping
├── Opencode Config       — Auto-configures opencode provider, backup, cleanup
└── Server Startup        — Validation, platform session restore, model fetch, listen with retry

dashboard.html
├── Liquid Glass Engine   — Canvas-based displacement/specular maps with refraction profiles
├── Plan Fieldset         — Subscription status, usage bars, login CTA
├── Model Management      — Toggle models on/off with capability badges
├── Test Chat Bar         — Quick chat (Agnes 2.0/1.5 Flash), last 4 msgs, HH:MM timestamps, key-gated
├── API Key Manager       — Add/edit/delete API keys + platform account info
├── Platform Login Modal  — Username/password login, add-account mode, Enter key support
├── Apply API Key Modal   — Post-login key selector with previews, full key auto-fetch
├── Retrieve Keys Button  — Fetch platform keys from logged-in account
├── Add Account Button    — Add multiple platform accounts
├── Wallpaper Toggle      — None / Bing / AI Image radio group + prompt input
├── Cache Stats           — Real-time cache performance
├── Auto-refresh          — Health (15s) + plan status (30s) polling
└── Configuration Forms   — Listen addr, upstream URL, timeout, test mode
```

## Dependencies

No external npm dependencies — uses Node.js built-in modules only: `fs`, `path`, `os`, `http`, `https`, `crypto`, `zlib`.

## License

MIT
