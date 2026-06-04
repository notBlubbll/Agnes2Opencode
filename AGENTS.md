# Agnes2Opencode — Developer Guide

## Project Structure

```
AGNES-PROXY/
├── proxy.js              # Main proxy implementation (1602 lines)
├── dashboard.html        # Liquid glass dashboard with stats UI
├── .config/
│   └── config.json       # Runtime configuration
├── .cache/               # Response cache + wallpaper cache
├── package.json          # Project metadata (MIT, no deps)
├── start.cmd             # Auto-detect launcher (Bun preferred, Node fallback)
├── start-node.cmd        # Node.js-only launcher
├── skills.md             # Opencode provider configuration reference
├── README.md             # User documentation
└── AGENTS.md             # This file
```

## Key Components

### 1. Constants & Config

- `AGNES_API_BASE` — `https://apihub.agnes-ai.com`
- `AGNES_MODELS_URL` — `https://apihub.agnes-ai.com/v1/models`
- `PLATFORM_BASE_URL` — `https://platform-backend.agnes-ai.com`
- `API_KEY_ENV_VAR` — `AGNES_API_KEY`
- `AGNES_USER_AGENT` — `Agnes2Opencode` (sent as `User-Agent` on every outbound call to Agnes endpoints — chat completions, `/v1/models`, platform login/user/keys/subscription, AI image generation)
- `loadConfig()` — Loads `.config/config.json` with env var overrides; normalizes `TOKENS` array with per-token fields (`name`, `token`, `email`, `platformUsername`, `platformPassword`, `platformToken`, `platformUser`); provides separate `img_prompt` and `video_prompt` fields (env vars `IMG_PROMPT` / `VIDEO_PROMPT`; falls back to `WALLPAPER_PROMPT`)
- `saveConfig()` — Writes config back to `.config/config.json` (serializes `TOKENS`, `ENABLED_MODELS`, cache settings, etc.)
- `generateAiWallpaperToDisk()` — Generates AI image via `/v1/images/generations` with model `agnes-image-2.1-flash`, saves to `.cache/ai-paper.jpg` (supports both URL-based and base64-encoded responses). Uses the first available token's API key. Disabled when no token is configured.
- `generateAiVideoToDisk()` — Generates AI video via `/v1/videos` with model `agnes-video-v2.0`, polls for completion every 12s (no fixed timeout — polls indefinitely as long as progress is > 0), downloads result to `.cache/ai-video.mp4`. Logs only on progress change to avoid console spam. Extracts video URL from `remixed_from_video_id` field.
- `checkVideoGenFeature()` — Fetches subscription from platform API to check `features.video_gen` flag; returns `true`/`false`/`null` (null = can't reach API, proceeds anyway)
- `_genProgress` — Module-level state: `{ kind: 'image'|'video'|null, progress: 0-100 }` — updated by `setGenProgress()` which also broadcasts to SSE clients
- `setGenProgress(kind, progress)` — Sets `_genProgress` and calls `broadcastProgress()`
- `broadcastProgress()` — Writes JSON to all connected SSE clients in `_sseClients`; silently removes dead clients on write failure
- `_sseClients` — Array of active SSE response objects
- `hasApiToken()` — Returns `true` if any token in config has a non-empty `token` field (used as gate for wallpaper generation)
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`

### 2. UpstreamClient

- `headers(stream)` — Returns Bearer token + Content-Type/Accept/Accept-Encoding headers + `User-Agent: Agnes2Opencode` + platform session cookie
- `getUserInfo()` — `GET /v1/models` with 10s AbortController timeout to validate API key; sends `User-Agent: Agnes2Opencode`
- `chatCompletions(body)` — `POST /v1/chat/completions` with configurable timeout, streaming-aware; forwards `User-Agent: Agnes2Opencode` on every proxied request
- `getAccountInfo()` — Returns null (unused)
- `getPlanStatus()` — Returns null (unused)
- `getPlanStatus()` — Returns null (unused)

### 3. Platform Login

- `loginToPlatform(username, password)` — `POST ${PLATFORM_BASE_URL}/api/user/login` with 15s timeout; persists credentials back to first token for auto-login on restart; sends `User-Agent: Agnes2Opencode`
- `getPlatformHeaders()` — Returns `{ Cookie, Authorization, User-Agent: Agnes2Opencode }` for platform API calls
- `platformGetUserInfo()` — `GET ${PLATFORM_BASE_URL}/api/user/self` to fetch current user data
- `platformGetUserKeys()` — `GET ${PLATFORM_BASE_URL}/api/token` to list platform API keys (returns previews only)
- `platformGetTokenKey(tokenId)` — `POST ${PLATFORM_BASE_URL}/api/token/${tokenId}/key` to fetch full API key value
- `platformGetSubscriptionPlanName()` — `GET ${PLATFORM_BASE_URL}/api/user/subscription` to get plan name (falls back to "Default")
- `platformSession` — Module-level state: `{ token, user, expiresAt }`
- Platform credentials (`platformUsername`, `platformPassword`, `platformToken`, `platformUser`) are stored per-token in the `TOKENS` array
- Auto-login on startup: restores saved token from first token's `platformToken` OR logs in with first token's `platformUsername`/`platformPassword` if no token exists; validates session via `platformGetUserInfo()`
- Multi-account support: `savePlatformLogin()` supports `addAccount` mode which creates new token entries or updates existing ones

### 4. Model Registry

- `AGNES_MODELS` — Hardcoded fallback array: `['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0']`
- `fetchRemoteModels()` — Fetches from `AGNES_MODELS_URL` with 5-minute TTL cache (`DYNAMIC_MODELS_TTL = 300000`)
- `MODEL_REMAP` — Translates legacy model IDs to current IDs:
  - `sapiens-ai/agnes-1.5-pro` → `agnes-2.0-flash`
  - `sapiens-ai/agnes-1.5-lite` → `agnes-1.5-flash`
  - `sapiens-ai/agnes-image-1.2` → `agnes-image-2.0-flash`
  - `sapiens-ai/agnes-video-v1.2` → `agnes-video-v2.0`
  - `sapiens-ai/agnes-1.5-pro-full` → `agnes-2.0-flash`
  - `sapiens-ai/agnes-1.5-lite-full` → `agnes-1.5-flash`
- `AGNES_MODEL_META` — Static metadata for each model (name, capabilities, modalities, context limits)
- `getModelMeta(modelId)` — Returns metadata for known models, or `{ name: modelId }` for unknown
- `remapModel(modelId)` — Translates legacy IDs via `MODEL_REMAP` or passes through

### 5. Decompression

- `readBodyWithDecompress(body, contentEncoding)` — Reads response body and decompresses Brotli/gzip/deflate
- `readBodyBody(body)` — Reads raw bytes from Node stream, web ReadableStream, or async iterable
- `pipeBodyToResponse(body, res)` — Pipes response body to client with safe write/end, detects client disconnect

### 6. Utility Functions

- `cloneMap()` / `cloneSlice()` — Deep clone objects/arrays
- `normalizeToolSchemas(tools)` — Entry point for `$ref` resolution in tool schemas
- `extractDefinitions(schema)` — Merges `definitions` + `$defs`
- `normalizeSchemaMap(node, defs, maxDepth)` — Recursive `$ref` resolver (max depth: 12)
- `normalizeSchemaValue()` / `normalizeTypeField()` / `normalizeEnumField()` — Schema normalization helpers
- `simplifyNullableCombinator(schema, key)` — Collapses `anyOf`/`oneOf` with null types
- `isNullSchema(schema)` — Detects null schema variants (type: null, const: null, enum: [null])
- `mergeDefinitions(parent, local)` — Merges two definition sets
- `tryResolveRef(node, defs)` — Resolves a single `$ref` reference
- `readBodyText(body)` — Handles Node streams, web ReadableStream, async iterables (returns string)
- `extractUserPrompt(payload)` — Returns last user message text for logging
- `fingerprintPayload(payload)` — MD5 hash of first user message for session tracking (truncated to 12 chars)

### 7. HTTP Handlers

- `authorized(req)` — Checks `x-api-key` header or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Buffers incoming request body to string
- `writeJSON(res, statusCode, payload)` — JSON response with error-safe write
- `writeOpenAIError()` — OpenAI error format
- `handleHealthz(req, res)` — Returns uptime, API key validity, models count, runtime info, platform login status, token state per key
- `handleModels(req, res)` — OpenAI-format model list (cached in `modelsCache`)
- `handleChatCompletions(req, res)` — Parses body, remaps model, calls `proxyChatRequest`
- `handleAccountInfo(req, res)` — Returns platform user data from `/api/user/self`
- `handlePlanStatus(req, res)` — Returns subscription/plan status with usage windows (returns test data when `config.testMode` is true)
- `proxyChatRequest(res, payload, model)` — Core proxy: detect session, check cache, clone payload, normalize tools, forward to upstream with retry loop

### 8. Retry Logic

- `retryLoop(fn)` — Up to 3 attempts with exponential backoff (`RETRY_DELAY_MS * attempt`, i.e., 5s, 10s, 15s)
- `MAX_RETRIES = 3` — Maximum retry attempts
- `RETRY_DELAY_MS = 5000` — Base delay between retries
- Retries on: `isModelUnavailableError()` ("this model is currently unavailable") and `isQueryEngineError()` ("not connected to the query engine")
- All other errors are passed through immediately

### 9. Test Mode

- When `config.testMode` is true:
  - `/v1/chat/completions` returns a mock `"Test"` response without calling upstream
  - `/api/plan-status` returns synthetic subscription data with fake usage windows
  - Forces the dashboard locale to `de` for the autotranslate (i18n) feature
- Enabled via `TEST_MODE: true` in config

### 9b. i18n / Autotranslate

- `I18N_STRINGS` — Hardcoded catalog of every user-visible dashboard string, keyed by stable identifiers
- `resolveForcedLocale()` — Returns the forced locale or `null`. Priority: `config.localOverwrite` → `config.testMode` (forces `de`) → `null`
- `I18N_TEST_LOCALE` — Removed; replaced by `resolveForcedLocale()`
- `loadI18nCache(locale)` / `saveI18nCache(locale, data)` — Disk persistence to `.cache/i18n/<locale>.json`
- `translateCatalogForLocale(locale)` — Splits catalog into batches of 30, calls `callAgnesTranslate()` per batch, merges results
- `callAgnesTranslate(promptText)` — Single Agnes chat call with the bundled `Translate each numbered line to {locale}` prompt, 120s timeout
- `buildTranslatePrompt(locale, entries)` — Builds the batch prompt in `NUMBER|TRANSLATION` format
- `parseI18nBatchResponse(text, expectedKeys)` — Parses `NUMBER|TRANSLATION` lines back into a dict keyed by the catalog key
- `ensureI18nForLocale(locale)` — Returns cached bundle if present, otherwise translates (only when an API key is configured) and caches
- `buildI18nBundle(locale)` — Returns the cache or a `pending` placeholder
- `buildI18nConfig()` — Returns `{ forced_locale, test_mode, local_overwrite, reason }`
- `handleI18nGet(req, res)` — `GET /api/i18n`:
  - `?config=1` → JSON of effective config
  - `?locale=<xx>` (default = forced locale or `en`)
  - `&generate=1` → translates on first use, then caches
  - Always includes `forced_locale`, `test_mode`, `local_overwrite` in the response
- `prefetchI18nOnStartup()` — At startup, if a forced locale is in effect and an API key is configured, prefetches and caches translations so the first dashboard load is already translated
- Config key: `LOCAL_OVERWRITE` (string, e.g. `"de"`, `"fr"`, `"ja"`) — empty/null disables
- Environment variable: `LOCAL_OVERWRITE` (overrides config)
- Locale resolution on the dashboard (highest to lowest):
  1. `?locale=<xx>` URL query
  2. `forced_locale` from `/api/i18n?config=1`
  3. `localStorage.preferredLocale` (user's previous toggle)
  4. `navigator.languages[0]`
  5. `en`
- When forced, the autotranslate checkbox is locked ON and disabled in the UI

### 10. Request Router (pathname-based)

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html` with no-cache headers
- `/api/config` (GET/POST) — Config read/write (masks tokens, reads/writes per-token platform credentials; syncs `config.apiKey`/`upstream.apiKey` when tokens change)
- `/api/validate` (GET) → Validate API key
- `/api/models` (GET) → Model list with metadata (`models`, `allModels`, `meta`)
- `/api/bg` (GET) → Wallpaper endpoint: Bing daily (cached per day), AI-generated (`ai-paper.jpg` with lazy regeneration), or 204 (none)
- `/api/generate-image` (POST) → Generate AI wallpaper, save to `.cache/ai-paper.jpg`
- `/api/keys` (GET/POST) — Multi-key CRUD (add/update/delete with `{name, token, platformUsername}`)
- `/api/account` (GET) → Platform user data (`{ logged_in, user }`)
- `/api/plan-status` (GET) → Subscription plan status with usage windows
- `/api/login` (POST) → Platform login with `{ username, password }`
- `/api/logout` (POST) → Clear platform session, save config
- `/api/platform/user` (GET) → Platform user info (requires login)
- `/api/platform/keys` (GET) → Fetch API keys from platform (`GET /api/token`) with plan name and username
- `/api/platform/token/:id/key` (GET) → Fetch full API key value from platform (`POST /api/token/:id/key`)
- `/api/cache` (GET/DELETE) → Cache stats/clear
- `/api/i18n` (GET) → Translated UI bundle. `?config=1` returns `{forced_locale, test_mode, local_overwrite, reason}`. `?locale=<xx>[&generate=1]` returns the bundle for a locale, generating on first use.
- `/healthz` → Health check with full status dump
- `/v1/models` → OpenAI models
- `/v1/chat/completions` → OpenAI chat

### 11. Session Tracking & Key Rotation

- `currentTokenIndex` — Module-level round-robin index
- `globalSessionCounter` — Monotonically incrementing session ID for each new conversation
- `conversationMap` — `Map<fingerprint, { tokenIndex, requestCount, sessNum }>` — tracks which token a conversation is pinned to
- `TITLE_PROMPT_RE` — `/generate\s+a\s+title\s+for\s+this\s+conversation/i` — regex to skip auto-title prompts
- `fingerprintPayload(payload)` — MD5 hash of the first user message (skips auto title prompts, strips `[label]` prefix) truncated to 12 chars to identify conversation threads
- `detectSessionSignal(payload)` — Core session logic:
  1. Computes fingerprint from first user message
  2. If fingerprint exists in `conversationMap` → pins to that token (sticky session), increments request count
  3. If new fingerprint → rotates to next key round-robin, stores mapping, stamps message with `[KeyName|sessN]`
- Console logs use `HH:MM:SS [Session#N>KeyName]-[model]-"actual prompt"` format

### 12. Opencode Config

- `setupOpencodeConfig()` — Writes provider config to `~/.config/opencode/opencode.json`
- Creates `openconfig.b4agnes.json` backup before first edit
- Provider key: `agnes`, using `@ai-sdk/openai-compatible` SDK
- Registers each model with its metadata; disabled models go into `blacklist` array
- Removes legacy `zenith` and `stepfun` providers on startup

### 13. Dashboard (dashboard.html)

- **Liquid Glass Engine** — Canvas-generated displacement maps with refraction profiles (`calculateRefractionProfile()`, `generateDisplacementMap()`, `generateSpecularMap()`)
- **SVG Filter Pipeline** — `feGaussianBlur` → `feImage` (displacement) → `feDisplacementMap` → `feColorMatrix` (saturation) → `feComposite` → `feBlend`
- **Plan Fieldset** — Subscription name, expiry countdown, 5-hour usage bar, weekly usage bar; shows "No Plan" card with login/subscribe CTA
- **API Key Manager Modal** — Inline add/edit/delete for multiple API keys + platform account info display; "Retrieve Tokens from Platform" and "Add Platform Account" buttons
- **Platform Login Modal** — Username/password login with status feedback, supports 'addAccount' mode for multiple accounts, Enter key support
- **Apply API Key Modal** — Post-login modal that fetches platform keys from `GET /api/token`, shows previews in dropdown, fetches full key from `POST /api/token/:id/key` on selection
- **`sanitizeKeyName(planName, userName)`** — Formats token name as `PlanName(username)` with dots removed, "free" stripped, thinspace for spaces
- **`retrievePlatformKeys()`** — Checks platform login, then opens apply key modal
- **Model Tags** — Toggle models on/off with capability badges (reasoning, tools, vision, context size)
- **Test Chat Bar** — Quick chat under the Models block, only visible when keys are configured
  - Model selector: `agnes-2.0-flash` (default) or `agnes-1.5-flash`
  - 200px tall scrollable transcript, glass design (matches plan cards)
  - Inner elements use `backdrop-filter: blur(...)` for the frosted look
  - Shows the **last 4 messages**, paired (user on top, assistant reply below)
  - Each message has a local `HH:MM` timestamp prefixing the role label
  - Pairs rendered in normal column order; transcript uses `flex-direction: column` + `justify-content: flex-end` so the latest exchange sits at the bottom
  - Live thinking indicator (3 dots) inside the pair; mutated in place to the real reply (no re-render, no double spinners)
  - Switching models clears the conversation and shows a toast
  - Clear button wipes history and shows the empty hint with the current model name
- **SS Mode** — `token-blurred` CSS class (blur on hover)
- **Bing Wallpaper** — Daily rotating background with toggle
- **AI Wallpaper** — Generated via Agnes AI image model, auto-enabled when a key is saved
- **Auto-refresh** — Health check every 15s, plan status every 30s
- **Collapsible Sections** — Models, API Key, Quick Actions, Environment, Proxy Configuration
- **Configuration Forms** — Listen address, upstream URL, timeout, test mode toggle, wallpaper mode selector with prompt input

## Request Lifecycle

```
Client request arrives
    ↓
Check API key authorization (if apiKeys configured)
    ↓
Route by pathname → handler
    ↓
Parse + validate request body
    ↓
Detect session signal (fingerprint first user msg)
    ↓
  ├─ Known fingerprint → pin to same token (sticky)
  └─ New fingerprint → rotate to next key, store mapping
    ↓
Clone payload, normalize tool schemas
    ↓
Forward to upstream apihub.agnes-ai.com (with platform session cookie if available)
    ↓
Receive response → decompress Brotli if needed
    ↓
  ├─ Success (2xx) → check cache eligibility
  │   ├─ Non-streaming → cache + send JSON
  │   └─ Streaming → pipe decompressed chunks to client
  └─ Error (4xx/5xx) → check retry eligibility
      ├─ "model unavailable" or "query engine" → retry (up to 3x, exponential backoff)
      └─ Other error → return formatted OpenAI error
    ↓
Success → log done
Error   → parse upstream error, return formatted response
```

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` with env var overrides
2. `ResponseCache` — Initialize LRU cache with configured TTL and max size
3. `UpstreamClient` — Initialize HTTP client
4. `validateApiKey()` — Verify via `/v1/models`
5. Platform session restore:
   - If first token's `platformToken` exists → restore session, validate via `platformGetUserInfo()`
   - If validation fails → re-login with `platformUsername`/`platformPassword`
   - Else if credentials exist → auto-login via `/api/user/login`
6. `fetchRemoteModels()` — Fetch models from Agnes AI API
7. `prefetchI18nOnStartup()` — If a forced locale is in effect (`localOverwrite` or `testMode`), translate the UI catalog and cache it to `.cache/i18n/<locale>.json`
8. `http.createServer(handleRequest).listen(port)` — With up to 10 retries on EADDRINUSE (2s apart)

Note: `setupOpencodeConfig()` is called on config mutations (login, logout, key changes), not during startup itself.

## Response Caching

LRU cache for non-streaming LLM responses:

- **Key**: MD5 hash of `(model + stream_flag + system + messages + tools)`
- **TTL**: Configurable via `CACHE_TTL` (default `60s`)
- **Max size**: Configurable via `CACHE_MAX_SIZE` (default 100 entries)
- **Disable**: Set `CACHE_ENABLED=false`
- **Stats**: `GET /api/cache` — hits, misses, evictions, size
- **Clear**: `DELETE /api/cache`
- **Excluded**: Streaming requests are never cached. Only 2xx non-streaming responses are stored.

## Testing

```bash
# Syntax check
node --check proxy.js

# Start proxy
node proxy.js

# Or use launcher (auto-detects Bun, falls back to Node)
start.cmd

# Or Node-only launcher
start-node.cmd

# Test endpoints
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
curl http://localhost:8080/api/models
curl http://localhost:8080/api/account
curl http://localhost:8080/api/plan-status

# Test platform login
curl -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user@example.com","password":"secret"}'

# Test platform logout
curl -X POST http://localhost:8080/api/logout

# Test platform keys
curl http://localhost:8080/api/platform/keys
curl http://localhost:8080/api/platform/token/12345/key

# Test chat completion
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"Hello"}]}'

# Test streaming
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"agnes-2.0-flash","stream":true,"messages":[{"role":"user","content":"Hello"}]}'

# Test cache
curl http://localhost:8080/api/cache
curl -X DELETE http://localhost:8080/api/cache

# Test wallpaper
curl http://localhost:8080/api/bg
curl -X POST http://localhost:8080/api/generate-image

# Test i18n (autotranslate)
curl 'http://localhost:8080/api/i18n?config=1'              # see effective forced locale
curl 'http://localhost:8080/api/i18n?locale=de'              # cached bundle (or pending placeholder)
curl 'http://localhost:8080/api/i18n?locale=de&generate=1'   # generate via Agnes on first use, then cache
```

## Security

- API keys for proxy authentication (optional, via `API_KEYS` config)
- Keys masked in `/api/config` responses (`substring(0,10) + '...'`)
- Platform credentials stored per-token in config (plaintext) — use env vars for production
- `setupOpencodeConfig()` creates backup before first edit
- Global `uncaughtException` and `unhandledRejection` handlers prevent silent crashes
