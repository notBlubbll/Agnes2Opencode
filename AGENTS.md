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
- `loadConfig()` — Loads `.config/config.json` with env var overrides; normalizes `TOKENS` array with per-token fields (`name`, `token`, `email`, `platformUsername`, `platformPassword`, `platformToken`, `platformUser`)
- `saveConfig()` — Writes config back to `.config/config.json` (serializes `TOKENS`, `ENABLED_MODELS`, cache settings, etc.)
- `generateAiWallpaperToDisk()` — Generates AI image via `/v1/images/generations` with model `agnes-image-2.1-flash`, saves to `.cache/ai-paper.jpg` (supports both URL-based and base64-encoded responses)
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`

### 2. UpstreamClient

- `headers(stream)` — Returns Bearer token + Content-Type/Accept/Accept-Encoding headers + platform session cookie
- `getUserInfo()` — `GET /v1/models` with 10s AbortController timeout to validate API key
- `chatCompletions(body)` — `POST /v1/chat/completions` with configurable timeout, streaming-aware
- `getAccountInfo()` — Returns null (unused)
- `getStepPlanStatus()` — Returns null (unused)
- `getPlanStatus()` — Returns null (unused)

### 3. Platform Login

- `loginToPlatform(username, password)` — `POST ${PLATFORM_BASE_URL}/api/user/login` with 15s timeout; persists credentials back to first token for auto-login on restart
- `getPlatformHeaders()` — Returns `{ Cookie, Authorization }` for platform API calls
- `platformGetUserInfo()` — `GET ${PLATFORM_BASE_URL}/api/user/self` to fetch current user data
- `platformSession` — Module-level state: `{ token, user, expiresAt }`
- Platform credentials (`platformUsername`, `platformPassword`, `platformToken`, `platformUser`) are stored per-token in the `TOKENS` array
- Auto-login on startup: restores saved token from first token's `platformToken` OR logs in with first token's `platformUsername`/`platformPassword` if no token exists; validates session via `platformGetUserInfo()`

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
- `handleStepPlanStatus(req, res)` — Returns subscription/plan status with usage windows (returns test data when `config.testMode` is true)
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
  - `/api/step-plan-status` returns synthetic subscription data with fake usage windows
- Enabled via `TEST_MODE: true` in config

### 10. Request Router (pathname-based)

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html` with no-cache headers
- `/api/config` (GET/POST) — Config read/write (masks tokens, reads/writes per-token platform credentials)
- `/api/validate` (GET) → Validate API key
- `/api/models` (GET) → Model list with metadata (`models`, `allModels`, `meta`)
- `/api/bg` (GET) → Wallpaper endpoint: Bing daily (cached per day), AI-generated (`ai-paper.jpg` with lazy regeneration), or 204 (none)
- `/api/generate-image` (POST) → Generate AI wallpaper, save to `.cache/ai-paper.jpg`
- `/api/keys` (GET/POST) — Multi-key CRUD (add/update/delete with `{name, token}`)
- `/api/account` (GET) → Platform user data (`{ logged_in, user }`)
- `/api/step-plan-status` (GET) → Subscription plan status with usage windows
- `/api/login` (POST) → Platform login with `{ username, password }`
- `/api/logout` (POST) → Clear platform session, save config
- `/api/platform/user` (GET) → Platform user info (requires login)
- `/api/cache` (GET/DELETE) → Cache stats/clear
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
- **Key Manager Modal** — Inline add/edit/delete for multiple API keys + platform account info display
- **Platform Login Modal** — Username/password login with status feedback
- **Model Tags** — Toggle models on/off with capability badges (reasoning, tools, vision, context size)
- **SS Mode** — `token-blurred` CSS class (blur on hover)
- **Bing Wallpaper** — Daily rotating background with toggle
- **AI Wallpaper** — Generated via Agnes AI image model, preloaded to disk for instant display
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
7. `http.createServer(handleRequest).listen(port)` — With up to 10 retries on EADDRINUSE (2s apart)

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
curl http://localhost:8080/api/step-plan-status

# Test platform login
curl -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user@example.com","password":"secret"}'

# Test platform logout
curl -X POST http://localhost:8080/api/logout

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
```

## Security

- API keys for proxy authentication (optional, via `API_KEYS` config)
- Keys masked in `/api/config` responses (`substring(0,10) + '...'`)
- Platform credentials stored per-token in config (plaintext) — use env vars for production
- `setupOpencodeConfig()` creates backup before first edit
- Global `uncaughtException` and `unhandledRejection` handlers prevent silent crashes
