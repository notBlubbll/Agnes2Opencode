# Agnes2Opencode — Developer Guide

## Project Structure

```
AGNES-PROXY/
├── proxy.js              # Main proxy implementation
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

- `AGNES_API_BASE` — `https://agnes-ai.com/api`
- `AGNES_MODELS_URL` — `https://agnes-ai.com/api/v1/models`
- `PLATFORM_BASE_URL` — `https://platform-backend.agnes-ai.com`
- `API_KEY_ENV_VAR` — `AGNES_API_KEY`
- `loadConfig()` — Loads `.config/config.json` with env var overrides (including `PLATFORM_USERNAME`, `PLATFORM_PASSWORD`)
- `saveConfig()` — Writes config back to `.config/config.json` (including platform credentials)
- `generateAiWallpaperToDisk()` — Generates AI image via `/v1/images/generations`, saves to `.cache/ai-paper.jpg`
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`

### 2. UpstreamClient

- `headers(stream)` — Returns Bearer token + Content-Type/Accept/Accept-Encoding headers + platform session cookie
- `getUserInfo()` — `GET /v1/models` with 10s timeout to validate API key
- `chatCompletions(body)` — `POST /v1/chat/completions` (streaming-aware)

### 3. Platform Login

- `loginToPlatform(username, password)` — `POST ${PLATFORM_BASE_URL}/api/user/login` with 15s timeout
- `getPlatformHeaders()` — Returns `{ Cookie, Authorization }` for platform API calls
- `platformGetUserInfo()` — `GET ${PLATFORM_BASE_URL}/api/user/self` to fetch current user data
- `platformSession` — Module-level state: `{ token, user, expiresAt }`
- Auto-login on startup: restores saved token OR logs in with `PLATFORM_USERNAME`/`PLATFORM_PASSWORD` if no token exists

### 4. Model Registry

- `AGNES_MODELS` — Hardcoded array of model IDs (fallback)
- `fetchRemoteModels()` — Fetches from `AGNES_MODELS_URL` with 5-minute TTL cache

### 5. Decompression

- `readBodyWithDecompress(body, contentEncoding)` — Reads response body and decompresses Brotli/gzip/deflate
- `readBodyBody(body)` — Reads raw bytes from Node stream, web ReadableStream, or async iterable

### 6. Utility Functions

- `cloneMap()` / `cloneSlice()` — Deep clone objects/arrays
- `normalizeToolSchemas(tools)` — Entry point for `$ref` resolution in tool schemas
- `extractDefinitions(schema)` — Merges `definitions` + `$defs`
- `normalizeSchemaMap(node, defs, maxDepth)` — Recursive `$ref` resolver (max depth: 12)
- `readBodyText(body)` — Handles Node streams, web ReadableStream, async iterables
- `extractUserPrompt(payload)` — Returns last user message text for logging
- `fingerprintPayload(payload)` — MD5 hash of first user message for session tracking

### 7. HTTP Handlers

- `authorized(req)` — Checks `x-api-key` header or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Buffers incoming request body to string
- `writeJSON(res, statusCode, payload)` — JSON response with error-safe write
- `writeOpenAIError()` — OpenAI error format
- `handleHealthz(req, res)` — Returns uptime, API key validity, models count, runtime info, platform login status
- `handleModels(req, res)` — OpenAI-format model list
- `handleChatCompletions(req, res)` — Parses body, calls `proxyChatRequest`
- `handleAccountInfo(req, res)` — Returns platform user data from `/api/user/self`
- `handleBg(req, res)` — Wallpaper endpoint: serves Bing daily, AI-generated (`ai-paper.jpg`), or 204 (none)
- `proxyChatRequest(res, payload, model)` — Core proxy: clone payload, normalize tools, forward to upstream

### 8. Request Router

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html`
- `/api/config` (GET/POST) — Config read/write (masks platformPassword, accepts platformUsername/platformPassword updates)
- `/api/validate` (GET) → Validate API key
- `/api/models` (GET) → Model list
- `/api/bg` (GET) → Wallpaper endpoint: Bing daily, AI-generated image, or 204 (none)
- `/api/generate-image` (POST) → Generate AI wallpaper, save to `.cache/ai-paper.jpg`
- `/api/keys` (GET/POST) → Multi-key CRUD (add/update/delete with `{name, token}`)
- `/api/account` (GET) → Platform user data (`{ logged_in, user }`)
- `/api/login` (POST) → Platform login with `{ username, password }`
- `/api/logout` (POST) → Clear platform session, save config
- `/api/cache` (GET/DELETE) → Cache stats/clear
- `/healthz` → Health check
- `/v1/models` → OpenAI models
- `/v1/chat/completions` → OpenAI chat

### 9. Session Tracking & Key Rotation

- `currentTokenIndex` — Module-level round-robin index
- `globalSessionCounter` — Monotonically incrementing session ID for each new conversation
- `conversationMap` — `Map<fingerprint, { tokenIndex, requestCount, sessNum }>` — tracks which token a conversation is pinned to
- `fingerprintPayload(payload)` — MD5 hash of the first user message (skips auto title prompts, strips `[label]` prefix) to identify conversation threads
- `detectSessionSignal(payload)` — Core session logic:
  1. Computes fingerprint from first user message
  2. If fingerprint exists in `conversationMap` → pins to that token (sticky session)
  3. If new fingerprint → rotates to next key round-robin, stores mapping, stamps message with `[KeyName|sessN]`
- Console logs use `HH:MM:SS [Session#N>KeyName]-[model]-"actual prompt"` format

### 10. Opencode Config

- `setupOpencodeConfig()` — Writes provider config to multiple paths:
  1. `~/.opencode/opencode.json` (Win32 priority)
  2. `~/.config/opencode/opencode.json`
  3. `C:\Windows\System32\config\systemprofile\.opencode\opencode.json` (Win32)
- Creates `openconfig.b4agnes.json` backup before first edit
- Provider key: `agnes`, using `@ai-sdk/openai-compatible`

### 11. Dashboard (dashboard.html)

- **Liquid Glass Engine** — Canvas-generated displacement maps with refraction profiles
- **SVG Filter Pipeline** — `feGaussianBlur` → `feDisplacementMap` → `feColorMatrix` → `feComposite` → `feBlend`
- **Key Manager Modal** — Inline add/edit/delete for multiple API keys + platform account info display
- **Platform Login Modal** — Username/password login with status feedback
- **Account Info Section** — Shows user data (username, email, status, joined, last login) with Logout button
- **Model Tags** — Toggle models on/off with checkbox UI
- **SS Mode** — `token-blurred` CSS class (blur on hover)
- **Bing Wallpaper** — Daily rotating background with toggle
- **AI Wallpaper** — Generated via Agnes AI image model, preloaded to disk for instant display
- **Auto-refresh** — Health check every 15s
- **Collapsible Sections** — Models, API Key, Quick Actions, Environment, Proxy Configuration

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
Forward to upstream agnes-ai.com/api (with platform session cookie if available)
    ↓
Receive response → decompress Brotli if needed
    ↓
  ├─ Streaming → pipe decompressed chunks to client
  └─ Non-streaming → buffer, cache, send JSON
    ↓
Success → log done
Error   → parse upstream error, return formatted response
```

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` + env var overrides (including platform credentials)
2. `UpstreamClient` — Initialize HTTP client
3. `validateApiKey()` — Verify via `/v1/models`
4. Platform login:
   - If `platformToken` exists in config → restore session
   - Else if `platformUsername` + `platformPassword` configured → auto-login via `/api/user/login`
5. `fetchRemoteModels()` — Fetch models from Agnes AI API
6. `setupOpencodeConfig()` — Write/update opencode provider config
7. `http.createServer(handleRequest).listen(port)` — Start HTTP server

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

# Test endpoints
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
curl http://localhost:8080/api/models
curl http://localhost:8080/api/account

# Test platform login
curl -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user@example.com","password":"secret"}'

# Test platform logout
curl -X POST http://localhost:8080/api/logout

# Test chat completion
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sapiens-ai/agnes-1.5-pro","messages":[{"role":"user","content":"Hello"}]}'

# Test streaming
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sapiens-ai/agnes-1.5-pro","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

## Security

- API keys for proxy authentication (optional, via `API_KEYS` config)
- Keys masked in `/api/config` responses (`substring(0,10) + '...'`)
- Platform password masked as `***` in GET `/api/config`
- No token logging in request logs
- Config file should be `.gitignore`'d
- SS Mode (`.token-blurred`) in dashboard obscures tokens for screenshots
- Platform credentials stored in config (plaintext) — use env vars `PLATFORM_USERNAME`/`PLATFORM_PASSWORD` for production
