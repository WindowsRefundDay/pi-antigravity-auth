import type {
  ExtensionAPI,
  SessionStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

type MessageEndEvent = {
  type: "message_end";
  message: AssistantMessage;
};
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { prepareAntigravityRequest, transformAntigravityResponse } from "opencode-antigravity-auth/dist/src/plugin/request.js";
import { cleanJSONSchemaForAntigravity } from "opencode-antigravity-auth/dist/src/plugin/request-helpers.js";
import { checkAccountsQuota } from "opencode-antigravity-auth/dist/src/plugin/quota.js";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  getRandomizedHeaders,
  setAntigravityVersion,
  SKIP_THOUGHT_SIGNATURE,
} from "opencode-antigravity-auth/dist/src/constants.js";

const CLIENT_ID = process.env.PI_ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_CLIENT_ID;
const CLIENT_SECRET = process.env.PI_ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_CLIENT_SECRET;
const REDIRECT_URI = process.env.PI_ANTIGRAVITY_REDIRECT_URI || ANTIGRAVITY_REDIRECT_URI;
const SCOPES = ANTIGRAVITY_SCOPES;
const ANTIGRAVITY_PLUGIN_VERSION = process.env.PI_ANTIGRAVITY_PLUGIN_VERSION || "1.25.0";
setAntigravityVersion(ANTIGRAVITY_PLUGIN_VERSION);
const ACCOUNTS_PATH = join(homedir(), ".pi", "agent", "antigravity-accounts.json");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "antigravity.json");
const OPENCODE_ACCOUNTS_PATH = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
const ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

// Hardcoded headers removed. Using getRandomizedHeaders dynamically from constants.js

type Account = {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt?: number;
  lastUsed?: number;
  cooldownUntil?: number;
  failureCount?: number;
  assignedUserAgent?: string;
  enabled?: boolean;
};
type AccountStorage = { version: number; accounts: Account[]; activeIndex?: number; activeIndexByFamily?: Record<string, number> };
type Access = { token: string; expires: number };
type QuotaStyle = "antigravity";
type AntigravityConfig = {
  accountSelectionStrategy: "round-robin" | "random" | "sticky";
  rotateAccounts: boolean;
  quiet: boolean;
  initialCooldownMs: number;
};
const DEFAULT_CONFIG: AntigravityConfig = {
  accountSelectionStrategy: "round-robin",
  rotateAccounts: true,
  quiet: false,
  initialCooldownMs: 2000,
};

const CONFIG_MAPPING: Record<string, keyof AntigravityConfig> = {
  strategy: "accountSelectionStrategy",
  accountSelectionStrategy: "accountSelectionStrategy",
  rotate: "rotateAccounts",
  rotateAccounts: "rotateAccounts",
  quiet: "quiet",
  cooldown: "initialCooldownMs",
  initialCooldownMs: "initialCooldownMs",
};

const accessCache = new Map<string, Access>();
const refreshPromises = new Map<string, Promise<string>>();
let roundRobin = 0;
let toolCallCounter = 0;
let mutationPromise = Promise.resolve();

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(input: string) {
  return b64url(createHash("sha256").update(input).digest());
}
async function readAccounts(): Promise<AccountStorage> {
  const text = await fs.readFile(ACCOUNTS_PATH, "utf8").catch(() => "{}");
  const data = JSON.parse(text || "{}");
  const accounts = Array.isArray(data.accounts) ? data.accounts.filter((a: any) => a?.refreshToken) : [];
  return { version: data.version ?? 1, accounts, activeIndex: data.activeIndex ?? 0, activeIndexByFamily: data.activeIndexByFamily };
}
async function writeAccounts(storage: AccountStorage) {
  await fs.mkdir(dirname(ACCOUNTS_PATH), { recursive: true });
  const tmpPath = `${ACCOUNTS_PATH}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(storage, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, ACCOUNTS_PATH);
  try {
    const gi = join(dirname(ACCOUNTS_PATH), ".gitignore");
    const old = await fs.readFile(gi, "utf8").catch(() => "");
    if (!old.split(/\r?\n/).includes("antigravity-accounts.json")) await fs.appendFile(gi, `${old.endsWith("\n") || !old ? "" : "\n"}antigravity-accounts.json\n`);
  } catch {}
}
async function mutateAccounts(modifier: (storage: AccountStorage) => void | Promise<void>): Promise<void> {
  const result = mutationPromise.then(async () => {
    await fs.mkdir(dirname(ACCOUNTS_PATH), { recursive: true });
    await fs.appendFile(ACCOUNTS_PATH, "").catch(() => {});
    let release;
    try {
      release = await lock(ACCOUNTS_PATH, { retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 } });
      const storage = await readAccounts();
      await modifier(storage);
      await writeAccounts(storage);
    } catch (err) {
      console.error("[Antigravity] Failed to acquire lock for accounts", err);
    } finally {
      if (release) await release();
    }
  });
  mutationPromise = result.catch(() => {});
  return result;
}
async function readConfig(): Promise<AntigravityConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    const config = { ...DEFAULT_CONFIG };
    for (const [key, value] of Object.entries(raw)) {
      const resolvedKey = CONFIG_MAPPING[key];
      if (resolvedKey) {
        (config as any)[resolvedKey] = value;
      }
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
async function writeConfig(config: AntigravityConfig) {
  await fs.mkdir(dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function isGeminiModel(id: string) { return id.toLowerCase().includes("gemini"); }
function quotaStylesFor(_modelId: string, _config: AntigravityConfig): QuotaStyle[] {
  return ["antigravity"];
}
function endpointsFor(_style: QuotaStyle) {
  return ENDPOINTS;
}
function normalizeAntigravityUserAgent(userAgent?: string) {
  if (!userAgent) return undefined;
  return userAgent.replace(/\bantigravity\/\d+\.\d+\.\d+\b/i, `antigravity/${ANTIGRAVITY_PLUGIN_VERSION}`);
}
function headersFor(style: QuotaStyle, modelId?: string) {
  const headers = getRandomizedHeaders(style as any, modelId);
  if (style === "antigravity") headers["User-Agent"] = normalizeAntigravityUserAgent(headers["User-Agent"]) || headers["User-Agent"];
  return headers;
}
function accountOrder(storage: AccountStorage, family: string, config: AntigravityConfig): number[] {
  const count = storage.accounts.length;
  if (count <= 0) return [];
  const now = Date.now();
  
  const healthyIndices = storage.accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !a.cooldownUntil || a.cooldownUntil < now)
    .map(({ i }) => i);

  if (healthyIndices.length === 0) return [];

  if (config.accountSelectionStrategy === "random") {
    const start = Math.floor(Math.random() * healthyIndices.length);
    return Array.from({ length: healthyIndices.length }, (_, i) => healthyIndices[(start + i) % healthyIndices.length]);
  }
  const familyIndex = storage.activeIndexByFamily?.[family];
  const start = config.accountSelectionStrategy === "sticky" ? (familyIndex ?? storage.activeIndex ?? 0) : (roundRobin || familyIndex || storage.activeIndex || 0);
  return Array.from({ length: healthyIndices.length }, (_, i) => healthyIndices[(start + i) % healthyIndices.length]);
}
function markAccountSuccess(storage: AccountStorage, family: string, index: number, config: AntigravityConfig) {
  storage.accounts[index].lastUsed = Date.now();
  storage.accounts[index].failureCount = 0;
  storage.accounts[index].cooldownUntil = 0;
  const next = config.rotateAccounts ? (index + 1) % storage.accounts.length : index;
  storage.activeIndex = next;
  storage.activeIndexByFamily = { ...(storage.activeIndexByFamily || {}), [family]: next };
  roundRobin = next;
}
function markAccountFailure(storage: AccountStorage, index: number, cooldownMs = 5 * 60_000) {
  const account = storage.accounts[index];
  if (!account) return;
  account.failureCount = (account.failureCount || 0) + 1;
  account.cooldownUntil = Date.now() + Math.min(cooldownMs * Math.pow(2, account.failureCount - 1), 60 * 60_000);
}
async function refreshAccess(account: Account): Promise<string> {
  const cached = accessCache.get(account.refreshToken);
  if (cached && cached.expires > Date.now() + 60_000) {
    if (cached.expires < Date.now() + 600_000 && !refreshPromises.has(account.refreshToken)) {
      const p = doRefresh(account).finally(() => refreshPromises.delete(account.refreshToken));
      refreshPromises.set(account.refreshToken, p);
      p.catch(() => {}); // prevent unhandled promise rejection in the background
    }
    return cached.token;
  }
  let p = refreshPromises.get(account.refreshToken);
  if (!p) {
    p = doRefresh(account).finally(() => refreshPromises.delete(account.refreshToken));
    refreshPromises.set(account.refreshToken, p);
  }
  return p;
}

async function doRefresh(account: Account): Promise<string> {
  const start = Date.now();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh failed (${res.status}): ${await res.text().catch(() => "")}`);
  const json: any = await res.json();
  accessCache.set(account.refreshToken, { token: json.access_token, expires: start + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}
function effectiveProject(account: Account) {
  return account.managedProjectId || account.projectId || DEFAULT_PROJECT_ID;
}
function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
}
function toContents(model: Model<any>, context: Context) {
  const contents: any[] = [];
  const needsId = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const geminiReplay = isGeminiModel(model.id);
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts = typeof msg.content === "string"
        ? [{ text: msg.content }]
        : msg.content.map((c: any) => c.type === "text" ? { text: c.text } : { inlineData: { mimeType: c.mimeType, data: c.data } });
      if (parts.length) contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: any[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text?.trim()) parts.push({ text: b.text });
        if (b.type === "thinking" && b.thinking?.trim() && msg.provider === model.provider && msg.model === model.id) parts.push({ thought: true, text: b.thinking });
        if (b.type === "toolCall") {
          // Gemini 3 thought signatures are backend/model/quota scoped. Replaying a
          // Gemini CLI signature against Antigravity (or vice versa) can produce
          // `Corrupted thought signature`. The Cloud Code Assist backend accepts
          // this sentinel for replayed function calls; opencode-antigravity-auth
          // uses the same compatibility shim in its debug logs.
          parts.push({
            functionCall: { name: b.name, args: b.arguments ?? {}, ...(needsId ? { id: b.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) } : {}) },
            ...(geminiReplay ? { thoughtSignature: SKIP_THOUGHT_SIGNATURE } : {}),
          });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      const output = textFromContent(msg.content);
      const part = { functionResponse: { name: msg.toolName, response: msg.isError ? { error: output } : { output }, ...(needsId ? { id: msg.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) } : {}) } };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts?.some((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}
function sanitizeSchemaForAntigravity(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForAntigravity);
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "patternProperties") continue;
    if (key === "enum" && Array.isArray(value)) {
      const stringValues = value.filter((item): item is string => typeof item === "string");
      if (stringValues.length > 0) out[key] = stringValues;
      continue;
    }
    out[key] = sanitizeSchemaForAntigravity(value);
  }
  return out;
}
function toTools(context: Context) {
  if (!context.tools?.length) return undefined;
  return [{ functionDeclarations: context.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForAntigravity(cleanJSONSchemaForAntigravity(t.parameters)) || { type: "object", properties: {} },
  })) }];
}
function resolveActualModel(id: string) {
  return id
    .replace(/^gemini-3\.1-pro-(low|high)$/, "antigravity-gemini-3.1-pro-$1")
    .replace(/^claude-sonnet-4-6-thinking$/, "claude-sonnet-4-6")
    .replace(/^antigravity-/, "")
    .replace(/^gemini-3-pro$/, "gemini-3-pro-low");
}
function patchedEffectiveModel(requested: string, style: QuotaStyle) {
  const normalized = requested.replace(/^antigravity-/i, "");
  return style === "antigravity" && /^gemini-3\.6-flash-(low|medium|high)$/i.test(normalized)
    ? normalized
    : undefined;
}
function patchPreparedModel(prepared: any, effectiveModel?: string) {
  if (!effectiveModel) return prepared;
  if (typeof prepared?.request === "string") {
    prepared.request = prepared.request.replace(/\/(models|companionModels)\/[^:]+:/, `/$1/${encodeURIComponent(effectiveModel)}:`);
  }
  if (typeof prepared?.init?.body !== "string") return prepared;
  try {
    const body = JSON.parse(prepared.init.body);
    body.model = effectiveModel;
    if (body.request?.sessionId && typeof body.request.sessionId === "string") {
      body.request.sessionId = body.request.sessionId.replace(/:gemini-3\.(5|6)-flash(-low|-medium|-high)?:/i, `:${effectiveModel}:`);
    }
    prepared.init.body = JSON.stringify(body);
    prepared.effectiveModel = effectiveModel;
  } catch {}
  return prepared;
}
function thinkingConfig(id: string, reasoning?: string) {
  const lower = id.toLowerCase();
  const suffixLevel = lower.match(/-(minimal|low|medium|high)$/)?.[1];
  const level = reasoning === "high" || reasoning === "xhigh" ? "high" : reasoning === "medium" ? "medium" : suffixLevel || "low";
  if (lower.includes("gemini-3") || lower.includes("gemini-2.5")) return { includeThoughts: true, thinkingLevel: level };
  if (lower === "claude-sonnet-4-6") return undefined;
  if (lower.includes("claude") && lower.includes("thinking")) return { include_thoughts: true, thinking_budget: level === "high" ? 32768 : level === "medium" ? 16384 : 8192 };
  return undefined;
}
function buildRequestBody(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const actual = resolveActualModel(model.id);
  const generationConfig: any = {};
  if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  const tc = thinkingConfig(actual, options?.reasoning);
  if (tc) generationConfig.thinkingConfig = tc;
  return {
    contents: toContents(model, context),
    ...(context.systemPrompt ? { systemInstruction: { parts: [{ text: context.systemPrompt }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(toTools(context) ? { tools: toTools(context), toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
  };
}
function mapFinish(reason: string | undefined): "stop" | "length" | "toolUse" | "error" {
  if (reason === "MAX_TOKENS") return "length";
  if (!reason || reason === "STOP") return "stop";
  return "error";
}
function pushText(stream: any, output: AssistantMessage, state: any, delta: string, isThinking: boolean, signature?: string) {
  if (!delta) return;
  const blocks = output.content as any[];
  if (state.current === undefined || blocks[state.current]?.type !== (isThinking ? "thinking" : "text")) {
    if (state.current !== undefined) endCurrent(stream, output, state);
    state.current = blocks.length;
    blocks.push(isThinking ? { type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) } : { type: "text", text: "", ...(signature ? { textSignature: signature } : {}) });
    stream.push({ type: isThinking ? "thinking_start" : "text_start", contentIndex: state.current, partial: output });
  }
  const b: any = blocks[state.current];
  if (isThinking) {
    b.thinking += delta; if (signature) b.thinkingSignature = signature;
    stream.push({ type: "thinking_delta", contentIndex: state.current, delta, partial: output });
  } else {
    b.text += delta; if (signature) b.textSignature = signature;
    stream.push({ type: "text_delta", contentIndex: state.current, delta, partial: output });
  }
}
function endCurrent(stream: any, output: AssistantMessage, state: any) {
  if (state.current === undefined) return;
  const b: any = (output.content as any[])[state.current];
  if (b?.type === "text") stream.push({ type: "text_end", contentIndex: state.current, content: b.text, partial: output });
  if (b?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: state.current, content: b.thinking, partial: output });
  state.current = undefined;
}
function handleChunk(stream: any, output: AssistantMessage, state: any, chunk: any) {
  const cand = chunk?.candidates?.[0];
  output.responseId ||= chunk?.responseId;
  for (const part of cand?.content?.parts ?? []) {
    if (part.text !== undefined) pushText(stream, output, state, part.text, part.thought === true, part.thoughtSignature);
    if (part.functionCall) {
      endCurrent(stream, output, state);
      const id = part.functionCall.id || `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
      const tc: any = { type: "toolCall", id, name: part.functionCall.name || "", arguments: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
      const idx = output.content.length;
      output.content.push(tc);
      stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(tc.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });
    }
  }
  if (cand?.finishReason) output.stopReason = output.content.some((b: any) => b.type === "toolCall") ? "toolUse" : mapFinish(cand.finishReason);
  const u = chunk?.usageMetadata;
  if (u) {
    output.usage.input = (u.promptTokenCount || 0) - (u.cachedContentTokenCount || 0);
    output.usage.output = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    output.usage.cacheRead = u.cachedContentTokenCount || 0;
    output.usage.totalTokens = u.totalTokenCount || (output.usage.input + output.usage.output + output.usage.cacheRead);
    calculateCost(modelForCost(output), output.usage as any);
  }
}
function modelForCost(output: AssistantMessage): any { return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; }
async function streamSse(response: Response, stream: any, output: AssistantMessage, state: any, signal?: AbortSignal) {
  if (!response.body) throw new Error("Empty response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw new Error("Aborted");
    }
    signal.addEventListener("abort", onAbort);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        handleChunk(stream, output, state, JSON.parse(data));
      }
    }
    // Parse trailing non-newline terminated lines if present
    if (buf.trim().startsWith("data:")) {
      const line = buf.trim();
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") {
        handleChunk(stream, output, state, JSON.parse(data));
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
function streamAntigravity(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    const state: any = {};
    try {
      stream.push({ type: "start", partial: output });
      const storage = await readAccounts();
      const config = await readConfig();
      if (!storage.accounts.length) throw new Error(`No Antigravity accounts in ${ACCOUNTS_PATH}. Use /antigravity-import-opencode or /login antigravity.`);
      const body = buildRequestBody(model, context, options);
      const requested = resolveActualModel(model.id);
      const fakeInput = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requested)}:streamGenerateContent`;
      const family = isGeminiModel(model.id) ? "gemini" : "claude";
      let lastError: any;
      for (const style of quotaStylesFor(model.id, config)) {
        let isFirstAttempt = true;
        for (const accountIndex of accountOrder(storage, `${family}:${style}`, config)) {
          const account = storage.accounts[accountIndex];
          try {
            if (!isFirstAttempt) {
              await new Promise(r => setTimeout(r, 50 + Math.random() * 200)); // Jitter only on fallback retries
            }
            isFirstAttempt = false;
            const access = await refreshAccess(account);
            const project = effectiveProject(account);
            for (const endpoint of endpointsFor(style)) {
              const effectiveModel = patchedEffectiveModel(requested, style);
              const prepared: any = patchPreparedModel(prepareAntigravityRequest(fakeInput, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: options?.signal }, access, project, endpoint, style, false, { claudeToolHardening: true }), effectiveModel);
              const h = new Headers(prepared.init.headers || {});
              for (const [k, v] of Object.entries(headersFor(style, model.id))) h.set(k, v);
              if (account.assignedUserAgent) h.set("User-Agent", normalizeAntigravityUserAgent(account.assignedUserAgent) || account.assignedUserAgent);
              const res = await fetch(prepared.request, { ...prepared.init, headers: h });
              if (res.status === 429) { 
                await res.body?.cancel().catch(() => {});
                await mutateAccounts((s) => {
                  const a = s.accounts.find(x => x.email === account.email);
                  if (a) {
                    a.failureCount = (a.failureCount || 0) + 1;
                    const backoffMs = Math.min(config.initialCooldownMs * Math.pow(2, a.failureCount - 1), 3600000);
                    a.cooldownUntil = Date.now() + backoffMs;
                  }
                });
                const backoffMs = Math.min(config.initialCooldownMs * Math.pow(2, (account.failureCount || 0)), 3600000);
                lastError = new Error(`${style} quota rate limited: ${account.email || "account"} (Cooldown: ${backoffMs/1000}s)`); 
                break; 
              }
              const transformed = await transformAntigravityResponse(res, true, undefined, requested, project, endpoint, effectiveModel || prepared.effectiveModel, prepared.sessionId);
              if (!transformed.ok) {
                const errorText = await transformed.text().catch(() => "");
                lastError = new Error(`${style} ${transformed.status}: ${errorText}`);
                if (/invalid_grant|account has been deleted|unauthorized|verify your account/i.test(errorText)) {
                  await mutateAccounts((s) => markAccountFailure(s, accountIndex, 15 * 60_000));
                }
                const isModelUnavailable = transformed.status === 400 && /invalid argument|requested model/i.test(errorText);
                if (isModelUnavailable) break; // skip remaining endpoints; try next account
                if ([403, 404, 429, 500, 502, 503, 504].includes(transformed.status)) continue;
                throw lastError;
              }
              await streamSse(transformed, stream, output, state, options?.signal);
              await mutateAccounts((s) => {
                const idx = s.accounts.findIndex(x => x.email === account.email);
                if (idx >= 0) markAccountSuccess(s, `${family}:${style}`, idx, config);
              });
              endCurrent(stream, output, state);
              if (output.content.some((b: any) => b.type === "toolCall")) output.stopReason = "toolUse";
              stream.push({ type: "done", reason: output.stopReason as any, message: output });
              stream.end();
              return;
            }
          } catch (e) {
            lastError = e;
            const message = e instanceof Error ? e.message : String(e);
            if (/invalid_grant|account has been deleted|unauthorized|verify your account/i.test(message)) {
              await mutateAccounts((s) => markAccountFailure(s, accountIndex, 30 * 60_000));
            }
          }
        }
      }
      const now = Date.now();
      const healthyAccounts = storage.accounts.filter(a => !a.cooldownUntil || a.cooldownUntil < now);
      if (storage.accounts.length > 0 && healthyAccounts.length === 0) {
        throw new Error("All accounts are currently in rate-limit cooldown. Please wait a few seconds for limits to clear.");
      }
      throw lastError || new Error("All Antigravity/Gemini CLI accounts and quotas failed");
    } catch (e) {
      endCurrent(stream, output, state);
      const errMsg = e instanceof Error ? e.message : String(e);
      const isOverflow = /(context|token|payload|length|entity|window|limit|413)\s*(exceeded|too large|limit|bound|overflow)/i.test(errMsg);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = isOverflow ? `context_length_exceeded: ${errMsg}` : errMsg;
      stream.push({ type: "error", reason: output.stopReason as any, error: output });
      stream.end();
    }
  })();
  return stream;
}

async function makeAuthUrl() {
  const verifier = b64url(randomBytes(32));
  const challenge = await sha256(verifier);
  const state = b64url(Buffer.from(JSON.stringify({ verifier, projectId: "" }), "utf8"));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return { url: url.toString(), state, verifier };
}
async function exchange(code: string, verifier: string): Promise<OAuthCredentials> {
  const start = Date.now();
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier }) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(await res.text());
  }
  const tok: any = await res.json();
  const infoRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const info = infoRes.ok ? await infoRes.json() : {};
  if (!infoRes.ok) {
    await infoRes.body?.cancel().catch(() => {});
  }
  if (tok.refresh_token) {
    await mutateAccounts((s) => {
      if (!s.accounts.some(a => a.refreshToken === tok.refresh_token || (info.email && a.email === info.email))) {
        const macVersions = ["14_0", "14_1_2", "14_2", "14_3_1", "14_4", "14_4_1", "14_5", "15_0", "15_1"];
        const osVer = macVersions[Math.floor(Math.random() * macVersions.length)];
        const assignedUserAgent = `antigravity/${ANTIGRAVITY_PLUGIN_VERSION} darwin/arm64 Mac OS X ${osVer}`;
        s.accounts.push({ email: info.email, refreshToken: tok.refresh_token, addedAt: Date.now(), lastUsed: Date.now(), assignedUserAgent });
      }
    });
  }
  return { refresh: tok.refresh_token || "", access: tok.access_token, expires: start + (tok.expires_in ?? 3600) * 1000 };
}

const models = [
  // Antigravity model picker models
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", reasoning: true, contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", reasoning: true, contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", reasoning: true, contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", reasoning: true, contextWindow: 1048576, maxTokens: 65535 },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", reasoning: true, contextWindow: 1048576, maxTokens: 65535 },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: true, contextWindow: 1048576, maxTokens: 65536 },
  { id: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },

].map((m) => ({ ...m, input: ["text", "image"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));

export default function (pi: ExtensionAPI) {
  // Use session_start event to warn about Gemini CLI separate quota deprecation on startup
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    // Only print warnings and notifications in active UI sessions
    if (ctx.hasUI) {
      try {
        const storage = await readAccounts();
        if (!storage.accounts || storage.accounts.length === 0) {
          ctx.ui.notify("Antigravity Auth: Please authenticate by running /login antigravity or /antigravity-import-opencode.", "warning");
        }
      } catch {
        ctx.ui.notify("Antigravity Auth: Please authenticate by running /login antigravity or /antigravity-import-opencode.", "warning");
      }
    } else {
      // Print to console if running in CLI non-interactive mode
      try {
        const storage = await readAccounts();
        if (!storage.accounts || storage.accounts.length === 0) {
          console.log("\x1b[1m\x1b[35m[Antigravity Auth]\x1b[0m Please authenticate: run \x1b[32m/login antigravity\x1b[0m or \x1b[32m/antigravity-import-opencode\x1b[0m in Pi.\n");
        }
      } catch {
        console.log("\x1b[1m\x1b[35m[Antigravity Auth]\x1b[0m Please authenticate: run \x1b[32m/login antigravity\x1b[0m or \x1b[32m/antigravity-import-opencode\x1b[0m in Pi.\n");
      }
    }
  });

  // Intercept and normalize context length and payload entity errors in stream
  pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== "antigravity" && ctx.model?.provider !== "antigravity") return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;

    const isOverflow = /(context|token|payload|length|entity|window|limit|413)\s*(exceeded|too large|limit|bound|overflow)/i.test(errorMessage);
    if (!isOverflow) return;

    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });

  pi.registerProvider("antigravity", {
    name: "Google Antigravity",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    api: "antigravity-cloudcode",
    apiKey: "ANTIGRAVITY_UNUSED",
    models,
    streamSimple: streamAntigravity,
    oauth: {
      name: "Google Antigravity OAuth",
      async login(callbacks: OAuthLoginCallbacks) {
        const auth = await makeAuthUrl();
        callbacks.onAuth({ url: auth.url });
        const pasted = await callbacks.onPrompt({ message: "Paste the localhost redirect URL (or just code= value) after Google login:" });
        let code = pasted.trim();
        try { code = new URL(code).searchParams.get("code") || code; } catch {}
        return exchange(code, auth.verifier);
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const start = Date.now();
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refresh,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
          }),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Google OAuth refresh failed (${res.status}): ${await res.text().catch(() => "")}`);
        }
        const json: any = await res.json();
        return {
          refresh: json.refresh_token || credentials.refresh,
          access: json.access_token,
          expires: start + (json.expires_in ?? 3600) * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials) { return credentials.access || "unused"; },
    },
  });

  pi.registerCommand("antigravity-import-opencode", {
    description: "Import opencode-antigravity-auth accounts into Pi",
    handler: async (_args, ctx) => {
      const text = await fs.readFile(OPENCODE_ACCOUNTS_PATH, "utf8");
      const imported = JSON.parse(text);
      await mutateAccounts((s) => {
        s.accounts = imported.accounts;
        s.activeIndex = imported.activeIndex;
        s.version = imported.version;
      });
      const s = await readAccounts();
      ctx.ui.notify(`Imported ${s.accounts.length} Antigravity account(s) from opencode.`, "info");
    },
  });
  pi.registerCommand("antigravity-accounts", {
    description: "List imported Antigravity accounts (emails only)",
    handler: async (_args, ctx) => {
      const s = await readAccounts();
      const c = await readConfig();
      ctx.ui.notify([
        `Config: strategy=${c.accountSelectionStrategy}, rotate=${c.rotateAccounts}, cooldown=${c.initialCooldownMs}ms`,
        `Active index: ${s.activeIndex ?? 0}`,
        ...s.accounts.map((a, i) => `${i + 1}. ${a.email || "(no email)"}${a.lastUsed ? ` lastUsed=${new Date(a.lastUsed).toLocaleString()}` : ""}`),
      ].join("\n") || "No accounts imported", "info");
    },
  });
  pi.registerCommand("antigravity-quota", {
    description: "Check Antigravity and Gemini CLI quotas for all accounts",
    handler: async (_args, ctx) => {
      const s = await readAccounts();
      if (!s.accounts.length) {
        ctx.ui.notify("No accounts imported. Run /login antigravity or /antigravity-import-opencode.", "warning");
        return;
      }
      ctx.ui.notify("Fetching quota status from Google API...", "info");
      
      try {
        const results = await checkAccountsQuota(s.accounts, undefined);
        const outputLines: string[] = ["=== ANTIGRAVITY QUOTA STATUS ==="];
        
        function makeBar(frac?: number) {
          if (frac === undefined) return "[░░░░░░░░░░] N/A";
          const filled = Math.round(frac * 10);
          return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${Math.round(frac * 100)}%`;
        }
        
        function formatReset(resetTime?: string) {
          if (!resetTime) return "";
          const ms = Date.parse(resetTime) - Date.now();
          if (ms <= 0) return " (resetting now)";
          const mins = Math.ceil(ms / 60000);
          if (mins < 60) return ` (reset in ${mins}m)`;
          const hours = Math.floor(mins / 60);
          const remMins = mins % 60;
          return ` (reset in ${hours}h ${remMins}m)`;
        }

        const families = ["claude", "gemini-flash", "gemini-pro"];
        const familyAggregates: Record<string, { healthy: number, maxFrac: number }> = {
          claude: { healthy: 0, maxFrac: 0 },
          "gemini-flash": { healthy: 0, maxFrac: 0 },
          "gemini-pro": { healthy: 0, maxFrac: 0 }
        };

        for (const r of results) {
          outputLines.push("");
          const emailStr = r.email || `Account ${r.index + 1}`;
          const activeStr = s.activeIndex === r.index ? " ★ ACTIVE" : "";
          const statusStr = r.disabled ? " (DISABLED)" : "";
          outputLines.push(`• ${emailStr}${activeStr}${statusStr}`);
          
          if (r.status === "error") {
            outputLines.push(`  Error: ${r.error || "Unknown authentication error"}`);
            continue;
          }
          
          outputLines.push("  [Antigravity Quotas]");
          const groups = r.quota?.groups || {};
          for (const f of families) {
            const group = groups[f];
            const frac = group?.remainingFraction;
            outputLines.push(`    - ${f.toUpperCase().padEnd(12)}: ${makeBar(frac)}${formatReset(group?.resetTime)}`);
            if (frac !== undefined) {
              if (frac > 0) familyAggregates[f].healthy += 1;
              familyAggregates[f].maxFrac = Math.max(familyAggregates[f].maxFrac, frac);
            }
          }
          
        }
        
        outputLines.push("");
        outputLines.push("=== POOL SUMMARY ===");
        const activeAccountsCount = s.accounts.filter(a => a.enabled !== false).length;
        outputLines.push(`Total Accounts: ${s.accounts.length} (${activeAccountsCount} enabled)`);
        for (const f of families) {
          const agg = familyAggregates[f];
          outputLines.push(`• ${f.toUpperCase().padEnd(12)}: ${agg.healthy}/${s.accounts.length} healthy accounts (Max ${Math.round(agg.maxFrac * 100)}% remaining)`);
        }
        
        ctx.ui.notify(outputLines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Failed to fetch quotas: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
  pi.registerCommand("antigravity-config", {
    description: "Show or set Antigravity config. Usage: /antigravity-config key=value ...",
    getArgumentCompletions: (argumentPrefix: string) => {
      const keys = ["strategy", "rotate", "quiet", "cooldown"];
      const keyValues: Record<string, string[]> = {
        strategy: ["round-robin", "random", "sticky"],
        rotate: ["true", "false"],
        quiet: ["true", "false"],
        cooldown: ["1000", "2000", "5000", "10000", "30000"],
      };

      const parts = argumentPrefix.split(/\s+/);
      const activePart = parts[parts.length - 1] ?? "";
      const previousParts = parts.slice(0, parts.length - 1);
      const prefixStr = previousParts.length > 0 ? previousParts.join(" ") + " " : "";

      if (activePart.includes("=")) {
        const [key, val] = activePart.split("=");
        if (keys.includes(key)) {
          const possibleValues = keyValues[key] || [];
          const filtered = possibleValues.filter(v => v.startsWith(val));
          if (filtered.length > 0) {
            return filtered.map(v => ({
              value: `${prefixStr}${key}=${v} `,
              label: `${key}=${v}`,
              description: `Set ${key} to ${v}`,
            }));
          }
        }
        return null;
      } else {
        const completedKeys = previousParts.map(p => p.split("=")[0]);
        const availableKeys = keys.filter(k => !completedKeys.includes(k));
        const filteredKeys = availableKeys.filter(k => k.startsWith(activePart));
        if (filteredKeys.length > 0) {
          return filteredKeys.map(k => ({
            value: `${prefixStr}${k}=`,
            label: `${k}=`,
            description: `Configure ${k}`,
          }));
        }
        return null;
      }
    },
    handler: async (args, ctx) => {
      const config = await readConfig();
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          `Antigravity Configuration:\n` +
          `• strategy: ${config.accountSelectionStrategy} (round-robin | random | sticky)\n` +
          `• rotate: ${config.rotateAccounts} (true | false)\n` +
          `• quiet: ${config.quiet} (true | false)\n` +
          `• cooldown: ${config.initialCooldownMs} ms\n\n` +
          `Saved in: ${CONFIG_PATH}\n` +
          `To modify, use: /antigravity-config <option>=<value>\n` +
          `Example: /antigravity-config strategy=sticky rotate=false cooldown=2000`,
          "info"
        );
        return;
      }
      for (const part of trimmed.split(/\s+/)) {
        const [rawKey, rawValue] = part.split("=");
        const value = rawValue?.trim();
        if (!rawKey || value === undefined) continue;
        const key = CONFIG_MAPPING[rawKey];
        if (!key) {
          ctx.ui.notify(`Unknown/invalid config option: ${part}`, "warning");
          continue;
        }
        if (key === "accountSelectionStrategy" && ["round-robin", "random", "sticky"].includes(value)) config.accountSelectionStrategy = value as any;
        else if (key === "rotateAccounts") config.rotateAccounts = /^(1|true|yes|on)$/i.test(value);
        else if (key === "quiet") config.quiet = /^(1|true|yes|on)$/i.test(value);
        else if (key === "initialCooldownMs") {
          const parsed = parseInt(value, 10);
          if (!isNaN(parsed) && parsed > 0) config.initialCooldownMs = parsed;
          else ctx.ui.notify(`Invalid value for cooldown: ${value}`, "warning");
        }
        else ctx.ui.notify(`Invalid value for ${rawKey}: ${value}`, "warning");
      }
      await writeConfig(config);
      ctx.ui.notify(
        `Antigravity Configuration Saved:\n` +
        `• strategy: ${config.accountSelectionStrategy}\n` +
        `• rotate: ${config.rotateAccounts}\n` +
        `• quiet: ${config.quiet}\n` +
        `• cooldown: ${config.initialCooldownMs} ms`,
        "info"
      );
    },
  });
  pi.registerCommand("antigravity-switch", {
    description: "Switch the active Antigravity account. Usage: /antigravity-switch <index_or_email>",
    getArgumentCompletions: async (argumentPrefix: string) => {
      const s = await readAccounts();
      const options = s.accounts.map((a, i) => ({
        value: a.email || String(i + 1),
        label: a.email || `Account ${i + 1}`,
        description: `Switch to ${a.email || `Account ${i + 1}`}`,
      }));
      return options.filter(o => o.value.startsWith(argumentPrefix));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Please specify an account email or index to switch to. Example: /antigravity-switch 1", "warning");
        return;
      }
      await mutateAccounts((s) => {
        let index = -1;
        const parsedIndex = parseInt(trimmed, 10);
        if (!isNaN(parsedIndex)) {
          index = parsedIndex - 1;
        } else {
          index = s.accounts.findIndex(a => a.email === trimmed);
        }
        if (index < 0 || index >= s.accounts.length) {
          throw new Error(`Account "${trimmed}" not found.`);
        }
        s.activeIndex = index;
        s.activeIndexByFamily = { claude: index, gemini: index };
      });
      const s = await readAccounts();
      const activeAccount = s.accounts[s.activeIndex ?? 0];
      ctx.ui.notify(`Successfully switched active account to: ${activeAccount?.email || `Account ${(s.activeIndex ?? 0) + 1}`}`, "info");
    }
  });
}

export {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  SCOPES,
  ACCOUNTS_PATH,
  CONFIG_PATH,
  DEFAULT_PROJECT_ID,
  ENDPOINTS,
  readAccounts,
  writeAccounts,
  mutateAccounts,
  readConfig,
  writeConfig,
  isGeminiModel,
  quotaStylesFor,
  endpointsFor,
  headersFor,
  accountOrder,
  markAccountSuccess,
  markAccountFailure,
  refreshAccess,
  doRefresh,
  effectiveProject,
  resolveActualModel,
  patchedEffectiveModel,
  patchPreparedModel,
  thinkingConfig,
  buildRequestBody,
  sanitizeSchemaForAntigravity,
  normalizeAntigravityUserAgent
};
