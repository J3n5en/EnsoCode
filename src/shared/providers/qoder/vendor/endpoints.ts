import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildAuthHeaders } from "./cosy.js";
import { qoderDecodeBody } from "./protocol/encoding.js";
import {
  getQoderBaseUrl,
  getQoderChatBaseUrl,
  getQoderRegionConfig,
  type QoderMode,
  setQoderChatBaseUrl,
} from "./region.js";

/**
 * Qoder publishes its node map per account at `region/endpoints`. The response
 * is encoded with the same custom Base64 scheme as request bodies.
 *
 * The map exposes several classes of node:
 * - `inferNodes`: model inference (the catalog lives here);
 * - `dataNodeMap.remote_agent`: remote agent sessions, i.e. agent chat;
 * - `security`: codebase/security workloads.
 *
 * The official CLI drives agent chat against the remote-agent node, not the
 * inference node. Sending agent chat to `inferNodes` gets
 * `403 code 110 "Billing daily count exceeded"` for accounts whose daily chat
 * allowance is tracked per node, even while the same account succeeds through
 * the CLI. Keep the inference node for the catalog and prefer the remote-agent
 * node for chat, falling back through the remaining candidates.
 */
export interface QoderRegionEndpoints {
  inferNodes: string[];
  remoteAgentNodes: string[];
  securityNodes: string[];
  centerNodes: string[];
}

export interface QoderEndpointCredentials {
  userID: string;
  authToken: string;
  name?: string;
  email?: string;
  machineID?: string;
}

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  chatBaseUrl: string;
  updatedAt: number;
}

interface CacheFile {
  version: number;
  modes: Record<string, CacheEntry>;
}

const discovered = new Map<QoderMode, { at: number; endpoints: QoderRegionEndpoints }>();

function getHomeDir(): string {
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("PI_CODING_AGENT_DIR is required for Qoder");
  return process.env.PI_CODING_AGENT_DIR;
}

function getCachePath(): string {
  // Overridable so tests never touch the user's real cache file: the cache
  // tests and the stream tests otherwise race on it when run in parallel.
  return join(getHomeDir(), "qoder-endpoints-cache.json");
}

function normalizeBaseUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = normalizeBaseUrl(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function parseQoderRegionEndpoints(payload: unknown): QoderRegionEndpoints | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const dataNodes = asRecord(root.dataNodeMap) ?? {};
  const endpoints: QoderRegionEndpoints = {
    inferNodes: stringArray(root.inferNodes),
    remoteAgentNodes: stringArray(dataNodes.remote_agent),
    securityNodes: stringArray(root.security),
    centerNodes: stringArray(root.centerNodes),
  };
  if (
    endpoints.inferNodes.length === 0 &&
    endpoints.remoteAgentNodes.length === 0 &&
    endpoints.securityNodes.length === 0
  ) {
    return undefined;
  }
  return endpoints;
}

/**
 * Ordered, de-duplicated node candidates for chat. The current/default node
 * stays first so callers can skip it while rotating; the remote-agent node is
 * preferred over the inference node because it is what the CLI uses.
 */
export function chatEndpointCandidates(endpoints: QoderRegionEndpoints | undefined, fallback: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (url: string | undefined) => {
    if (!url) return;
    const normalized = normalizeBaseUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  push(fallback);
  for (const url of endpoints?.remoteAgentNodes ?? []) push(url);
  for (const url of endpoints?.inferNodes ?? []) push(url);
  for (const url of endpoints?.securityNodes ?? []) push(url);
  return out;
}

function readCacheFile(): CacheFile {
  const path = getCachePath();
  if (!existsSync(path)) return { version: CACHE_VERSION, modes: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    const modes = asRecord(parsed.modes) ?? {};
    const clean: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(modes)) {
      const entry = asRecord(value);
      if (!entry) continue;
      const chatBaseUrl = typeof entry.chatBaseUrl === "string" ? normalizeBaseUrl(entry.chatBaseUrl) : undefined;
      const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
      if (chatBaseUrl) clean[key] = { chatBaseUrl, updatedAt };
    }
    return { version: CACHE_VERSION, modes: clean };
  } catch {
    return { version: CACHE_VERSION, modes: {} };
  }
}

function writeCacheFile(file: CacheFile): void {
  const path = getCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...file, version: CACHE_VERSION }, null, 2), { encoding: "utf8", mode: 384 });
  } catch {
    // Cache is best-effort; a read-only HOME must not break chat.
  }
}

/** A cached chat node younger than one hour, if any. */
export function getCachedChatBaseUrl(mode: QoderMode, now = Date.now()): string | undefined {
  const entry = readCacheFile().modes[mode];
  if (!entry) return undefined;
  if (now - entry.updatedAt > CACHE_TTL_MS) return undefined;
  return entry.chatBaseUrl;
}

/** Persist the node that just served a request, so the next start skips discovery. */
export function rememberChatBaseUrl(mode: QoderMode, chatBaseUrl: string, now = Date.now()): void {
  const normalized = normalizeBaseUrl(chatBaseUrl);
  if (!normalized) return;
  const file = readCacheFile();
  file.modes[mode] = { chatBaseUrl: normalized, updatedAt: now };
  writeCacheFile(file);
}

/** Apply the persisted chat node for this start, if it is still fresh. */
export function applyCachedChatEndpoint(mode: QoderMode): string | undefined {
  const cached = getCachedChatBaseUrl(mode);
  if (!cached) return undefined;
  setQoderChatBaseUrl(mode, cached);
  return cached;
}

export function clearQoderEndpointsCache(): void {
  discovered.clear();
  try {
    const path = getCachePath();
    if (existsSync(path)) writeFileSync(path, JSON.stringify({ version: CACHE_VERSION, modes: {} }), "utf8");
  } catch {
    // Ignore: tests and read-only environments.
  }
}

function getRegionEndpointsURL(mode: QoderMode): string {
  return `${getQoderRegionConfig(mode).centerUrl}/algo/api/v3/service/region/endpoints`;
}

export async function fetchQoderRegionEndpoints(
  mode: QoderMode,
  credentials: QoderEndpointCredentials,
): Promise<QoderRegionEndpoints | undefined> {
  const url = getRegionEndpointsURL(mode);
  try {
    const headers = buildAuthHeaders(null, url, {
      userID: credentials.userID,
      authToken: credentials.authToken,
      name: credentials.name ?? "",
      email: credentials.email ?? "",
      machineID: credentials.machineID,
    });
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = JSON.parse(qoderDecodeBody(text));
    }
    return parseQoderRegionEndpoints(payload);
  } catch {
    return undefined;
  }
}

async function getRegionEndpoints(
  mode: QoderMode,
  credentials: QoderEndpointCredentials,
): Promise<QoderRegionEndpoints | undefined> {
  const cached = discovered.get(mode);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.endpoints;
  const endpoints = await fetchQoderRegionEndpoints(mode, credentials);
  if (!endpoints) return cached?.endpoints;
  discovered.set(mode, { at: Date.now(), endpoints });
  return endpoints;
}

/**
 * Resolve the chat node at startup: prefer the remote-agent node, persist it,
 * and keep the current node when discovery fails.
 */
export async function refreshChatEndpoint(
  mode: QoderMode,
  credentials: QoderEndpointCredentials | undefined,
): Promise<string | undefined> {
  if (!credentials?.authToken) return undefined;
  const endpoints = await getRegionEndpoints(mode, credentials);
  if (!endpoints) return undefined;
  const candidates = chatEndpointCandidates(endpoints, getQoderBaseUrl(mode));
  const preferred = candidates.find((url) => endpoints.remoteAgentNodes.includes(url)) ?? candidates[0];
  if (!preferred) return undefined;
  setQoderChatBaseUrl(mode, preferred);
  rememberChatBaseUrl(mode, preferred);
  return preferred;
}

/**
 * Switch chat to the next untried node. `attempted` is owned by the caller so a
 * stream that keeps hitting the daily-limit rejection walks the candidate list
 * once instead of looping on the same node.
 */
export async function rotateChatEndpoint(
  mode: QoderMode,
  credentials: QoderEndpointCredentials | undefined,
  attempted: Set<string>,
): Promise<string | undefined> {
  const current = normalizeBaseUrl(getQoderChatBaseUrl(mode));
  if (current) attempted.add(current);

  const endpoints = credentials ? await getRegionEndpoints(mode, credentials) : undefined;
  const candidates = chatEndpointCandidates(endpoints, getQoderBaseUrl(mode));
  const next = candidates.find((url) => !attempted.has(url));
  if (!next) return undefined;

  attempted.add(next);
  setQoderChatBaseUrl(mode, next);
  return next;
}
