// Agnes2Opencode - v2026-06-02
process.on('uncaughtException', (e) => { console.error('[FATAL]', e.message); });
process.on('unhandledRejection', (e) => { console.error('[Unhandled]', e?.message || e); });
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const AGNES_API_BASE = 'https://apihub.agnes-ai.com';
const AGNES_MODELS_URL = 'https://apihub.agnes-ai.com/v1/models';
const PLATFORM_BASE_URL = 'https://platform-backend.agnes-ai.com';
const API_KEY_ENV_VAR = 'AGNES_API_KEY';
const AGNES_USER_AGENT = 'Agnes2Opencode';

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let config = null;
let modelsCache = null;
let dynamicModels = null;
let dynamicModelsTime = 0;
const DYNAMIC_MODELS_TTL = 300000;
let startTime = new Date();
let currentTokenIndex = 0;
let globalSessionCounter = 0;
let conversationMap = new Map();
let platformSession = { token: null, user: null, expiresAt: 0 };
let wallpaperGenerating = false;
let wallpaperGenerationPromise = null;

function extractUserPrompt(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return '';
  const text = (m) => {
    const raw = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
    return raw.replace(/^\[[^\]]+\]\s*/, '');
  };
  const user = msgs.findLast(m => m.role === 'user');
  if (!user) return '';
  return text(user);
}

// --- LRU Response Cache ---
class ResponseCache {
  constructor(maxSize = 100, ttlMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.time > this.ttlMs) {
      this._map.delete(key);
      this.misses++;
      return null;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this.evictions++;
    }
    this._map.set(key, { value, time: Date.now() });
  }
  get stats() {
    return { size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
  clear() { this._map.clear(); this.hits = 0; this.misses = 0; this.evictions = 0; }
  get enabled() { return this.maxSize > 0 && this.ttlMs > 0; }
}

function cacheKey(payload, requestedModel) {
  const parts = [requestedModel, payload.stream ? 'stream:1' : 'stream:0'];
  if (payload.system) parts.push(typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system));
  if (payload.messages) parts.push(JSON.stringify(payload.messages));
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  return crypto.createHash('md5').update(parts.join('||')).digest('hex');
}

let responseCache = new ResponseCache();

// --- Config ---
function loadConfig() {
  const configPath = path.join(__dirname, '.config', 'config.json');
  let rawConfig = {
    LISTEN_ADDR: '127.0.0.1:8082',
    UPSTREAM_BASE_URL: AGNES_API_BASE,
    REQUEST_TIMEOUT: '15m',
    CACHE_TTL: '60s',
    CACHE_MAX_SIZE: 100,
    CACHE_ENABLED: true,
    TEST_MODE: false,
  };
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env[API_KEY_ENV_VAR]) rawConfig.API_KEY = process.env[API_KEY_ENV_VAR];
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.CACHE_TTL) rawConfig.CACHE_TTL = process.env.CACHE_TTL;
  if (process.env.CACHE_MAX_SIZE) rawConfig.CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE);
  if (process.env.CACHE_ENABLED) rawConfig.CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
  if (process.env.TEST_MODE) rawConfig.TEST_MODE = process.env.TEST_MODE !== 'false';
  if (process.env.LOCAL_OVERWRITE) rawConfig.LOCAL_OVERWRITE = process.env.LOCAL_OVERWRITE;

  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (!rawConfig.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');

  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, '');

  const rawKeys = rawConfig.KEYS || rawConfig.TOKENS;
  let keys = Array.isArray(rawKeys) && rawKeys.length > 0 ? rawKeys : [];
  keys = keys.filter(t => t && (t.key || t.token));
  if (keys.length === 0) {
    keys.push({ name: 'Key 1', key: rawConfig.API_KEY || '', session: '' });
    keys = keys.filter(t => t && (t.key || t.token));
    if (keys.length === 0) keys.push({ name: 'Key 1', key: '', session: '' });
  }
  keys = keys.map(t => ({ name: t.name || 'Unnamed', key: t.key || t.token || '', email: t.email || '', platformUsername: t.platformUsername || '', platformPassword: t.platformPassword || '', platformToken: t.platformToken || '', platformUser: t.platformUser || null }));

  // Load platform users array
  let platformUsers = Array.isArray(rawConfig.PLATFORM_USERS) ? rawConfig.PLATFORM_USERS : [];
  // Backward compat: migrate from keys[0] if platformUsers is empty
  if (platformUsers.length === 0 && keys.length > 0 && keys[0].platformUsername) {
    platformUsers.push({
      username: keys[0].platformUsername,
      password: keys[0].platformPassword || '',
      token: keys[0].platformToken || '',
      user: keys[0].platformUser || null,
    });
  }
  platformUsers = platformUsers.map(u => ({
    username: u.username || '',
    password: u.password || '',
    token: u.token || '',
    user: u.user || null,
  }));

  // Link keys to platform users by username
  keys = keys.map(t => {
    if (t.platformUsername && !platformUsers.find(u => u.username === t.platformUsername)) {
      platformUsers.push({
        username: t.platformUsername,
        password: t.platformPassword || '',
        token: t.platformToken || '',
        user: t.platformUser || null,
      });
    }
    return { name: t.name || 'Unnamed', key: t.key || '', platformUser: t.platformUser || t.platformUsername || '' };
  });

  const rawModels = rawConfig.ENABLED_MODELS;
  const enabledModels = Array.isArray(rawModels) && rawModels.length > 0 ? rawModels : [...AGNES_MODELS];

  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    apiKey: keys[0].key || rawConfig.API_KEY || '',
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    enabledModels,
    keys,
    platformUsers,
    cacheTtl: parseDuration(rawConfig.CACHE_TTL || '60s') || 60000,
    cacheMaxSize: Math.max(0, rawConfig.CACHE_MAX_SIZE || 100),
    cacheEnabled: rawConfig.CACHE_ENABLED !== false,
    testMode: rawConfig.TEST_MODE !== false,
    localOverwrite: typeof rawConfig.LOCAL_OVERWRITE === 'string' && rawConfig.LOCAL_OVERWRITE.trim() ? rawConfig.LOCAL_OVERWRITE.trim().toLowerCase().split(/[-_]/)[0].slice(0, 8) : null,
    wallpaperMode: rawConfig.WALLPAPER_MODE || 'bing',
    img_prompt: rawConfig.IMG_PROMPT || rawConfig.WALLPAPER_PROMPT || 'realistic vibrant colorful mountain range landscape',
    video_prompt: rawConfig.VIDEO_PROMPT || rawConfig.WALLPAPER_PROMPT || 'cinematic slow motion of a vibrant colorful mountain range landscape with drifting clouds, 5 seconds',
  };
}

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

function saveConfig(cfg) {
  const configPath = path.join(__dirname, '.config', 'config.json');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!Array.isArray(cfg.enabledModels) || cfg.enabledModels.length === 0) cfg.enabledModels = dynamicModels && dynamicModels.length > 0 ? [...dynamicModels] : [...AGNES_MODELS];
  if (Array.isArray(cfg.keys)) cfg.keys = cfg.keys.filter(t => t && (t.key || t.token));
  const platformUsers = (cfg.platformUsers || []).map(u => ({
    username: u.username || '',
    password: u.password || '',
    token: u.token || '',
    user: u.user || null,
  }));
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    API_KEY: cfg.apiKey,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys,
    KEYS: cfg.keys,
    PLATFORM_USERS: platformUsers,
    ENABLED_MODELS: cfg.enabledModels,
    WALLPAPER_MODE: cfg.wallpaperMode || 'bing',
    IMG_PROMPT: cfg.img_prompt || 'realistic vibrant colorful mountain range landscape',
    VIDEO_PROMPT: cfg.video_prompt || 'cinematic slow motion of a vibrant colorful mountain range landscape with drifting clouds, 5 seconds',
    CACHE_TTL: `${(cfg.cacheTtl || 60000) / 1000}s`,
    CACHE_MAX_SIZE: cfg.cacheMaxSize || 100,
    CACHE_ENABLED: cfg.cacheEnabled !== false,
    TEST_MODE: cfg.testMode !== false,
    LOCAL_OVERWRITE: cfg.localOverwrite || null,
    KEYS: cfg.keys,
    PLATFORM_USERS: platformUsers,
  }, null, 2));
}

// --- i18n: UI string catalog for dashboard translation ---
// Every user-visible dashboard string. Keys are stable identifiers; values
// are the original English text. The proxy translates these on startup per
// locale and caches the result on disk for instant reuse.
const I18N_STRINGS = {
  // Header
  app_title: 'Agnes2Opencode Dashboard',
  status_checking: 'Checking...',
  status_online: 'Online',
  status_offline: 'Offline',
  status_test: 'Test',

  // Plan fieldset
  plan_legend: 'Plan',
  plan_label: 'Plan',
  plan_loading: 'Loading...',
  usage_5h: '5h Usage',
  usage_weekly: 'Weekly Usage',
  plan_free_access: 'Free Access',
  plan_no_key: 'No key configured',
  plan_free_mode: 'Free mode',
  plan_free_plan: 'Free Plan',
  plan_expired: 'expired',

  // Models
  section_models: 'Available Models',
  models_no_keys: 'Add a key to see available models',
  models_none: 'No models available',
  model_enabled: 'enabled',
  model_disabled: 'disabled',
  model_saved_fail: 'Failed to save model settings',

  // Test Chat
  section_test_chat: 'Test Chat',
  test_chat_empty: 'Ask {model} anything to test your API key.',
  test_chat_placeholder: 'Type a message...',
  test_chat_send: 'Send',
  test_chat_sending: 'Sending',
  test_chat_role_you: 'You',
  test_chat_role_agnes: 'Agnes',
  test_chat_no_response: '(no response)',
  test_chat_cleared: 'Conversation cleared',
  test_chat_model_switched_cleared: 'Model switched to {model} — conversation cleared',
  test_chat_model_switched: 'Model switched to {model}',
  test_chat_clear: 'Clear conversation',
  test_chat_error_prefix: 'Error:',

  // Tokens / API Key card
  section_api_key: 'API Key',
  btn_manage: 'Manage',
  tokens_none: 'No API keys detected',
  tokens_unnamed: 'Unnamed',
  tokens_no_keys: 'No API keys configured.',

  // Quick Actions
  section_quick_actions: 'Quick Actions',
  btn_check_health: 'Check Health',
  btn_test_connection: 'Test Connection',
  btn_refresh_models: 'Refresh Models',
  btn_platform_login: 'Platform Login',

  // Environment
  section_environment: 'Environment',
  env_runtime: 'Runtime',
  env_started_at: 'Started At',
  env_wallpaper: 'Wallpaper',
  wp_none: 'None',
  wp_bing: 'Bing',
  wp_ai: 'AI Image',
  wp_video: 'AI Video',
  wp_ai_prompt: 'AI Prompt',
  wp_ai_placeholder: 'Image prompt...',
  env_ss_mode: 'SS Mode',

  // Proxy Configuration
  section_proxy_config: 'Proxy Configuration',
  cfg_listen_addr: 'Listen Address',
  cfg_timeout: 'Timeout',
  cfg_upstream_url: 'Upstream URL',

  // Keys modal
  modal_manage_keys: 'Manage API Keys',
  modal_add_key: 'Add New API Key',
  key_name_placeholder: 'Key name (e.g. Key 2)',
  key_value_placeholder: 'API key value',
  btn_add_key: 'Add Key',
  btn_retrieve_tokens: 'Retrieve Tokens from Platform',
  btn_add_platform_account: 'Add Platform Account',
  btn_close: 'Close',
  platform_account: 'Platform Account',
  online: 'Online',
  logout_and_remove: 'Logout & Remove',
  label_user: 'User',
  label_email: 'Email',
  label_status: 'Status',
  label_last_login: 'Last login',
  status_active: 'Active',
  status_inactive: 'Inactive',
  no_platform_accounts: 'No platform accounts',
  btn_login: 'Login',
  toast_key_required: 'Key is required',
  toast_key_added: 'Key added',
  toast_key_updated: 'Key updated',
  toast_key_deleted: 'Key deleted',
  toast_failed_add: 'Failed to add key',
  toast_failed_update: 'Failed to update key',
  toast_failed_delete: 'Failed to delete key',
  toast_failed_prefix: 'Failed:',
  label_name: 'Name',
  label_key: 'Key',
  btn_save: 'Save',
  btn_cancel: 'Cancel',
  btn_delete: 'Delete',
  delete_confirm: 'Delete this key?',
  label_session: 'Session',
  user_none: 'None',
  toast_failed_load_config: 'Failed to load configuration',
  toast_failed_load_keys: 'Failed to load keys',
  toast_proxy_healthy: 'Proxy is healthy',
  toast_health_failed: 'Proxy health check failed',
  toast_connected: 'Connected! {n} models available',
  toast_connection_failed: 'Connection test failed',
  toast_models_refreshed: 'Models refreshed',

  // Platform login modal
  modal_platform_login: 'Platform Login',
  modal_add_platform_account: 'Add Platform Account',
  label_username: 'Username (email)',
  username_placeholder: 'email@example.com',
  label_password: 'Password',
  password_placeholder: 'password',
  btn_save_and_login: 'Save & Login',
  toast_required_fields: 'Username and password are required',
  toast_logging_in: 'Logging in...',
  toast_logged_in_as: 'Logged in as {email}',
  toast_login_success: 'Platform login successful',
  toast_login_failed_prefix: 'Login failed:',
  toast_error_prefix: 'Error:',
  toast_logout: 'Logged out',

  // Apply key modal
  modal_apply_key: 'Apply API Key',
  apply_key_subtitle: 'Select an API key from your account to apply.',
  apply_key_loading: 'Loading keys...',
  apply_key_no_keys: 'No keys found on your account.',
  apply_key_active: 'Active',
  apply_key_available: 'Available Keys',
  apply_key_value: 'Key Value',
  apply_key_saved_as: 'Saved as: {name}',
  apply_key_fetching: 'Fetching full key...',
  apply_key_loaded: 'Key loaded.',
  apply_key_fetch_failed: 'Fetch failed — paste it below.',
  apply_key_select_first: 'Select a key first — wait for it to load, or paste one below.',
  apply_key_saving: 'Saving {name}...',
  apply_key_invalid: 'Invalid selection',
  apply_key_updated: 'Key updated: {name}',
  apply_key_added: 'Key added: {name}',
  btn_skip: 'Skip',
  btn_apply_selected: 'Apply Selected',
  default_name: 'Default',
  toast_logout_removed: 'Logged out and removed: {user}',
  toast_logout_failed: 'Logout failed',
  remove_confirm: 'Logout and remove platform user "{user}"? This will unlink the account from all keys.',

  // No-plan card
  no_plan_indef_free: 'Indefinitely Free:',
  no_plan_indef_free_body: 'The proprietary baseline models — such as Agnes-2.0-Flash — are free to use without a time trial or credit card.',
  no_plan_rate_limits: 'Rate Limits:',
  no_plan_rate_body: 'Free tier: 8 RPM (Request Per Minute). Paid plans have a 5-hour request limit:',
  no_plan_starter: 'Starter: 1,500 / 5h',
  no_plan_plus: 'Plus: 7,500 / 5h',
  no_plan_pro: 'Pro: 30,000 / 5h',
  no_plan_consider: 'Consider subscribing to keep the service up and available for everyone if you like it.',
  no_plan_view_plans: 'View Plans & Pricing',
  no_plan_logged_in_body: "You're logged in but don't have an active subscription. The free tier provides access to all models, but with a RPM (Request Per Minute) limit of 8.",
  no_plan_subscribe_text: 'Subscribe for higher rate limits and premium models.',
  btn_logout: 'Logout',
  no_plan_login_body: 'Log in to your Agnes AI account to see subscription details, usage stats, and manage your plan.',
  btn_login_to_platform: 'Login to Platform',
  no_plan_no_account: "Don't have an account?",

  // Translating overlay
  overlay_translating: 'Translating',
  overlay_translating_sub: 'Translating UI to {lang}...',
  autotranslate_label: 'autotranslate (beta)',

  // Model display names (used in test chat selector)
  model_name_agnes_2: 'Agnes 2.0 Flash',
  model_name_agnes_1_5: 'Agnes 1.5 Flash',
  capability_reasoning: 'reasoning',
  capability_tools: 'tools',
  capability_vision: 'vision',
  cap_ctx: '{n}K ctx',

  // Misc dynamic
  refreshes_in: 'Refreshes in {time}',
  duration_left: '{d}d {h}h {m}m left',
  http_prefix: 'HTTP',
  loading_keys_from_platform: 'Loading keys from platform...',
  no_response_fallback: '(no response)',
  request_failed: 'request failed',

  // Failed login
  failed_prefix: 'Failed:',
  unknown_error: 'unknown',

  // Additional toast / status strings
  toast_api_key_validated: 'API key validated',
  toast_api_key_probe_failed: 'API key probe failed',
  toast_api_key_probe_error: 'API key probe error',
  toast_login_first_retrieve: 'Login to platform first to retrieve tokens',
  toast_translation_failed: 'Translation failed: {error}',
  key_title_edit: 'Edit',
  key_title_delete: 'Delete',
  key_status_active: 'Active',
  key_status_inactive: 'Inactive',
  key_status_none: 'None',
  key_status_unknown: 'Unknown',
  key_status_checking: 'Checking…',
  connection_failed: 'Connection failed',
};

function resolveForcedLocale() {
  if (config?.localOverwrite) return config.localOverwrite;
  if (config?.testMode) return 'de';
  return null;
}

function getI18nCachePath(locale) {
  return path.join(__dirname, '.cache', 'i18n', `${locale}.json`);
}

function loadI18nCache(locale) {
  const fp = getI18nCachePath(locale);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return null; }
}

function saveI18nCache(locale, data) {
  const fp = getI18nCachePath(locale);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function splitI18nForBatch(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function parseI18nBatchResponse(text, expectedKeys) {
  const result = {};
  const lines = text.split(/\r?\n/);
  const byIdx = new Map();
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf('|');
    if (sepIdx <= 0) continue;
    const numStr = trimmed.slice(0, sepIdx).replace(/[^0-9]/g, '');
    if (!numStr) continue;
    const idx = parseInt(numStr, 10);
    if (Number.isNaN(idx) || idx < 1) continue;
    let value = trimmed.slice(sepIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value) byIdx.set(idx, value);
  }
  for (let i = 0; i < expectedKeys.length; i++) {
    const key = expectedKeys[i];
    const idx = i + 1;
    if (byIdx.has(idx)) result[key] = byIdx.get(idx);
    else result[key] = I18N_STRINGS[key];
  }
  return result;
}

async function callAgnesTranslate(promptText) {
  if (!config?.apiKey) throw new Error('no api key configured for translation');
  const requestURL = `${config.upstreamBaseURL || AGNES_API_BASE}/v1/chat/completions`;
  const body = {
    model: 'agnes-2.0-flash',
    messages: [
      { role: 'system', content: 'You are a precise UI translator. Translate each numbered line into the requested target language. Preserve placeholders like {model}, {name}, {time}, {user}, {email}, {n}, {d}, {h}, {m} exactly. Keep short labels concise. Output one translation per line in the format NUMBER|TRANSLATION and nothing else.' },
      { role: 'user', content: promptText },
    ],
    temperature: 0.2,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(requestURL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': AGNES_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`upstream ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new Error('no translation content returned');
    return content;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function buildTranslatePrompt(locale, entries) {
  const lines = entries.map(([key, value], i) => `${i + 1}|${value}`).join('\n');
  return `You are translating UI strings of a software dashboard to ${locale}.

For each numbered line, output the translation in EXACTLY this format:
NUMBER|TRANSLATION

Rules:
- Keep ALL placeholders exactly as written: {model}, {name}, {time}, {user}, {email}, {n}, {d}, {h}, {m}, {lang}
- Keep product names (Agnes, Opencode), technical terms (API, URL, HTTP, RPM, KB, KB ctx, Free Plan, Free Access) untranslated where idiomatic
- Keep short labels concise (button labels = 1-2 words in target language)
- Preserve capitalization style of the source
- Do NOT add numbering, commentary, or extra lines
- Output one line per input line, in the same order, from 1 to ${entries.length}
- Translate ALL ${entries.length} lines, even if some are similar

Input:\n${lines}`;
}

const I18N_TRANSLATE_MAX_RETRIES = 3;
const I18N_TRANSLATE_RETRY_DELAY_MS = 5000;

function isRetryableTranslateError(err) {
  const msg = err?.message || String(err);
  if (/upstream 5\d\d/i.test(msg)) return true;
  if (/upstream 429/i.test(msg)) return true;
  if (/fetch failed|aborted|network|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  return false;
}

async function callAgnesTranslateWithRetry(promptText) {
  let lastErr;
  for (let attempt = 1; attempt <= I18N_TRANSLATE_MAX_RETRIES; attempt++) {
    try {
      return await callAgnesTranslate(promptText);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (!isRetryableTranslateError(e) || attempt === I18N_TRANSLATE_MAX_RETRIES) throw e;
      const delay = I18N_TRANSLATE_RETRY_DELAY_MS * attempt;
      console.log(`[i18n] Translate attempt ${attempt}/${I18N_TRANSLATE_MAX_RETRIES} failed (${msg.slice(0, 160)}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function translateCatalogForLocale(locale) {
  const entries = Object.entries(I18N_STRINGS);
  const BATCH_SIZE = 100;
  const batches = splitI18nForBatch(entries, BATCH_SIZE);
  const merged = {};
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const promptText = buildTranslatePrompt(locale, batch);
    const expectedKeys = batch.map(([k]) => k);
    const respText = await callAgnesTranslateWithRetry(promptText);
    const parsed = parseI18nBatchResponse(respText, expectedKeys);
    Object.assign(merged, parsed);
    console.log(`[i18n] Translated batch ${b + 1}/${batches.length} for ${locale} (${batch.length} strings)`);
  }
  const result = { locale, generated_at: new Date().toISOString(), source: 'agnes-2.0-flash', strings: merged };
  return result;
}

async function ensureI18nForLocale(locale) {
  if (!locale) return null;
  const cached = loadI18nCache(locale);
  if (cached) return cached;
  if (!config?.apiKey) return null;
  console.log(`[i18n] Generating translations for locale=${locale}...`);
  try {
    const result = await translateCatalogForLocale(locale);
    saveI18nCache(locale, result);
    console.log(`[i18n] Cached ${Object.keys(result.strings).length} strings for ${locale}`);
    return result;
  } catch (e) {
    console.error(`[i18n] Translation failed for ${locale}: ${e.message}`);
    return null;
  }
}

function buildI18nBundle(locale) {
  if (!locale || locale === 'en') {
    return { locale: 'en', source: 'builtin', generated_at: null, strings: I18N_STRINGS };
  }
  const cached = loadI18nCache(locale);
  if (cached) return cached;
  return { locale, source: 'pending', generated_at: null, strings: I18N_STRINGS };
}

function buildI18nConfig() {
  const forced = resolveForcedLocale();
  return {
    forced_locale: forced,
    test_mode: !!config?.testMode,
    local_overwrite: config?.localOverwrite || null,
    reason: forced ? (config?.localOverwrite ? 'local_overwrite' : 'test_mode') : 'browser',
  };
}

async function handleI18nGet(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('config') === '1') {
    writeJSON(res, 200, buildI18nConfig());
    return;
  }
  const forced = resolveForcedLocale();
  const queryLocale = url.searchParams.get('locale');
  const localeRaw = queryLocale || forced || 'en';
  const locale = String(localeRaw).toLowerCase().split(/[-_]/)[0].slice(0, 8) || 'en';
  const bundle = url.searchParams.get('generate') === '1' && locale !== 'en'
    ? ((await ensureI18nForLocale(locale)) || buildI18nBundle(locale))
    : buildI18nBundle(locale);
  writeJSON(res, 200, { ...bundle, forced_locale: forced, test_mode: !!config?.testMode, local_overwrite: config?.localOverwrite || null });
}

async function prefetchI18nOnStartup() {
  const forced = resolveForcedLocale();
  if (!forced) {
    console.log('[i18n] No forced locale (test_mode off, no local_overwrite), skipping prefetch');
    return;
  }
  if (!config?.apiKey) {
    console.log('[i18n] No API key, skipping translation prefetch');
    return;
  }
  try {
    const result = await ensureI18nForLocale(forced);
    if (result) console.log(`[i18n] Startup translations ready for ${forced} (${Object.keys(result.strings).length} strings)`);
  } catch (e) {
    console.error(`[i18n] Startup prefetch failed: ${e.message}`);
  }
}

const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;

function fingerprintPayload(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return null;
  const text = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
  let idx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (idx < 0) idx = msgs.findIndex(m => m.role === 'user');
  if (idx < 0) return null;
  const raw = text(msgs[idx]);
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, '');
  return crypto.createHash('md5').update(stripped).digest('hex').slice(0, 12);
}

function detectSessionSignal(payload) {
  const keys = config.keys || [];
  if (keys.length < 1) return null;

  const fingerprint = fingerprintPayload(payload);
  if (!fingerprint) return null;

  const entry = conversationMap.get(fingerprint);
  if (entry !== undefined) {
    entry.requestCount++;
    if (entry.tokenIndex !== currentTokenIndex) {
      currentTokenIndex = entry.tokenIndex;
      config.apiKey = keys[currentTokenIndex].key;
      if (upstream) upstream.apiKey = keys[currentTokenIndex].key;
    }
    return entry;
  }

  if (keys.length > 1) {
    currentTokenIndex = (currentTokenIndex + 1) % keys.length;
    config.apiKey = keys[currentTokenIndex].key;
    if (upstream) upstream.apiKey = keys[currentTokenIndex].key;
  }
  const newEntry = { tokenIndex: currentTokenIndex, requestCount: 1, sessNum: ++globalSessionCounter };
  conversationMap.set(fingerprint, newEntry);

  const msgs = payload.messages;
  const text = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
  let stampIdx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (stampIdx < 0) stampIdx = msgs.findIndex(m => m.role === 'user');
  const m = msgs[stampIdx];
  const curIdx = currentTokenIndex;
  const label = `${keys[curIdx].name}|sess${newEntry.sessNum}`;
  const setter = (c) => { if (typeof c === 'string') return `[${label}] ${c}`; if (Array.isArray(c)) { const b = c.find(p => p?.type === 'text'); if (b) b.text = `[${label}] ${b.text}`; } return c; };
  m.content = setter(m.content);
  return newEntry;
}


// --- Upstream Client ---
class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
    this.apiKey = cfg.apiKey;
  }

  headers(stream = false) {
    const base = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': AGNES_USER_AGENT,
    };
    if (platformSession.token) {
      base['Cookie'] = `token=${platformSession.token}`;
    }
    return base;
  }

  async getUserInfo() {
    const requestURL = `${this.baseURL}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(requestURL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'User-Agent': AGNES_USER_AGENT },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async chatCompletions(body) {
    const requestURL = `${this.baseURL}/v1/chat/completions`;
    const isStream = body && body.stream === true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: this.headers(isStream),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: resp.body };
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async getAccountInfo() { return null; }

  async getPlanStatus() { return null; }

  async getPlanStatus() { return null; }
}

// --- Platform Login ---
async function loginToPlatform(username, password) {
  const loginURL = `${PLATFORM_BASE_URL}/api/user/login`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(loginURL, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: {
        'Content-Type': 'application/json',
        'X-User-Language': 'en',
        'User-Agent': AGNES_USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (resp.status !== 200 || data.code !== 200 || !data.data?.access_token) {
      throw new Error(data.message || `Login failed: HTTP ${resp.status}`);
    }
    const { access_token, user } = data.data;
    const prevToken = platformSession.token;
    const prevUser = platformSession.user?.email;
    platformSession = {
      token: access_token,
      user: user || null,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    // Save to platformUsers array
    const existingIdx = config.platformUsers.findIndex(u => u.username === username);
    const puEntry = { username, password, token: access_token, user: user || null };
    if (existingIdx >= 0) {
      config.platformUsers[existingIdx] = puEntry;
    } else {
      config.platformUsers.push(puEntry);
    }
    // Also set platformUser on the token that matches this username
    for (const t of config.keys) {
      if (t.platformUser === username) break;
    }
    saveConfig(config);
    notifyConfigChange();
    if (prevToken !== access_token || prevUser !== (user?.email)) {
      console.log(`[Platform] Login successful for ${username}`);
    }
    return { success: true, token: access_token, user };
  } catch (e) {
    clearTimeout(timer);
    console.error(`[Platform] Login failed: ${e.message}`);
    return { success: false, message: e.message };
  }
}

function getPlatformHeaders() {
  if (!platformSession.token) return {};
  return {
    'Cookie': `token=${platformSession.token}`,
    'Authorization': `Bearer ${platformSession.token}`,
    'User-Agent': AGNES_USER_AGENT,
  };
}

async function platformGetUserInfo() {
  if (!platformSession.token) return null;
  const url = `${PLATFORM_BASE_URL}/api/user/self`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: getPlatformHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function platformGetUserKeys() {
  if (!platformSession.token) { console.log('[Platform] No session token, skipping key fetch'); return null; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${PLATFORM_BASE_URL}/api/token`, {
      method: 'GET',
      headers: { ...getPlatformHeaders(), 'x-user-language': 'en' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await resp.json();
    console.log('[Platform] /api/token response:', JSON.stringify(body).substring(0, 300));
    if (body.code !== 200 || !body.data?.items) { console.log('[Platform] No items in response'); return null; }
    return body.data.items.map((k, i) => ({
      id: k.id,
      name: k.name || `Key ${i + 1}`,
      preview: k.key_preview || '',
      plan_name: k.key_profile || 'Default',
      status: k.status === 1 ? 'active' : 'inactive',
      full_key: '',
    }));
  } catch (e) { console.error('[Platform] Key fetch failed:', e.message); return null; }
}

async function platformGetTokenKey(tokenId) {
  if (!platformSession.token) return null;
  // Try regular endpoint first, then fall back to premium reveal endpoint
  for (const url of [
    `${PLATFORM_BASE_URL}/api/token/${tokenId}/key`,
    `${PLATFORM_BASE_URL}/api/user/subscription/key/reveal`,
  ]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...getPlatformHeaders(), 'Content-Type': 'application/json' },
        body: null,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const body = await resp.json();
      if (body.code === 200 && body.data?.key) return body.data.key;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function platformGetSubscriptionPlanName() {
  if (!platformSession.token) return 'Default';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${PLATFORM_BASE_URL}/api/user/subscription`, {
      headers: getPlatformHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return 'Default';
    const data = await resp.json();
    const sub = data?.data || (Array.isArray(data) ? data[0] : null);
    return sub?.plan_name || 'Default';
  } catch (e) { return 'Default'; }
}

// --- Model Registry ---
const AGNES_MODELS = [
  'agnes-2.0-flash',
  'agnes-1.5-flash',
  'agnes-image-2.0-flash',
  'agnes-image-2.1-flash',
  'agnes-video-v2.0',
];

// --- Dynamic model fetch from upstream ---
async function fetchRemoteModels() {
  try {
    const now = Date.now();
    if (dynamicModels && (now - dynamicModelsTime) < DYNAMIC_MODELS_TTL) {
      return dynamicModels;
    }

    const apiKey = config?.apiKey || config?.keys?.[0]?.key || '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(AGNES_MODELS_URL, {
      method: 'GET',
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': AGNES_USER_AGENT } : { 'User-Agent': AGNES_USER_AGENT },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.data && Array.isArray(data.data)) {
      dynamicModels = data.data.map(m => m.id);
      dynamicModelsTime = now;
      console.log(`[Models] Fetched ${dynamicModels.length} models from Agnes AI`);
      modelsCache = null;

      if (config && (!Array.isArray(config.enabledModels) || config.enabledModels.length === 0)) {
        config.enabledModels = [...dynamicModels];
      }

      return dynamicModels;
    }

    throw new Error('Invalid models response format');
  } catch (e) {
    console.warn(`[Models] Dynamic fetch failed: ${e.message}. Using hardcoded fallback.`);
    dynamicModels = [...AGNES_MODELS];
    dynamicModelsTime = Date.now();
    return dynamicModels;
  }
}

// --- Utility ---
function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return cloneMap(v);
    if (Array.isArray(v)) return cloneSlice(v);
    return v;
  });
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneMap(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

async function readBodyWithDecompress(body, contentEncoding) {
  const raw = await readBodyBody(body);
  if (!contentEncoding || contentEncoding === 'identity') return raw;
  if (contentEncoding === 'br') {
    try { return zlib.brotliDecompressSync(raw); } catch { return raw; }
  }
  if (contentEncoding === 'gzip') {
    try { return zlib.gunzipSync(raw); } catch { return raw; }
  }
  if (contentEncoding === 'deflate') {
    try { return zlib.inflateSync(raw); } catch { return raw; }
  }
  return raw;
}

function readBodyBody(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks)));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks)); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    })();
  }
  return Buffer.from(String(body));
}

function pipeBodyToResponse(body, res) {
  let closed = false;
  const onClose = () => { closed = true; };
  res.on('close', onClose);

  function safeWrite(chunk) {
    if (!closed) {
      try { res.write(chunk); } catch (e) { closed = true; }
    }
  }

  function safeEnd() {
    if (!closed) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
  }

  if (isNodeStream(body)) {
    return new Promise((resolve) => {
      body.on('data', chunk => safeWrite(chunk));
      body.on('end', () => { safeEnd(); resolve(); });
      body.on('error', () => { safeEnd(); resolve(); });
    });
  }
  return new Promise((resolve) => {
    const reader = body.getReader();
    function pump() {
      if (closed) { resolve(); return; }
      reader.read().then(({ done, value }) => {
        if (closed) { resolve(); return; }
        if (done) { safeEnd(); resolve(); return; }
        safeWrite(value);
        pump();
      }).catch(() => { safeEnd(); resolve(); });
    }
    pump();
  });
}

// --- HTTP Handlers ---
function authorized(req) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function readBody(req) {
  if (req._body !== undefined) return Promise.resolve(req._body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

let accountCache = { data: null, time: 0 };
const ACCOUNT_CACHE_TTL = 60000;

async function getAccountInfo() {
  return null;
}

async function handleAccountInfo(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const users = (config.platformUsers || []).map(u => ({
    username: u.username,
    email: u.user?.email || '',
    is_active: u.user?.is_active,
    token_valid: !!u.token,
    last_login: u.user?.last_login || '',
    created_at: u.user?.created_at || '',
  }));
  writeJSON(res, 200, {
    logged_in: !!platformSession.token,
    user: platformSession.user || null,
    platform_users: users,
  });
  return;
}

function hasApiToken() {
  const keys = config.keys || [];
  return keys.length > 0 && keys.some(t => t.key);
}

async function handlePlanStatus(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  if (config.testMode) {
    const planData = {
      has_plan: true,
      logged_in: true,
      plan_status: 'active',
      subscription: {
        name: 'Test',
        billing_cycle: 'monthly',
        status: 'active',
        payment_method: 'card',
        key_preview: 'test-xxxx',
        key_status: 'active',
        current_period_start: new Date(Date.now() - 30 * 86400000).toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
      subscription_features: {
        tps_normal: 60,
        tps_offpeak: 120,
        usage_multiplier: 1,
        claw_agents: true,
        image_gen: false,
        video_gen: true,
        tools: true,
        mcp: [],
      },
      windowed: { used: 50, limit: 1000, usage_pct: 5, reset_at: new Date(Date.now() + 5 * 3600000).toISOString(), reset_in_seconds: 18000 },
      weekly: { used: 200, limit: 10000, usage_pct: 2, reset_at: new Date(Date.now() + 7 * 86400000).toISOString(), reset_in_seconds: 604800 },
      image_daily: { used: 10, limit: 100, usage_pct: 10, reset_at: new Date(Date.now() + 24 * 3600000).toISOString(), reset_in_seconds: 86400 },
    };
    globalThis._lastPlanData = planData;
    writeJSON(res, 200, planData);
    return;
  }
  if (!platformSession.token) {
    globalThis._lastPlanData = { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: false };
    writeJSON(res, 200, globalThis._lastPlanData);
    return;
  }
  try {
    const resp = await fetch(`${PLATFORM_BASE_URL}/api/user/subscription`, {
      headers: getPlatformHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const sub = data.data || (Array.isArray(data) ? data[0] : null);
    if (!sub) { globalThis._lastPlanData = { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: true }; writeJSON(res, 200, globalThis._lastPlanData); return; }
    const statusMap = { active: 'active', pending: 'pending', expired: 'expired', cancelled: 'cancelled' };
    const textGen = sub.usage?.text_generation;
    const windowed = textGen?.windowed || {};
    const weekly = textGen?.weekly || {};
    const daily = textGen?.daily || {};
    const imgGen = sub.usage?.image_generation;
    const imgDaily = imgGen?.daily || {};
    const subFeatures = sub.features || {};
    const planData = {
      has_plan: true,
      logged_in: true,
      plan_status: statusMap[sub.status] || 'unknown',
      username: platformSession.user?.username || platformSession.user?.email || null,
      subscription: {
        name: sub.plan_name,
        billing_cycle: sub.billing_cycle,
        status: sub.status,
        payment_method: sub.payment_method,
        key_preview: sub.key_preview,
        key_status: sub.key_status,
        current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end,
      },
      subscription_features: {
        tps_normal: subFeatures.tps_normal,
        tps_offpeak: subFeatures.tps_offpeak,
        usage_multiplier: subFeatures.usage_multiplier,
        claw_agents: subFeatures.claw_agents,
        image_gen: subFeatures.image_gen,
        video_gen: subFeatures.video_gen,
        tools: subFeatures.tools,
        mcp: subFeatures.mcp || [],
      },
      windowed: { used: windowed.used, limit: windowed.limit, usage_pct: windowed.usage_pct, reset_at: windowed.reset_at, reset_in_seconds: windowed.reset_in_seconds },
      weekly: { used: weekly.used, limit: weekly.limit, usage_pct: weekly.usage_pct, reset_at: weekly.reset_at, reset_in_seconds: weekly.reset_in_seconds },
      image_daily: { used: imgDaily.used, limit: imgDaily.limit, usage_pct: imgDaily.usage_pct, reset_at: imgDaily.reset_at, reset_in_seconds: imgDaily.reset_in_seconds },
    };
    globalThis._lastPlanData = planData;
    writeJSON(res, 200, planData);
  } catch (e) {
    globalThis._lastPlanData = { has_plan: false, plan_status: 'error', error: e.message, subscriptions: [], logged_in: true };
    writeJSON(res, 200, globalThis._lastPlanData);
  }
}

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let modelsData = null;
  try { modelsData = await upstream.getUserInfo(); }
  catch (e) { /* ignore */ }
  const tokenState = (config.keys || []).filter(t => t && t.key).map(t => {
    const maskedToken = t.key ? t.key.substring(0, 10) + '...' + t.key.substring(t.key.length - 4) : '';
    return {
      name: t.name || 'Unnamed Key',
      key: maskedToken,
      has_key: !!t.key,
      status: t.key ? (modelsData ? 'active' : 'unknown') : 'none',
    };
  });
  writeJSON(res, 200, {
    ok: true,
    test_mode: config.testMode,
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    api_key_valid: !!modelsData,
    token_state: tokenState,
    valid_tokens: tokenState.filter(t => t.status !== 'none').length,
    models_count: AGNES_MODELS.length,
    runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
    cache: { ...responseCache.stats, enabled: config.cacheEnabled },
    i18n: {
      forced_locale: resolveForcedLocale(),
      test_mode: !!config.testMode,
      local_overwrite: config.localOverwrite || null,
    },
    platform: {
      logged_in: !!platformSession.token,
      user: platformSession.user?.email || null,
      users: (config.platformUsers || []).map(u => ({
        username: u.username,
        logged_in: !!u.token,
        email: u.user?.email || null,
      })),
    },
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }

  const models = config?.enabledModels || (dynamicModels && dynamicModels.length > 0 ? dynamicModels : AGNES_MODELS);

  if (!modelsCache) {
    const created = Math.floor(startTime.getTime() / 1000);
    modelsCache = JSON.stringify({
      object: 'list',
      data: models.map(m => ({
        id: m,
        object: 'model',
        created,
        owned_by: 'stepai',
        root: m,
        permission: []
      }))
    });
  }
  try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(modelsCache); }
  catch (e) { writeJSON(res, 500, { error: { message: 'encode failed', type: 'server_error' } }); }
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = remapModel((payload.model || '').trim());
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }
  payload.model = requestedModel;
  await proxyChatRequest(res, payload, requestedModel);
}

function isImageOrVideoModel(modelId) {
  return /image|video/i.test(modelId || '');
}

function calcNumFrames(durationSeconds, frameRate = 24) {
  const target = Math.round(durationSeconds * frameRate);
  const n = Math.max(1, Math.round((target - 1) / 8));
  return Math.min(8 * n + 1, 441);
}

function extractImageUrls(msg) {
  if (!msg) return [];
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p?.type === 'image_url' && p?.image_url?.url)
      .map(p => p.image_url.url);
  }
  return [];
}

async function proxyImageRequest(res, payload, requestedModel) {
  if (!config.apiKey) { writeOpenAIError(res, 503, 'no Agnes AI API key configured', 'server_error', 'no_api_key'); return; }
  const msgs = payload.messages || [];
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string'
    ? lastUser.content.replace(/^\[[^\]]+\]\s*/, '')
    : (Array.isArray(lastUser?.content) ? (lastUser.content.find(p => p?.type === 'text')?.text || '') : '');
  const imageUrls = extractImageUrls(lastUser);
  const isVideo = /video/i.test(requestedModel);
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  console.log(`${ts} [${isVideo ? 'Video' : 'Image'}]-[${requestedModel}]-${JSON.stringify(prompt.substring(0, 80))}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeout);
  try {
    const endpoint = isVideo
      ? `${config.upstreamBaseURL}/v1/videos`
      : `${config.upstreamBaseURL}/v1/images/generations`;
    const imageModel = /image/i.test(requestedModel)
      ? (imageUrls.length > 1 ? 'agnes-image-2.0-flash' : 'agnes-image-2.1-flash')
      : requestedModel;
    const durationMatch = prompt.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
    const videoDuration = durationMatch ? parseFloat(durationMatch[1]) : 5;
    const frameRate = 24;
    const numFrames = calcNumFrames(videoDuration, frameRate);
    let reqBody;
    if (isVideo) {
      reqBody = { model: requestedModel, prompt, width: 1280, height: 768, num_frames: numFrames, frame_rate: frameRate };
      if (imageUrls.length === 1) {
        reqBody.image = imageUrls[0];
      } else if (imageUrls.length > 1) {
        reqBody.extra_body = { image: imageUrls };
      }
    } else {
      reqBody = { model: imageModel, prompt, n: 1, size: '1024x1024' };
      if (imageUrls.length > 0) {
        reqBody.extra_body = { image: imageUrls, response_format: 'url' };
      }
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': AGNES_USER_AGENT,
      },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { const errText = await resp.text(); writePassthroughError(res, resp.status, errText); return; }
    const data = await resp.json();

    let content = 'Generation completed but no output returned.';

    if (isVideo) {
      const taskId = data.task_id || data.id;
      if (taskId) {
        console.log(`[Video] Task ${taskId} queued (~${(numFrames / frameRate).toFixed(1)}s video), polling...`);
        const pollInterval = 12000;
        let queuedSince = 0;
        let lastProgress = -1;
        let lastLoggedPct = -1;
        let videoUrl = null;
        while (true) {
          await new Promise(r => setTimeout(r, pollInterval));
          try {
            const pollResp = await fetch(`${config.upstreamBaseURL}/v1/videos/${taskId}`, {
              headers: { 'Authorization': `Bearer ${config.apiKey}`, 'User-Agent': AGNES_USER_AGENT },
              signal: AbortSignal.timeout(30000),
            });
            if (!pollResp.ok) continue;
            const pollData = await pollResp.json();
            const s = pollData.status || 'unknown';
            const p = typeof pollData.progress === 'number' ? pollData.progress : -1;
            if (p !== lastLoggedPct) { console.log(`[Video] Status: ${s} progress: ${p === -1 ? '?' : p}`); lastLoggedPct = p; }
            if (p !== lastProgress && p >= 0) { lastProgress = p; }
            if (s === 'completed' || s === 'succeeded') {
              videoUrl = pollData.video_url || pollData.remixed_from_video_id || pollData.url || pollData.output?.url || pollData.result?.url || pollData.download_url || pollData.public_url || pollData.uri || pollData.output?.video_url || pollData.result?.video_url || (Array.isArray(pollData.files) && pollData.files[0]?.url) || (Array.isArray(pollData.data) && pollData.data[0]?.url);
              break;
            }
            if (s === 'failed' || s === 'error') {
              content = `Video generation failed: ${pollData.error || pollData.message || 'unknown error'}`;
              break;
            }
            if (s === 'queued') {
              if (queuedSince === 0) queuedSince = Date.now();
              else if (Date.now() - queuedSince > 30000) {
                content = `Video stuck in queue — likely requires a paid plan (video_gen feature). Task ID: ${taskId}`;
                break;
              }
            } else {
              queuedSince = 0;
            }
          } catch (e) { /* retry */ }
        }
        if (videoUrl) content = `Video generated successfully!\n\nOpen this URL in your browser:\n${videoUrl}`;
        else if (content === 'Generation completed but no output returned.') content = `Video timed out. Task ID: ${taskId}`;
      }
    } else {
      const item = data.data?.[0];
      if (item?.url) content = `Image generated successfully!\n\nOpen this URL in your browser:\n${item.url}`;
      else if (item?.b64_json) content = `![Generated image](data:image/jpeg;base64,${item.b64_json})`;
    }

    const id = 'imgcmpl-' + Date.now();
    const created = Math.floor(Date.now() / 1000);
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      writeJSON(res, 200, { id, object: 'chat.completion', created, model: requestedModel, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    }
    console.log(`${ts} [${isVideo ? 'Video' : 'Image'}]-[${requestedModel}]-done`);
  } catch (e) {
    clearTimeout(timer);
    writeOpenAIError(res, 502, e.message, 'server_error', '');
  }
}

async function proxyChatRequest(res, payload, requestedModel) {
  const reqStart = Date.now();

  if (isImageOrVideoModel(requestedModel)) {
    detectSessionSignal(payload);
    await proxyImageRequest(res, payload, requestedModel);
    return;
  }

  const session = detectSessionSignal(payload);

  if (!config.apiKey) { writeOpenAIError(res, 503, 'no Agnes AI API key configured', 'server_error', 'no_api_key'); return; }

  const keys = config.keys || [];
  const curIdx = currentTokenIndex;
  const name = curIdx >= 0 && curIdx < keys.length ? keys[curIdx].name : '?';
  const sessNum = session?.sessNum || '?';
  const promptPreview = extractUserPrompt(payload);
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const usedToken = config.apiKey || '';
  const tokenPreview = usedToken ? usedToken.substring(0, 8) + '...' + usedToken.substring(usedToken.length - 4) : 'none';

  // Test mode: return a mock "Test" response instead of calling the real API
  if (config.testMode) {
    const mockResponse = JSON.stringify({
      id: 'test-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Test' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 4, total_tokens: 4 }
    });
    try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(mockResponse); }
    catch (e) { /* ignore */ }
    console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-done:0ms (test mode)`);
    return;
  }

  const cacheEnabled = config.cacheEnabled && !payload.stream;
  let ck;
  if (cacheEnabled) {
    ck = cacheKey(payload, requestedModel);
    const cached = responseCache.get(ck);
    if (cached) {
      console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-cache:HIT`);
      try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(cached); }
      catch (e) { /* ignore */ }
      console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-done:0ms (cached)`);
      return;
    }
  }

  console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-prompt: ${JSON.stringify(promptPreview)}`);

  const cloned = cloneMap(payload);
  cloned.model = requestedModel;
  if (cloned.tools) normalizeToolSchemas(cloned.tools);

  await retryLoop(async ({ isLast }) => {
    let resp;
    try {
      resp = await upstream.chatCompletions(cloned);
    } catch (e) {
      writeOpenAIError(res, 502, e.message, 'server_error', '');
      return { retry: false };
    }

    if (resp.status >= 200 && resp.status < 300) {
      try {
        if (cacheEnabled && ck && !resp.headers['content-type']?.includes('text/event-stream')) {
          const bodyText = (await readBodyWithDecompress(resp.body, resp.headers['content-encoding'])).toString();
          responseCache.set(ck, bodyText);
          const skipHeaders = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
          for (const [key, values] of Object.entries(resp.headers)) {
            if (skipHeaders.has(key.toLowerCase())) continue;
            res.setHeader(key, values);
          }
          res.writeHead(resp.status);
          res.end(bodyText);
        } else {
          const skipHeaders = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
          for (const [key, values] of Object.entries(resp.headers)) {
            if (skipHeaders.has(key.toLowerCase())) continue;
            res.setHeader(key, values);
          }
          try {
            res.writeHead(resp.status);
          } catch (e) {
            console.error(`proxyChatRequest: client disconnected before headers: ${e.message}`);
            return { retry: false };
          }
          try {
            if (resp.headers['content-type']?.includes('text/event-stream')) {
              const bodyText = (await readBodyWithDecompress(resp.body, resp.headers['content-encoding'])).toString();
              res.end(bodyText);
            } else {
              const buffer = (await readBodyWithDecompress(resp.body, resp.headers['content-encoding'])).toString();
              res.end(buffer);
            }
          } catch (e) {
            console.error(`proxyChatRequest: client disconnected during write: ${e.message}`);
          }
        }
      } catch (e) { console.error(`proxy response copy failed: ${e.message}`); return { retry: false }; }
      console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-done:${Date.now() - reqStart}ms`);
      return { retry: false };
    }

    const errorBodyStr = (await readBodyWithDecompress(resp.body, resp.headers['content-encoding'])).toString();
    if (resp.status === 429 || isModelUnavailableError(errorBodyStr) || isQueryEngineError(errorBodyStr) || isDoRequestError(errorBodyStr)) {
      if (isLast) {
        console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}`);
        writePassthroughError(res, resp.status, errorBodyStr);
        return { retry: false };
      }
      let reason = 'unavailable';
      if (resp.status === 429) reason = 'rate_limited';
      else if (isQueryEngineError(errorBodyStr)) reason = 'query_engine';
      else if (isDoRequestError(errorBodyStr)) reason = 'do_request_failed';
      console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-retry:${reason}`);
      return { retry: true };
    }
    console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}`);
    writePassthroughError(res, resp.status, errorBodyStr);
    return { retry: false };
  });
}

function isModelUnavailableError(body) {
  const re = /this model is currently (unavaliable|unavailable)/i;
  return re.test(body);
}

function isQueryEngineError(body) {
  return /not connected to the query engine/i.test(body);
}

function isDoRequestError(body) {
  return /do request failed|do_request_failed/i.test(body);
}

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

async function retryLoop(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await fn({ attempt, isLast: attempt === MAX_RETRIES });
    if (!result.retry) return result;
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

// --- Token Validation ---
async function validateApiKey() {
  if (!config.apiKey) { console.log('No API key configured'); return false; }
  try {
    const data = await upstream.getUserInfo();
    console.log('API key valid');
    return true;
  } catch (e) {
    console.error(`API key validation failed: ${e.message}`);
    return false;
  }
}

// --- AI Wallpaper Generation ---
let _genProgress = { kind: null, progress: 0 };

// WebSocket server (ws library, on same HTTP server)
const WS_PATH = '/ws';
let _wss = null;
let _wsClients = new Set();

function initWSServer(server) {
  if (_wss) return _wss;
  _wss = new WebSocketServer({ server, path: WS_PATH });
  _wss.on('connection', (ws) => {
    _wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'health', data: getHealthPayload() }));
    ws.send(JSON.stringify({ type: 'plan', data: currentPlanPayload() }));
    ws.send(JSON.stringify({ type: 'progress', data: _genProgress }));
    _startWSTimers();
    ws.on('message', (raw) => {
      try { const msg = JSON.parse(raw.toString()); handleWSMessage(ws, msg); } catch {}
    });
    ws.on('close', () => { _wsClients.delete(ws); _startWSTimers(); });
    ws.on('error', () => { _wsClients.delete(ws); _startWSTimers(); });
  });
  return _wss;
}

function wsSendAll(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const ws of _wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

globalThis._lastPlanData = null;

function currentPlanPayload() {
  if (globalThis._lastPlanData) return globalThis._lastPlanData;
  return { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: false };
}

function getHealthPayload() {
  const tokenState = (config.keys || []).filter(t => t && t.key).map(t => {
    const maskedToken = t.key ? t.key.substring(0, 10) + '...' + t.key.substring(t.key.length - 4) : '';
    return { name: t.name || 'Unnamed Key', key: maskedToken, has_key: !!t.key, status: t.key ? 'active' : 'none' };
  });
  return {
    ok: true, test_mode: config.testMode, started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    api_key_valid: true, token_state: tokenState,
    valid_tokens: tokenState.filter(t => t.status !== 'none').length,
    models_count: AGNES_MODELS.length, runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
    cache: { size: responseCache._map.size, maxSize: responseCache.maxSize, ttlMs: responseCache.ttlMs, hits: responseCache.hits, misses: responseCache.misses, evictions: responseCache.evictions, enabled: config.cacheEnabled },
    platform: {
      logged_in: !!platformSession.token,
      user: platformSession.user ? (platformSession.user.email || null) : null,
      users: (config.platformUsers || []).map(u => ({ username: u.username, logged_in: !!u.token, email: (u.user && u.user.email) || null }))
    }
  };
}

function broadcastProgress() {
  wsSendAll({ type: 'progress', data: _genProgress });
}
function setGenProgress(kind, progress) { _genProgress = { kind, progress }; broadcastProgress(); }

let _healthTimer = null;
let _planTimer = null;

function _broadcastHealth() {
  wsSendAll({ type: 'health', data: getHealthPayload() });
}

function _broadcastPlan() {
  if (config.testMode) {
    const d = {
      has_plan: true, logged_in: true, plan_status: 'active',
      subscription: { name: 'Test', billing_cycle: 'monthly', status: 'active', payment_method: 'card', key_preview: 'test-xxxx', key_status: 'active', current_period_start: new Date(Date.now() - 30 * 86400000).toISOString(), current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() },
      subscription_features: { tps_normal: 60, tps_offpeak: 120, usage_multiplier: 1, claw_agents: true, image_gen: false, video_gen: true, tools: true, mcp: [] },
      windowed: { used: 50, limit: 1000, usage_pct: 5, reset_at: new Date(Date.now() + 5 * 3600000).toISOString(), reset_in_seconds: 18000 },
      weekly: { used: 200, limit: 10000, usage_pct: 2, reset_at: new Date(Date.now() + 7 * 86400000).toISOString(), reset_in_seconds: 604800 },
      image_daily: { used: 10, limit: 100, usage_pct: 10, reset_at: new Date(Date.now() + 24 * 3600000).toISOString(), reset_in_seconds: 86400 },
    };
    globalThis._lastPlanData = d;
    wsSendAll({ type: 'plan', data: d });
    return;
  }
  if (!platformSession.token) {
    globalThis._lastPlanData = { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: false };
    wsSendAll({ type: 'plan', data: globalThis._lastPlanData });
    return;
  }
  fetch(`${PLATFORM_BASE_URL}/api/user/subscription`, { headers: getPlatformHeaders(), signal: AbortSignal.timeout(10000) })
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const sub = data.data || (Array.isArray(data) ? data[0] : null);
      if (!sub) {
        globalThis._lastPlanData = { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: true };
        wsSendAll({ type: 'plan', data: globalThis._lastPlanData });
        return;
      }
      const statusMap = { active: 'active', pending: 'pending', expired: 'expired', cancelled: 'cancelled' };
      const textGen = sub.usage?.text_generation;
      const windowed = textGen?.windowed || {};
      const weekly = textGen?.weekly || {};
      const imgGen = sub.usage?.image_generation;
      const imgDaily = imgGen?.daily || {};
      const subFeatures = sub.features || {};
      globalThis._lastPlanData = {
        has_plan: true, logged_in: true, plan_status: statusMap[sub.status] || 'unknown',
        username: platformSession.user?.username || platformSession.user?.email || null,
        subscription: { name: sub.plan_name, billing_cycle: sub.billing_cycle, status: sub.status, payment_method: sub.payment_method, key_preview: sub.key_preview, key_status: sub.key_status, current_period_start: sub.current_period_start, current_period_end: sub.current_period_end },
        subscription_features: { tps_normal: subFeatures.tps_normal, tps_offpeak: subFeatures.tps_offpeak, usage_multiplier: subFeatures.usage_multiplier, claw_agents: subFeatures.claw_agents, image_gen: subFeatures.image_gen, video_gen: subFeatures.video_gen, tools: subFeatures.tools, mcp: subFeatures.mcp || [] },
        windowed: { used: windowed.used, limit: windowed.limit, usage_pct: windowed.usage_pct, reset_at: windowed.reset_at, reset_in_seconds: windowed.reset_in_seconds },
        weekly: { used: weekly.used, limit: weekly.limit, usage_pct: weekly.usage_pct, reset_at: weekly.reset_at, reset_in_seconds: weekly.reset_in_seconds },
        image_daily: { used: imgDaily.used, limit: imgDaily.limit, usage_pct: imgDaily.usage_pct, reset_at: imgDaily.reset_at, reset_in_seconds: imgDaily.reset_in_seconds },
      };
      wsSendAll({ type: 'plan', data: globalThis._lastPlanData });
    }).catch(() => {
      wsSendAll({ type: 'plan', data: { has_plan: false, plan_status: 'error', error: 'fetch failed', subscriptions: [], logged_in: true }});
    });
}

function _startWSTimers() {
  if (_healthTimer) clearInterval(_healthTimer);
  if (_planTimer) clearInterval(_planTimer);
  _healthTimer = setInterval(() => _broadcastHealth(), 15000);
  _planTimer = setInterval(() => _broadcastPlan(), 30000);
}

function notifyConfigChange() {
  wsSendAll({ type: 'config_change' });
}

async function handleWSMessage(ws, msg) {
  if (msg.type === 'rpc') {
    const fakeRes = new FakeResponse();
    let resolved = false;
    fakeRes._onEnd = () => {
      if (resolved) return;
      resolved = true;
      const body = fakeRes._body ? fakeRes._body.toString('utf8') : '';
      ws.send(JSON.stringify({ type: 'rpc_result', id: msg.id, status: fakeRes.statusCode, body }));
    };
    const fakeReq = {
      method: msg.method || 'GET',
      url: msg.path,
      headers: Object.assign({}, msg.headers || {}),
      _body: msg.body != null ? (typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)) : '',
      on: function() { return fakeReq; },
    };
    try {
      await handleRequest(fakeReq, fakeRes);
    } catch (e) {
      if (!resolved) {
        resolved = true;
        ws.send(JSON.stringify({ type: 'rpc_error', id: msg.id, error: e.message }));
      }
      return;
    }
    if (!resolved) {
      resolved = true;
      ws.send(JSON.stringify({ type: 'rpc_result', id: msg.id, status: 202, body: '{}' }));
    }
  }
}

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this._headers = {};
    this._chunks = [];
  }
  writeHead(code, headers) { this.statusCode = code; if (headers) Object.assign(this._headers, headers); return this; }
  setHeader(key, value) { this._headers[key.toLowerCase()] = value; return this; }
  getHeader(key) { return this._headers[key.toLowerCase()]; }
  headersSent = false;
  write(chunk) { if (chunk != null) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; }
  end(chunk) {
    if (chunk != null) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this._body = Buffer.concat(this._chunks.length ? this._chunks : [Buffer.alloc(0)]);
    if (this._onEnd) this._onEnd();
  }
  on(evt, fn) { if (evt === 'close') this._onClose = fn; return this; }
  once(evt, fn) { if (evt === 'close') this._onClose = fn; return this; }
  removeListener() { return this; }
}
let _aiWallpaperGen = false;
let _aiWallpaperGenPromise = null;
async function generateAiWallpaperToDisk() {
  if (_aiWallpaperGen) {
    console.log('[AI] Background generation already in progress, waiting...');
    return _aiWallpaperGenPromise;
  }
  _aiWallpaperGen = true;
  setGenProgress('image', 0);
  _aiWallpaperGenPromise = (async () => {
    try {
      const cacheDir = path.join(__dirname, '.cache');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const aiFile = path.join(cacheDir, 'ai-paper.jpg');
      const apiKey = config.apiKey || config.keys?.[0]?.key || '';
      if (!apiKey) throw new Error('no API key');
  
      const prompt = config.img_prompt || 'hdr, polar night, vibrant rainbow colors, trees, mountains, glaciers, stars and dark skies';
      const body = JSON.stringify({
        model: 'agnes-image-2.1-flash',
        prompt,
        n: 1,
        size: '1024x768',
        seed: Date.now(),
      });
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': AGNES_USER_AGENT,
      };

      let data = null;
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        let resp;
        try {
          resp = await fetch(`${config.upstreamBaseURL}/v1/images/generations`, {
            method: 'POST', headers, body, signal: controller.signal,
          });
        } catch (e) {
          clearTimeout(timer);
          lastError = e;
          if (attempt < MAX_RETRIES) {
            const delay = RETRY_DELAY_MS * attempt;
            console.log(`[AI] Background generation network error, retry ${attempt}/${MAX_RETRIES - 1} after ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw e;
        }
        clearTimeout(timer);
        if (resp.ok) {
          data = await resp.json();
          lastError = null;
          break;
        }
        const errBody = await resp.text();
        console.error(`[AI] Upstream error ${resp.status}: ${errBody}`);
        const retryable = resp.status === 429
          || isModelUnavailableError(errBody)
          || isQueryEngineError(errBody)
          || isDoRequestError(errBody);
        lastError = new Error(`upstream ${resp.status}: ${errBody}`);
        if (!retryable || attempt === MAX_RETRIES) throw lastError;
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[AI] Background generation retryable error, retry ${attempt}/${MAX_RETRIES - 1} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
      if (!data) throw lastError || new Error('upstream failed');

      let imageUrl = '';
      let b64Data = '';

      if (data.data && Array.isArray(data.data) && data.data[0]) {
        const item = data.data[0];
        if (item.url) imageUrl = item.url;
        else if (item.b64_json) b64Data = item.b64_json;
      }

      if (b64Data) {
        fs.writeFileSync(aiFile, Buffer.from(b64Data, 'base64'));
      } else if (imageUrl) {
        const imgResp = await fetch(imageUrl);
        if (!imgResp.ok) throw new Error(`download ${imgResp.status}`);
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        fs.writeFileSync(aiFile, imgBuf);
      } else {
        throw new Error('no image in response');
      }
      console.log('[AI] Background generation done');
    } catch (e) {
      console.error('[AI] Background generation failed:', e.message);
    } finally {
      setGenProgress('image', 100);
      _aiWallpaperGen = false;
      _aiWallpaperGenPromise = null;
    }
  })();
  return _aiWallpaperGenPromise;
}

// --- AI Video Wallpaper Generation ---
let _aiVideoGen = false;
let _aiVideoGenPromise = null;
async function checkVideoGenFeature() {
  try {
    if (!platformSession.token) return null;
    const resp = await fetch(`${PLATFORM_BASE_URL}/api/user/subscription`, {
      headers: getPlatformHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const sub = data.data || (Array.isArray(data) ? data[0] : null);
    return sub?.features?.video_gen ?? null;
  } catch (e) {
    return null;
  }
}

async function generateAiVideoToDisk() {
  if (_aiVideoGen) {
    console.log('[AI Video] Background generation already in progress, waiting...');
    return _aiVideoGenPromise;
  }
  _aiVideoGen = true;
  setGenProgress('video', 0);
  _aiVideoGenPromise = (async () => {
    try {
      const cacheDir = path.join(__dirname, '.cache');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const vidFile = path.join(cacheDir, 'ai-video.mp4');
      const apiKey = config.apiKey || config.tokens?.[0]?.token || '';
      if (!apiKey) throw new Error('no API key');

      const videoAllowed = await checkVideoGenFeature();
      if (videoAllowed === false) throw new Error('video generation is not available on your plan — upgrade required');
      if (videoAllowed === null) console.log('[AI Video] Could not verify plan — proceeding anyway');

      const prompt = config.video_prompt || 'cinematic slow motion of a vibrant colorful mountain range landscape with drifting clouds, 5 seconds';
      const durationMatch = prompt.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
      const videoDuration = durationMatch ? parseFloat(durationMatch[1]) : 5;
      const frameRate = 24;
      const numFrames = calcNumFrames(videoDuration, frameRate);

      const taskBody = JSON.stringify({
        model: 'agnes-video-v2.0',
        prompt,
        width: 1280,
        height: 768,
        num_frames: numFrames,
        frame_rate: frameRate,
      });
      const taskResp = await retryLoop(async ({ isLast }) => {
        try {
          const r = await fetch(`${config.upstreamBaseURL}/v1/videos`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'User-Agent': AGNES_USER_AGENT,
            },
            body: taskBody,
            signal: AbortSignal.timeout(120000),
          });
          if (!r.ok) {
            if (isLast) throw new Error(`upstream ${r.status}`);
            return { retry: true };
          }
          return { retry: false, response: r };
        } catch (e) {
          if (isLast) throw e;
          return { retry: true };
        }
      });
      if (!taskResp.response) throw new Error('video task creation failed after retries');
      const taskRespObj = taskResp.response;
      const taskData = await taskRespObj.json();
      const taskId = taskData.task_id || taskData.id;
      if (!taskId) throw new Error('no task id');

      console.log(`[AI Video] Task ${taskId} queued (~${(numFrames / frameRate).toFixed(1)}s), polling...`);
      const pollInterval = 12000;
      let queuedSince = 0;
      let lastProgress = -1;
      let lastLoggedPct = -1;
      let videoUrl = null;
      while (true) {
        await new Promise(r => setTimeout(r, pollInterval));
        try {
          const pollResp = await fetch(`${config.upstreamBaseURL}/v1/videos/${taskId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': AGNES_USER_AGENT },
            signal: AbortSignal.timeout(30000),
          });
          if (!pollResp.ok) continue;
          const pollData = await pollResp.json();
          const s = pollData.status || 'unknown';
          const p = typeof pollData.progress === 'number' ? pollData.progress : -1;
          if (p !== lastLoggedPct) { console.log(`[AI Video] Status: ${s} progress: ${p === -1 ? '?' : p}`); lastLoggedPct = p; }
          if (p !== lastProgress && p >= 0) { lastProgress = p; setGenProgress('video', p); }
          if (s === 'completed' || s === 'succeeded') {
            videoUrl = pollData.video_url || pollData.remixed_from_video_id || pollData.url || pollData.output?.url || pollData.result?.url || pollData.download_url || pollData.public_url || pollData.uri || pollData.output?.video_url || pollData.result?.video_url || (Array.isArray(pollData.files) && pollData.files[0]?.url) || (Array.isArray(pollData.data) && pollData.data[0]?.url);
            if (!videoUrl) console.log('[AI Video] Completed but no URL found in:', Object.keys(pollData), JSON.stringify(pollData).slice(0, 500));
            break;
          }
          if (s === 'failed' || s === 'error') {
            throw new Error(pollData.error || pollData.message || 'video generation failed');
          }
          if (s === 'queued') {
            if (queuedSince === 0) queuedSince = Date.now();
            else if (Date.now() - queuedSince > 30000) {
              throw new Error('video stuck in queue — likely requires a paid plan (video_gen feature)');
            }
          } else {
            queuedSince = 0;
          }
        } catch (e) { if (e.message.includes('stuck in queue') || e.message.includes('failed')) throw e; }
      }
      if (!videoUrl) throw new Error('video timed out');

      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      if (!buf || buf.length < 1024) throw new Error('downloaded video too small');
      fs.writeFileSync(vidFile, buf);
      console.log(`[AI Video] Saved ${(buf.length / 1024 / 1024).toFixed(2)} MB to ai-video.mp4`);
    } catch (e) {
      console.error('[AI Video] Background generation failed:', e.message);
    } finally {
      setGenProgress('video', 100);
      _aiVideoGen = false;
      _aiVideoGenPromise = null;
    }
  })();
  return _aiVideoGenPromise;
}

// --- Main Request Handler ---
async function handleRequest(req, res) {
  try {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (!fs.existsSync(dashboardPath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return; }
    let html = fs.readFileSync(dashboardPath, 'utf-8');
    const wpMode = config.wallpaperMode || 'bing';
    const cacheDir = path.join(__dirname, '.cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    let wpStyle = '';

    if (wpMode === 'ai') {
      const aiFile = path.join(cacheDir, 'ai-paper.jpg');
      if (fs.existsSync(aiFile)) {
        try {
          const imgBuf = fs.readFileSync(aiFile);
          wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + imgBuf.toString('base64') + ') center/cover no-repeat fixed}</style>';
        } catch (e) { console.error('[AI] Failed to embed ai-paper:', e.message); }
      } else {
        try {
          await generateAiWallpaperToDisk();
          const imgBuf = fs.readFileSync(aiFile);
          wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + imgBuf.toString('base64') + ') center/cover no-repeat fixed}</style>';
        } catch (e) { console.error('[AI] Failed to generate ai-paper:', e.message); }
      }
    } else if (wpMode === 'ai-video') {
      const vidFile = path.join(cacheDir, 'ai-video.mp4');
      if (fs.existsSync(vidFile)) {
        wpStyle = '<style>#wp-video-bg{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-2;pointer-events:none;background:#0d1117}#wp-video-fallback{position:fixed;inset:0;background:#0d1117;z-index:-3}</style>'
                + '<video id="wp-video-bg" autoplay loop muted playsinline preload="auto" src="/api/bg?t=' + Date.now() + '"></video><div id="wp-video-fallback"></div>';
      } else {
        wpStyle = '<style>#wp-video-fallback{position:fixed;inset:0;background:#0d1117;z-index:-2}</style><div id="wp-video-fallback"></div>';
        try {
          await generateAiVideoToDisk();
          if (fs.existsSync(vidFile)) {
            wpStyle = '<style>#wp-video-bg{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-2;pointer-events:none;background:#0d1117}#wp-video-fallback{position:fixed;inset:0;background:#0d1117;z-index:-3}</style>'
                    + '<video id="wp-video-bg" autoplay loop muted playsinline preload="auto" src="/api/bg?t=' + Date.now() + '"></video><div id="wp-video-fallback"></div>';
          }
        } catch (e) { console.error('[AI Video] Failed to generate ai-video:', e.message); }
      }
    } else if (wpMode === 'bing') {
      const imgCacheFile = path.join(cacheDir, 'wallpaper.jpg');
      const today = new Date().toISOString().split('T')[0];
      const cachedDate = fs.existsSync(imgCacheFile) ? fs.statSync(imgCacheFile).mtime.toISOString().split('T')[0] : '';
      if (cachedDate === today && fs.existsSync(imgCacheFile)) {
        try {
          const imgBuf = fs.readFileSync(imgCacheFile);
          wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + imgBuf.toString('base64') + ') center/cover no-repeat fixed}</style>';
        } catch (_) {}
      } else if (fs.existsSync(imgCacheFile)) {
        try {
          const imgBuf = fs.readFileSync(imgCacheFile);
          wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + imgBuf.toString('base64') + ') center/cover no-repeat fixed}</style>';
        } catch (_) {}
        fetch('https://peapix.com/bing/feed').then(r => r.json()).then(data => {
          const item = Array.isArray(data) ? data[0] : data;
          const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
          if (!imgUrl) return;
          return new Promise((resolve, reject) => {
            const u = new URL(imgUrl);
            const mod = u.protocol === 'https:' ? require('https') : require('http');
            mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
          });
        }).then(imgResp => {
          const chunks = [];
          imgResp.on('data', c => chunks.push(c));
          return new Promise(resolve => imgResp.on('end', () => resolve(Buffer.concat(chunks))));
        }).then(buf => {
          fs.writeFileSync(imgCacheFile, buf);
          console.log('[Bing] Background refreshed');
        }).catch(() => {});
      } else {
        try {
          const resp = await fetch('https://peapix.com/bing/feed');
          const data = await resp.json();
          const item = Array.isArray(data) ? data[0] : data;
          const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
          if (imgUrl) {
            const imgResp = await new Promise((resolve, reject) => {
              const u = new URL(imgUrl);
              const mod = u.protocol === 'https:' ? require('https') : require('http');
              mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
            });
            const chunks = [];
            await new Promise(resolve => { imgResp.on('data', c => chunks.push(c)); imgResp.on('end', resolve); });
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(imgCacheFile, buf);
            wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + buf.toString('base64') + ') center/cover no-repeat fixed}</style>';
          }
        } catch (_) {}
      }
    } else {
      wpStyle = '<style>body{background:#0d1117}</style>';
    }

    html = html.replace('<body>', '<body data-wp-mode="' + wpMode + '">');
    if (wpStyle) html = html.replace('</head>', wpStyle + '</head>');
    const buf = Buffer.from(html);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': buf.length, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
    res.end(buf);
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const maskedConfig = { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 10) + '...' : '' };
      delete maskedConfig.platformToken;
      writeJSON(res, 200, maskedConfig);
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        if (newConfig.apiKey) config.apiKey = newConfig.apiKey;
        if (newConfig.apiKeys) config.apiKeys = newConfig.apiKeys;
        if (newConfig.listenAddr) config.listenAddr = newConfig.listenAddr;
        if (newConfig.testMode !== undefined) config.testMode = newConfig.testMode;
        if (newConfig.localOverwrite !== undefined) {
          const v = newConfig.localOverwrite;
          config.localOverwrite = (typeof v === 'string' && v.trim()) ? v.trim().toLowerCase().split(/[-_]/)[0].slice(0, 8) : null;
        }
        if (newConfig.wallpaperMode) config.wallpaperMode = newConfig.wallpaperMode;
        if (newConfig.img_prompt !== undefined) config.img_prompt = newConfig.img_prompt;
        if (newConfig.video_prompt !== undefined) config.video_prompt = newConfig.video_prompt;
        if (Array.isArray(newConfig.enabledModels)) config.enabledModels = newConfig.enabledModels;
        if (Array.isArray(newConfig.platformUsers)) {
          config.platformUsers = newConfig.platformUsers.map(u => ({
            username: u.username || '',
            password: u.password || '',
            token: u.token || '',
            user: u.user || null,
          }));
        }
        if (Array.isArray(newConfig.keys)) {
          config.keys = newConfig.keys;
          if (config.keys.length > 0) {
            const firstKey = config.keys[0].key || '';
            config.apiKey = firstKey;
            if (upstream) upstream.apiKey = firstKey;
            currentTokenIndex = 0;
          }
        }
        saveConfig(config);
        setupOpencodeConfig();
        notifyConfigChange();
        writeJSON(res, 200, { success: true });
      }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/validate' && req.method === 'GET') {
    const valid = await validateApiKey();
    writeJSON(res, 200, { valid, hasApiKey: !!config.apiKey });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { username, password } = JSON.parse(body);
      if (!username || !password) {
        writeJSON(res, 400, { error: 'username and password are required' });
        return;
      }
      const result = await loginToPlatform(username, password);
      if (result.success) {
        writeJSON(res, 200, {
          success: true,
          token: result.token,
          user: result.user,
        });
      } else {
        writeJSON(res, 401, { success: false, error: result.message });
      }
    } catch (e) {
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const username = platformSession.user?.username || platformSession.user?.email || '';
    platformSession = { token: null, user: null, expiresAt: 0 };
    if (username && config.platformUsers) {
      const usernameLower = username.toLowerCase();
      const idx = config.platformUsers.findIndex(u =>
        u.username.toLowerCase() === usernameLower ||
        (u.user?.email && u.user.email.toLowerCase() === usernameLower) ||
        (u.user?.username && u.user.username.toLowerCase() === usernameLower)
      );
      if (idx >= 0) {
        const puName = config.platformUsers[idx].username;
        config.platformUsers.splice(idx, 1);
        config.keys = config.keys.filter(t => !t.platformUser || t.platformUser.toLowerCase() !== puName.toLowerCase());
      }
    }
    if (username) {
      const usernameLower = username.toLowerCase();
      const before = config.keys.length;
      config.keys = config.keys.filter(t => !t.platformUser || t.platformUser.toLowerCase() !== usernameLower);
      if (config.keys.length !== before) {
        config.platformSession = { activeUsername: null };
      }
    }
    if (!config.keys || config.keys.length === 0) {
      config.keys = [{ name: 'Key 1', key: '', platformUser: '' }];
    } else {
      config.keys = config.keys.filter(t => t && (t.key || t.token));
      if (config.keys.length === 0) config.keys.push({ name: 'Key 1', key: '', platformUser: '' });
    }
    config.apiKey = config.keys[0]?.key || '';
    saveConfig(config);
    setupOpencodeConfig();
    notifyConfigChange();
    writeJSON(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/platform-users' && req.method === 'GET') {
    const users = (config.platformUsers || []).map(u => ({
      username: u.username,
      email: u.user?.email || '',
      logged_in: !!u.token,
      is_active: u.user?.is_active,
      last_login: u.user?.last_login || '',
    }));
    writeJSON(res, 200, { users });
    return;
  }

  if (pathname === '/api/platform-users' && req.method === 'DELETE') {
    try {
      const body = await readBody(req);
      const { username } = JSON.parse(body);
      if (!username) { writeJSON(res, 400, { error: 'username required' }); return; }
      const idx = config.platformUsers.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
      if (idx < 0) { writeJSON(res, 404, { error: 'User not found' }); return; }
      config.platformUsers.splice(idx, 1);
      config.keys = config.keys.filter(t => t.platformUser && t.platformUser.toLowerCase() !== username.toLowerCase());
      if (config.keys.length === 0) config.keys.push({ name: 'Key 1', key: '' });
      saveConfig(config);
      setupOpencodeConfig();
      notifyConfigChange();
      writeJSON(res, 200, { success: true });
    } catch (e) { writeJSON(res, 400, { error: e.message }); }
    return;
  }

  if (pathname === '/api/platform/user' && req.method === 'GET') {
    if (!platformSession.token) {
      writeJSON(res, 401, { error: 'Not logged in' });
      return;
    }
    try {
      const userInfo = await platformGetUserInfo();
      writeJSON(res, 200, { success: true, user: userInfo });
    } catch (e) {
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/platform/keys' && req.method === 'GET') {
    if (!platformSession.token) {
      writeJSON(res, 401, { error: 'Not logged in' });
      return;
    }
    try {
      const planName = await platformGetSubscriptionPlanName();
      let keys = await platformGetUserKeys();
      let acctName = platformSession.user?.username || platformSession.user?.email || platformSession.user?.name || '';
      if (!acctName) {
        try {
          const ui = await platformGetUserInfo();
          const u = ui?.data || ui;
          acctName = u?.username || u?.email || '';
        } catch (e) { /* ignore */ }
      }
      const enriched = (keys || []).map(k => ({
        ...k,
        plan_name: k.plan_name && k.plan_name.trim() ? k.plan_name : (planName || 'Default'),
      }));
      // Also try the premium subscription key reveal endpoint
      try {
        const premiumController = new AbortController();
        const premiumTimer = setTimeout(() => premiumController.abort(), 10000);
        const premiumResp = await fetch(`${PLATFORM_BASE_URL}/api/user/subscription/key/reveal`, {
          method: 'POST',
          headers: { ...getPlatformHeaders(), 'Content-Type': 'application/json' },
          body: null,
          signal: premiumController.signal,
        });
        clearTimeout(premiumTimer);
        if (premiumResp.ok) {
          const premiumBody = await premiumResp.json();
          if (premiumBody.code === 200 && premiumBody.data?.key) {
            enriched.push({
              id: `premium_${premiumBody.data.id || '0'}`,
              name: planName || 'Premium Plan',
              preview: premiumBody.data.key.substring(0, 8) + '…',
              plan_name: planName || 'Premium',
              status: 'active',
              full_key: premiumBody.data.key,
              _revealed: true,
            });
          }
        }
      } catch (e) { /* premium reveal is optional */ }
      writeJSON(res, 200, { keys: enriched, plan_name: planName, username: acctName });
    } catch (e) {
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  const tokenKeyMatch = pathname.match(/^\/api\/platform\/token\/(\d+)\/key$/);
  if (tokenKeyMatch && req.method === 'GET') {
    if (!platformSession.token) { writeJSON(res, 401, { error: 'Not logged in' }); return; }
    try {
      const key = await platformGetTokenKey(tokenKeyMatch[1]);
      if (!key) { writeJSON(res, 404, { error: 'Key not found' }); return; }
      writeJSON(res, 200, { key });
    } catch (e) {
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const models = config.enabledModels || (dynamicModels && dynamicModels.length > 0 ? dynamicModels : AGNES_MODELS);
    const allModels = dynamicModels && dynamicModels.length > 0 ? dynamicModels : AGNES_MODELS;
    const meta = {};
    for (const m of allModels) { meta[m] = getModelMeta(m); }
    writeJSON(res, 200, { models, allModels, meta });
    return;
  }

  if (pathname === '/api/bg' && req.method === 'GET') {
    let mode = config.wallpaperMode || 'bing';
    if (mode === 'none') {
      res.writeHead(204);
      res.end();
      return;
    }
    const cacheDir = path.join(__dirname, '.cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    if (mode === 'ai') {
      if (!hasApiToken()) {
        mode = 'bing';
      } else {
        const aiFile = path.join(cacheDir, 'ai-paper.jpg');
        if (fs.existsSync(aiFile)) {
          const imgData = fs.readFileSync(aiFile);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length, 'Cache-Control': 'no-cache' });
          res.end(imgData);
        } else {
          try {
            await generateAiWallpaperToDisk();
            const imgData = fs.readFileSync(aiFile);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length, 'Cache-Control': 'no-cache' });
            res.end(imgData);
          } catch (e) {
            res.writeHead(500);
            res.end();
          }
        }
        return;
      }
    }

    if (mode === 'ai-video') {
      if (!hasApiToken()) {
        mode = 'bing';
      } else {
        const vidFile = path.join(cacheDir, 'ai-video.mp4');
        if (fs.existsSync(vidFile)) {
          const vidData = fs.readFileSync(vidFile);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': vidData.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
          res.end(vidData);
          return;
        }
        try {
          await generateAiVideoToDisk();
          if (fs.existsSync(vidFile)) {
            const vidData = fs.readFileSync(vidFile);
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': vidData.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
            res.end(vidData);
            return;
          }
          res.writeHead(204);
          res.end();
        } catch (e) {
          res.writeHead(500);
          res.end();
        }
        return;
      }
    }

    const imgCacheFile = path.join(cacheDir, 'wallpaper.jpg');
    const today = new Date().toISOString().split('T')[0];
    const cachedDate = fs.existsSync(imgCacheFile) ? fs.statSync(imgCacheFile).mtime.toISOString().split('T')[0] : '';
    const expireHeader = cachedDate ? { 'Expires': new Date(cachedDate + 'T23:59:59Z').toUTCString() } : { 'Cache-Control': 'public, max-age=86400' };
    if (cachedDate === today && fs.existsSync(imgCacheFile)) {
      const imgData = fs.readFileSync(imgCacheFile);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length, ...expireHeader });
      res.end(imgData);
      return;
    }
    try {
      const resp = await fetch('https://peapix.com/bing/feed');
      const data = await resp.json();
      const item = Array.isArray(data) ? data[0] : data;
      const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
      if (!imgUrl) { writeJSON(res, 404, { error: 'not found' }); return; }
      const imgResp = await new Promise((resolve, reject) => {
        const u = new URL(imgUrl);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
      });
      const chunks = [];
      imgResp.on('data', c => chunks.push(c));
      imgResp.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(imgCacheFile, buf);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
      });
    } catch (e) {
      if (fs.existsSync(imgCacheFile)) {
        const buf = fs.readFileSync(imgCacheFile);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
        return;
      }
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/generate-image' && req.method === 'POST') {
    if (!hasApiToken()) {
      writeJSON(res, 403, { error: 'AI image generation requires an API token. Add a token in config.' });
      return;
    }
    try {
      await generateAiWallpaperToDisk();
      writeJSON(res, 200, { success: true, url: `/api/bg?t=${Date.now()}` });
    } catch (e) {
      if (e.message === 'Already generating') {
        writeJSON(res, 503, { error: 'Background generation already in progress, please wait' });
      } else {
        writeJSON(res, 500, { error: e.message });
      }
    }
    return;
  }

  if (pathname === '/api/wallpaper-progress' && req.method === 'GET') {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify(_genProgress)}\n\n`);
      res.end();
      return;
    }
    writeJSON(res, 200, _genProgress);
    return;
  }

  if (pathname === '/api/generate-video' && req.method === 'POST') {
    if (!hasApiToken()) {
      writeJSON(res, 403, { error: 'AI video generation requires an API token. Add a token in config.' });
      return;
    }
    generateAiVideoToDisk()
      .then(() => writeJSON(res, 200, { success: true, url: `/api/bg?t=${Date.now()}` }))
      .catch((e) => writeJSON(res, 500, { error: e.message }));
    return;
  }

  if (pathname === '/api/keys') {
    if (req.method === 'GET') {
      const keys = (config.keys || []).map(t => ({
        name: t.name,
        key: t.key,
        platformUser: t.platformUser || '',
      }));
      const safe = keys.map(t => ({
        name: t.name,
        key_masked: t.key ? t.key.substring(0, 10) + '...' + t.key.substring(t.key.length - 4) : '',
        has_key: !!t.key,
        platformUser: t.platformUser,
      }));
      writeJSON(res, 200, { keys, safe });
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (data.action === 'add') {
          if (!config.keys) config.keys = [];
          config.keys.push({ name: data.name || `Key ${config.keys.length + 1}`, key: data.key || '', platformUser: data.platformUser || '' });
          if (!config.apiKey && data.key) config.apiKey = data.key;
          saveConfig(config);
          setupOpencodeConfig();
          notifyConfigChange();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'update') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          if (data.name !== undefined) config.keys[data.index].name = data.name;
          if (data.key !== undefined) config.keys[data.index].key = data.key;
          if (data.platformUser !== undefined) config.keys[data.index].platformUser = data.platformUser;
          if (data.index === 0 && config.keys[0].key) config.apiKey = config.keys[0].key;
          saveConfig(config);
          setupOpencodeConfig();
          notifyConfigChange();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'delete') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          config.keys.splice(data.index, 1);
          if (data.index === 0) config.apiKey = config.keys[0]?.key || '';
          saveConfig(config);
          setupOpencodeConfig();
          notifyConfigChange();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else {
          writeJSON(res, 400, { error: 'Unknown action' });
        }
      } catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/cache') {
    if (req.method === 'GET') { writeJSON(res, 200, { ...responseCache.stats, enabled: config.cacheEnabled }); return; }
    if (req.method === 'DELETE') { responseCache.clear(); writeJSON(res, 200, { success: true, cache: responseCache.stats }); return; }
  }

  if (pathname === '/api/i18n') { await handleI18nGet(req, res); return; }

  if (pathname === '/api/account') { await handleAccountInfo(req, res); return; }

  if (pathname === '/api/plan-status') { await handlePlanStatus(req, res); return; }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await handleChatCompletions(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
  } catch (e) {
    console.error('[Handler Error]', e.message);
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'internal error', type: 'server_error' } })); } } catch {}
  }
}

// --- Opencode Config ---
const AGNES_MODEL_META = {
  'agnes-2.0-flash': {
    name: 'Agnes 2.0 Flash',
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 256000, output: 16384 },
  },
  'agnes-1.5-flash': {
    name: 'Agnes 1.5 Flash',
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 256000, output: 16384 },
  },
  'agnes-image-2.0-flash': {
    name: 'Agnes Image 2.0 Flash',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: false,
    modalities: { input: ['text', 'image'], output: ['image'] },
  },
  'agnes-image-2.1-flash': {
    name: 'Agnes Image 2.1 Flash',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: false,
    modalities: { input: ['text', 'image'], output: ['image'] },
  },
  'agnes-video-v2.0': {
    name: 'Agnes Video V2.0',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: false,
    modalities: { input: ['text', 'image'], output: ['video'] },
  },
};

function getModelMeta(modelId) {
  if (AGNES_MODEL_META[modelId]) return AGNES_MODEL_META[modelId];
  return { name: modelId };
}

const MODEL_REMAP = {
  'sapiens-ai/agnes-1.5-pro': 'agnes-2.0-flash',
  'sapiens-ai/agnes-1.5-lite': 'agnes-1.5-flash',
  'sapiens-ai/agnes-image-1.2': 'agnes-image-2.0-flash',
  'sapiens-ai/agnes-video-v1.2': 'agnes-video-v2.0',
  'sapiens-ai/agnes-1.5-pro-full': 'agnes-2.0-flash',
  'sapiens-ai/agnes-1.5-lite-full': 'agnes-1.5-flash',
};

function remapModel(modelId) {
  return MODEL_REMAP[modelId] || modelId;
}

function setupOpencodeConfig() {
  const enabled = config.enabledModels || AGNES_MODELS;
  const allModels = dynamicModels && dynamicModels.length > 0 ? dynamicModels : AGNES_MODELS;
  const port = parseInt(config.listenAddr.split(':').pop()) || 8082;

  const models = {};
  const disabled = [];
  for (const m of allModels) {
    const meta = getModelMeta(m);
    if (enabled.includes(m)) {
      models[m] = meta;
    } else {
      disabled.push(m);
    }
  }
  const providerEntry = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Agnes2Opencode',
    options: { baseURL: `http://localhost:${port}/v1` },
    models,
    blacklist: disabled
  };

  const configPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  ];
  if (process.platform === 'win32') {
    configPaths.unshift(path.join(os.homedir(), '.opencode', 'opencode.json'));
    const systemProfile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.opencode', 'opencode.json');
    try { if (fs.existsSync(path.dirname(systemProfile))) configPaths.push(systemProfile); } catch {}
  }

  for (const configFile of configPaths) {
    try {
      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing = { $schema: 'https://opencode.ai/config.json' };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const backupFile = path.join(dir, 'openconfig.b4agnes.json');
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          console.log(`[Opencode] Backup created: ${backupFile}`);
        }
      }
      if (!existing.provider || typeof existing.provider !== 'object') existing.provider = {};
      existing.provider['agnes'] = providerEntry;
      // Remove old zenith and stepfun providers
      delete existing.provider['zenith'];
      delete existing.provider['stepfun'];
      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      console.log(`[Opencode] Config updated: ${configFile}`);
    } catch (e) {
      console.error(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
}

// --- Server Startup ---
let upstream;

async function startServer() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Agnes2Opencode - Starting...                                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  responseCache = new ResponseCache(config.cacheMaxSize, config.cacheTtl);

  if (!config.apiKey) {
    console.log('[Warning] No Agnes AI API key configured. Set AGNES_API_KEY env var or add API_KEY to .config/config.json');
  }

  upstream = new UpstreamClient(config);
  const apiKeyValid = await validateApiKey();

  // Restore platform sessions from platformUsers on startup
  if (config.platformUsers && config.platformUsers.length > 0) {
    let restored = false;
    for (const pu of config.platformUsers) {
      if (pu.token) {
        platformSession = {
          token: pu.token,
          user: pu.user,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        };
        console.log(`[Platform] Restored session for ${pu.user?.email || pu.username}, validating...`);
        try {
          await platformGetUserInfo();
          console.log(`[Platform] Session valid for ${pu.username}`);
          restored = true;
          break;
        } catch (e) {
          console.log(`[Platform] Session invalid for ${pu.username} (${e.message})`);
          platformSession = { token: null, user: null, expiresAt: 0 };
        }
      }
    }
    if (!restored) {
      for (const pu of config.platformUsers) {
        if (pu.password) {
          console.log(`[Platform] No saved session for ${pu.username}, logging in...`);
          const lr = await loginToPlatform(pu.username, pu.password);
          if (lr.success) {
            console.log(`[Platform] Auto-login successful for ${pu.username}`);
            restored = true;
            break;
          } else {
            console.error(`[Platform] Auto-login failed for ${pu.username}: ${lr.message}`);
          }
        }
      }
    }
  }

  await fetchRemoteModels();

  prefetchI18nOnStartup().catch(() => {});

  const port = parseInt(config.listenAddr.split(':').pop()) || 8082;

  function onListen() {
    console.log(`\nAgnes2Opencode on http://127.0.0.1:${port}`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  Models URL: ${AGNES_MODELS_URL}`);
    console.log(`  API Key: ${config.apiKey ? 'configured (' + config.apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);
    console.log(`  API Key Valid: ${apiKeyValid}`);
    console.log(`  Models: ${config.enabledModels?.length || dynamicModels?.length || AGNES_MODELS.length} (dynamic)`);
    console.log(`  Response Cache: ${config.cacheEnabled ? 'enabled (' + config.cacheMaxSize + ' entries, ' + (config.cacheTtl / 1000) + 's TTL)' : 'disabled'}`);
    console.log(`  Proxy API Keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log(`  Platform Login: ${platformSession.token ? 'logged in as ' + (platformSession.user?.email || 'unknown') : 'not logged in'}`);
    console.log('');
  }

  const MAX_LISTEN_RETRIES = 10;
  let listenRetries = 0;

  function tryListen() {
    const server = http.createServer(handleRequest);
    initWSServer(server);
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
        listenRetries++;
        console.log(`[Retry] Port ${port} in use, retrying in 2s... (${listenRetries}/${MAX_LISTEN_RETRIES})`);
        setTimeout(tryListen, 2000);
      } else {
        console.error(`[FATAL] ${e.message}`);
        process.exit(1);
      }
    });
    server.listen(port, '127.0.0.1', onListen);
  }

  tryListen();
}

startServer().catch(e => { console.error('Failed to start server:', e.message); process.exit(1); });
