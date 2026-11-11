import { createPublicKey, verify } from 'node:crypto';
import {
  enginesAllow,
  isNewerPluginVersion,
  isPluginId,
  isPluginRelativePath,
} from '@shared/extensionPlugins/manifest';
import {
  isMarketCategory,
  MAX_MARKET_SCREENSHOTS,
  type MarketCategory,
  type MarketScreenshot,
} from '@shared/extensionPlugins/marketCategories';

export type MarketTier = 'official' | 'community';

export interface MarketVersion {
  version: string;
  permissions: string[];
  path: string;
  sha256: string;
  size: number;
  publishedAt?: string;
}

export interface MarketPlugin {
  id: string;
  name: string;
  description: string;
  tier: MarketTier;
  tags: string[];
  homepage?: string;
  icon?: string;
  category?: MarketCategory;
  /** 只收 https；客户端再转成 Worker 代理地址 */
  screenshots?: MarketScreenshot[];
  readme?: { path: string; sha256: string; size: number };
  /** 宿主可用版本中 semver 最大者 */
  latest: string;
  versions: MarketVersion[];
}

export interface MarketIndex {
  sequence: number;
  generatedAt: string;
  plugins: MarketPlugin[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => str(s, max)) : [];
const optStr = (v: unknown, max: number) => (str(v, max) ? v : undefined);
const README_MAX_BYTES = 256 * 1024;

function parseScreenshots(raw: unknown): MarketScreenshot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const shots: MarketScreenshot[] = [];
  for (const item of raw) {
    if (shots.length >= MAX_MARKET_SCREENSHOTS) break;
    if (!isRecord(item) || !str(item.url, 1000) || !item.url.startsWith('https://')) continue;
    shots.push({ url: item.url, alt: typeof item.alt === 'string' ? item.alt.slice(0, 200) : '' });
  }
  return shots.length > 0 ? shots : undefined;
}

function parseReadme(raw: unknown): MarketPlugin['readme'] {
  if (!isRecord(raw)) return undefined;
  if (!isPluginRelativePath(raw.path) || !/^[A-Za-z0-9._/-]+$/.test(raw.path)) return undefined;
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) return undefined;
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) <= 0) return undefined;
  if ((raw.size as number) > README_MAX_BYTES) return undefined;
  return { path: raw.path, sha256: raw.sha256, size: raw.size as number };
}

function parseVersion(raw: unknown, hostVersion: string): MarketVersion | null {
  if (!isRecord(raw) || !str(raw.version, 40)) return null;
  if (!isPluginRelativePath(raw.path) || !/^[A-Za-z0-9._/-]+$/.test(raw.path)) return null;
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) return null;
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) <= 0) return null;
  if (raw.engines !== undefined) {
    if (!isRecord(raw.engines) || !enginesAllow(raw.engines.enso, hostVersion)) return null;
  }
  return {
    version: raw.version,
    permissions: strings(raw.permissions, 64),
    path: raw.path,
    sha256: raw.sha256,
    size: raw.size as number,
    publishedAt: optStr(raw.publishedAt, 40),
  };
}

function parsePlugin(raw: unknown, hostVersion: string): MarketPlugin | null {
  if (!isRecord(raw) || !isPluginId(raw.id) || !str(raw.name, 60)) return null;
  if (raw.tier !== 'official' && raw.tier !== 'community') return null;
  if (!Array.isArray(raw.versions)) return null;
  const versions = raw.versions
    .map((v) => parseVersion(v, hostVersion))
    .filter((v): v is MarketVersion => v !== null);
  if (versions.length === 0) return null;
  const latest = versions.reduce((a, b) => (isNewerPluginVersion(b.version, a.version) ? b : a));
  const readme = parseReadme(raw.readme);
  const screenshots = parseScreenshots(raw.screenshots);
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : '',
    tier: raw.tier,
    tags: strings(raw.tags, 32),
    homepage: optStr(raw.homepage, 500),
    icon: optStr(raw.icon, 500),
    ...(isMarketCategory(raw.category) ? { category: raw.category } : {}),
    ...(screenshots ? { screenshots } : {}),
    ...(readme ? { readme } : {}),
    latest: latest.version,
    versions,
  };
}

/** 结构校验；单个条目不合法只丢弃该条，顶层不合法返回 null */
export function parseMarketIndex(raw: unknown, hostVersion: string): MarketIndex | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.plugins)) return null;
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0) return null;
  const seen = new Set<string>();
  const plugins: MarketPlugin[] = [];
  for (const item of raw.plugins) {
    const p = parsePlugin(item, hostVersion);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    plugins.push(p);
  }
  return {
    sequence: raw.sequence as number,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    plugins,
  };
}

export interface LoadMarketIndexInput {
  bytes: Uint8Array;
  /** base64 的 Ed25519 签名 */
  signature: string;
  /** SPKI PEM，任一通过即可 */
  publicKeys: string[];
  /** 已见过的最大 sequence，更小的索引视为回滚 */
  minSequence: number;
  hostVersion: string;
}

export type LoadMarketIndexResult = { ok: true; index: MarketIndex } | { ok: false; error: string };

function signatureValid(bytes: Uint8Array, signature: string, publicKeys: string[]): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const sig = Buffer.from(signature, 'base64');
  return publicKeys.some((pem) => {
    try {
      return verify(null, bytes, createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
}

export function loadMarketIndex(input: LoadMarketIndexInput): LoadMarketIndexResult {
  if (!signatureValid(input.bytes, input.signature.trim(), input.publicKeys))
    return { ok: false, error: '插件索引签名无效' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.bytes).toString('utf8'));
  } catch {
    return { ok: false, error: '插件索引不是合法 JSON' };
  }
  const index = parseMarketIndex(raw, input.hostVersion);
  if (!index) return { ok: false, error: '插件索引格式不支持' };
  if (index.sequence < input.minSequence) return { ok: false, error: '插件索引比本地已有的旧' };
  return { ok: true, index };
}
