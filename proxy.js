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
    wallpaperMode: rawConfig.WALLPAPER_MODE || 'bing',
    wallpaperPrompt: rawConfig.WALLPAPER_PROMPT || 'realistic vibrant colorful mountain range landscape',
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
    WALLPAPER_PROMPT: cfg.wallpaperPrompt || 'realistic vibrant colorful mountain range landscape',
    CACHE_TTL: `${(cfg.cacheTtl || 60000) / 1000}s`,
    CACHE_MAX_SIZE: cfg.cacheMaxSize || 100,
    CACHE_ENABLED: cfg.cacheEnabled !== false,
    TEST_MODE: cfg.testMode !== false,
    KEYS: cfg.keys,
    PLATFORM_USERS: platformUsers,
  }, null, 2));
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

  async getStepPlanStatus() { return null; }

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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${PLATFORM_BASE_URL}/api/token/${tokenId}/key`, {
      method: 'POST',
      headers: { ...getPlatformHeaders(), 'Content-Type': 'application/json' },
      body: null,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = await resp.json();
    if (body.code !== 200 || !body.data?.key) return null;
    return body.data.key;
  } catch (e) { return null; }
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

async function handleStepPlanStatus(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  if (config.testMode) {
    writeJSON(res, 200, {
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
    });
    return;
  }
  if (!platformSession.token) {
    writeJSON(res, 200, { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: false });
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
    if (!sub) { writeJSON(res, 200, { has_plan: false, plan_status: 'none', subscriptions: [], logged_in: true }); return; }
    const statusMap = { active: 'active', pending: 'pending', expired: 'expired', cancelled: 'cancelled' };
    const textGen = sub.usage?.text_generation;
    const windowed = textGen?.windowed || {};
    const weekly = textGen?.weekly || {};
    const daily = textGen?.daily || {};
    const imgGen = sub.usage?.image_generation;
    const imgDaily = imgGen?.daily || {};
    const subFeatures = sub.features || {};
    writeJSON(res, 200, {
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
    });
  } catch (e) {
    writeJSON(res, 200, { has_plan: false, plan_status: 'error', error: e.message, subscriptions: [], logged_in: true });
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

async function proxyChatRequest(res, payload, requestedModel) {
  const reqStart = Date.now();

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
    if (isModelUnavailableError(errorBodyStr) || isQueryEngineError(errorBodyStr)) {
      if (isLast) {
        console.log(`${ts} [Token: ${tokenPreview}] [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}`);
        writePassthroughError(res, resp.status, errorBodyStr);
        return { retry: false };
      }
      const reason = isQueryEngineError(errorBodyStr) ? 'query_engine' : 'unavailable';
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

const MAX_RETRIES = 3;
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
let _aiWallpaperGen = false;
let _aiWallpaperGenPromise = null;
async function generateAiWallpaperToDisk() {
  if (_aiWallpaperGen) {
    console.log('[AI] Background generation already in progress, waiting...');
    return _aiWallpaperGenPromise;
  }
  _aiWallpaperGen = true;
  _aiWallpaperGenPromise = (async () => {
    try {
      const cacheDir = path.join(__dirname, '.cache');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const aiFile = path.join(cacheDir, 'ai-paper.jpg');
      const apiKey = config.apiKey || config.keys?.[0]?.key || '';
      if (!apiKey) throw new Error('no API key');
  
      const prompt = config.wallpaperPrompt || 'hdr, polar night, vibrant rainbow colors, trees, mountains, glaciers, stars and dark skies';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch(`${config.upstreamBaseURL}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': AGNES_USER_AGENT,
        },
        body: JSON.stringify({
          model: 'agnes-image-2.1-flash',
          prompt,
          n: 1,
          size: '1024x768',
          seed: Date.now(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error(`[AI] Upstream error ${resp.status}: ${errBody}`);
        throw new Error(`upstream ${resp.status}: ${errBody}`);
      }
  
      const data = await resp.json();
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
      _aiWallpaperGen = false;
      _aiWallpaperGenPromise = null;
    }
  })();
  return _aiWallpaperGenPromise;
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
          generateAiWallpaperToDisk().catch(() => {});
        } catch (e) { console.error('[AI] Failed to embed ai-paper:', e.message); }
      } else {
        try {
          await generateAiWallpaperToDisk();
          const imgBuf = fs.readFileSync(aiFile);
          wpStyle = '<style>body{background:url(data:image/jpeg;base64,' + imgBuf.toString('base64') + ') center/cover no-repeat fixed}</style>';
        } catch (e) { console.error('[AI] Failed to generate ai-paper:', e.message); }
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
        if (newConfig.wallpaperMode) config.wallpaperMode = newConfig.wallpaperMode;
        if (newConfig.wallpaperPrompt !== undefined) config.wallpaperPrompt = newConfig.wallpaperPrompt;
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
          generateAiWallpaperToDisk().catch(() => {});
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
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'update') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          if (data.name !== undefined) config.keys[data.index].name = data.name;
          if (data.key !== undefined) config.keys[data.index].key = data.key;
          if (data.platformUser !== undefined) config.keys[data.index].platformUser = data.platformUser;
          if (data.index === 0 && config.keys[0].key) config.apiKey = config.keys[0].key;
          saveConfig(config);
          setupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'delete') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          config.keys.splice(data.index, 1);
          if (data.index === 0) config.apiKey = config.keys[0]?.key || '';
          saveConfig(config);
          setupOpencodeConfig();
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

  if (pathname === '/api/account') { await handleAccountInfo(req, res); return; }

  if (pathname === '/api/get-plan-status') { await handleStepPlanStatus(req, res); return; }

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
