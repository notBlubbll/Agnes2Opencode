# Agnes2Opencode

OpenAI-compatible proxy server for [Agnes AI](https://agnes-ai.com), providing access to Agnes LLM models through a unified API. Zero external dependencies — uses only Node.js built-in modules.

## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Streaming Support** — SSE streaming for chat completions
- **Tool Schema Normalization** — Resolves `$ref` and `$defs` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, model/key management, real-time stats
- **Platform Login** — Login with Agnes AI account credentials, session persistence
- **Auto-Config** — Automatically configures opencode provider on startup
- **Dynamic Model Fetch** — Fetches available models from `https://agnes-ai.com/api/v1/models`
- **Response Caching** — LRU cache for non-streaming responses
- **Multi-Key Support** — Rotate between multiple Agnes AI API keys
- **Zero Dependencies** — No npm packages required

## Available Models

| Model | Description |
|-------|-------------|
| `sapiens-ai/agnes-1.5-pro` | High-performance text model for advanced reasoning and tool calling |
| `sapiens-ai/agnes-1.5-lite` | Lightweight multimodal model for low latency and cost efficiency |
| `sapiens-ai/agnes-image-1.2` | Image generation model (text-to-image, image-to-image) |
| `sapiens-ai/agnes-video-v1.2` | Cinematic-grade async video generation with synchronized audio |

Models are dynamically fetched from `https://agnes-ai.com/api/v1/models` on startup.

## Quick Start

```bash
# Clone and start (zero deps — no npm install needed)
cd AGNES-PROXY
node proxy.js

# Or use launcher (auto-detects Bun, falls back to Node)
start.cmd

# Open dashboard
open http://localhost:8080
```

## Authentication

Get an Agnes AI API key from [agnes-ai.com](https://agnes-ai.com).

Add to `.config/config.json`:

```json
{
  "API_KEY": "sk-your-agnes-api-key"
}
```

Or set environment variable:

```bash
set AGNES_API_KEY=sk-your-agnes-api-key
node proxy.js
```

## Configuration

Edit `.config/config.json` or set environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `LISTEN_ADDR` | Proxy listen address | `127.0.0.1:8080` |
| `UPSTREAM_BASE_URL` | Agnes AI API URL | `https://agnes-ai.com/api` |
| `API_KEY` | Agnes AI API key | — |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `API_KEYS` | Client API keys for proxy auth | `[]` (open access) |
| `TOKENS` | Array of `{name, token}` for multi-key support | auto-populated |
| `CACHE_TTL` | Response cache TTL | `60s` |
| `CACHE_MAX_SIZE` | Max cached responses | `100` |
| `CACHE_ENABLED` | Enable response caching | `true` |
| `PLATFORM_USERNAME` | Agnes AI account email | — |
| `PLATFORM_PASSWORD` | Agnes AI account password | — |
| `ENABLE_WALLPAPER` | Bing wallpaper background | `true` |

### Platform Login

The proxy supports logging into your Agnes AI platform account for additional features:

1. **Via Dashboard**: Open the Keys modal → click "Login" → enter credentials
2. **Via Config**: Set `PLATFORM_USERNAME` and `PLATFORM_PASSWORD` in config
3. **Via Env Vars**: Set `PLATFORM_USERNAME` and `PLATFORM_PASSWORD`

Auto-login on startup if credentials are configured and no saved session exists.

```json
{
  "PLATFORM_USERNAME": "user@example.com",
  "PLATFORM_PASSWORD": "your-password"
}
```

Platform session is persisted in config and reused across restarts.

### Multi-Key Management

The proxy supports multiple Agnes AI API keys. Set `TOKENS` in config:

```json
{
  "TOKENS": [
    { "name": "Key 1", "token": "sk-key-1" },
    { "name": "Key 2", "token": "sk-key-2" }
  ]
}
```

Manage keys via the **Dashboard → Manage Keys** modal (inline add/edit/delete).

### Key Rotation & Session Tracking

The proxy automatically rotates tokens across conversations using **fingerprint-based session tracking**.
Each conversation is identified by an MD5 hash of the first user message (skipping auto title prompts).
Follow-up requests (tool calls, continuations) in the same conversation are pinned to the same token
automatically. A global session counter increments for each new conversation.

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
  model: 'sapiens-ai/agnes-1.5-pro',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### opencode Integration

The proxy auto-configures opencode on startup. Restart opencode after starting the proxy, then select the `agnes` provider.

## Dashboard

Access at `http://localhost:8080`:

- **Cache Stats** — Real-time cache hits and performance
- **API Key Status** — Online/Offline indicator
- **SS Mode** — Blur sensitive tokens for screenshots
- **Liquid Glass Effects** — Canvas-generated SVG displacement maps
- **Model Management** — Toggle models on/off
- **Key Manager** — Add/edit/delete API keys with inline editing
- **Platform Login** — Login with Agnes AI account, view account info, logout
- **Collapsible Sections** — Models, API Key, Quick Actions, Environment, Proxy Configuration

## API Endpoints

### Core API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check with API key status, uptime, platform login status |
| `GET` | `/v1/models` | OpenAI models list |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (streaming supported) |

### Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` | `/api/config` | Read/write proxy configuration |
| `GET` | `/api/validate` | Validate API key |
| `GET` | `/api/models` | List available model IDs |
| `GET` | `/api/bg` | Bing wallpaper image (cached daily) |
| `GET` / `POST` | `/api/keys` | Multi-key CRUD (add/update/delete) |
| `GET` | `/api/account` | Platform user data (`{ logged_in, user }`) |
| `POST` | `/api/login` | Platform login with `{ username, password }` |
| `POST` | `/api/logout` | Clear platform session |
| `GET` / `DELETE` | `/api/cache` | View/clear response cache |

## Architecture

```
proxy.js
├── Config System         — JSON + env vars + API key validation
├── UpstreamClient        — HTTP client for Agnes AI API
│   ├── getUserInfo()     — GET /v1/models (validate key)
│   └── chatCompletions() — POST /v1/chat/completions
├── Platform Login        — Login/session management for platform account
│   ├── loginToPlatform() — POST /api/user/login
│   ├── platformGetUserInfo() — GET /api/user/self
│   └── platformSession   — Token + user state
├── Tool Schema Norm.     — $ref resolution and schema normalization
├── HTTP Handlers         — OpenAI + management endpoints
├── Request Router        — Pathname-based routing
├── Session Tracking      — Fingerprint-based sticky sessions
├── Opencode Config       — Auto-configures opencode provider
└── Server Startup        — Validation, platform login, config write, listen

dashboard.html
├── Liquid Glass Engine   — Canvas-based displacement/specular maps
├── Model Management      — Toggle models on/off
├── Key Manager           — Add/edit/delete API keys + account info
├── Platform Login Modal  — Username/password login with status
├── Bing Wallpaper        — Daily rotating background
├── Cache Stats           — Real-time cache performance
└── Configuration Forms   — Listen addr, upstream URL, timeout
```

## Dependencies

No external npm dependencies — uses Node.js built-in modules only: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, `zlib`.

## License

MIT
