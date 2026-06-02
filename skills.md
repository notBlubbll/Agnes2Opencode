# Skills: Modifying Provider Lists in opencode.json

Guide for adding, removing, and configuring LLM providers in OpenCode's `opencode.json` config.

## File Location

The config file lives at the project root or `~/.config/opencode/opencode.json`.

## Basic Structure

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "<provider_id>": {
      "models": {
        "<model_id>": {}
      }
    }
  }
}
```

Format for selecting a model: `provider_id/model_id`

---

## Add a Custom Provider (OpenAI-compatible)

For any OpenAI-compatible API (local or remote):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "agnes": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Agnes2Opencode",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1"
      },
      "models": {
        "sapiens-ai/agnes-1.5-pro": { "name": "Agnes 1.5 Pro" },
        "sapiens-ai/agnes-1.5-lite": { "name": "Agnes 1.5 Lite" }
      }
    }
  }
}
```

Fields:
- `npm` — SDK package to use (`@ai-sdk/openai-compatible` for OpenAI-compatible APIs)
- `name` — Display name in the UI
- `options.baseURL` — API endpoint
- `models` — Map of model IDs to display names

---

## Set the Default Model

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "agnes/sapiens-ai/agnes-1.5-pro"
}
```

---

## Full Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "agnes/sapiens-ai/agnes-1.5-pro",
  "provider": {
    "agnes": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Agnes2Opencode",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1"
      },
      "models": {
        "sapiens-ai/agnes-1.5-pro": { "name": "Agnes 1.5 Pro" },
        "sapiens-ai/agnes-1.5-lite": { "name": "Agnes 1.5 Lite" },
        "sapiens-ai/agnes-image-1.2": { "name": "Agnes Image 1.2" },
        "sapiens-ai/agnes-video-v1.2": { "name": "Agnes Video V1.2" }
      }
    }
  }
}
```

---

## Quick Reference

| Task | Key |
|------|-----|
| Add provider | `provider.<id>` |
| Add model | `provider.<id>.models.<model_id>` |
| Set base URL | `provider.<id>.options.baseURL` |
| Set display name | `provider.<id>.name` |
| Set SDK package | `provider.<id>.npm` |
| Configure model options | `provider.<id>.models.<model_id>.options` |
| Set default model | `model` (top-level) |

Source: https://opencode.ai/docs/models/#configure-models
