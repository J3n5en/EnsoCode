import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ArchiveFetch, downloadPluginArchive } from './download';
import { loadMarketIndex, type MarketIndex } from './marketIndex';

const MARKET_REPO = 'J3n5en/enso-plugins';
const MARKET_WORKER = 'https://enso-plugins.j3.do/v1/';
/** 官方索引签名公钥（SPKI PEM），可放多把用于轮换 */
const MARKET_PUBLIC_KEYS: string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQSeCYY0a9xjVf7jexky3WYRdSHbUQNhPqtCuX8LmknA=
-----END PUBLIC KEY-----`,
];

const INDEX_MAX_BYTES = 8 * 1024 * 1024;
const PACKAGE_MAX_BYTES = 200 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 10_000;
const PACKAGE_TIMEOUT_MS = 120_000;

export type MarketFetch = ArchiveFetch;

/** Worker 始终第一；国内镜像开启时 jsDelivr 先于 GitHub */
export function marketSources(chinaMirror: boolean): string[] {
  const jsdelivr = `https://cdn.jsdelivr.net/gh/${MARKET_REPO}@dist/v1/`;
  const github = `https://raw.githubusercontent.com/${MARKET_REPO}/dist/v1/`;
  return [MARKET_WORKER, ...(chinaMirror ? [jsdelivr, github] : [github, jsdelivr])];
}

export function marketPublicKeys(env: NodeJS.ProcessEnv): string[] {
  const extra = env.ENSO_PLUGIN_MARKET_KEY?.replace(/\\n/g, '\n').trim();
  return extra ? [...MARKET_PUBLIC_KEYS, extra] : MARKET_PUBLIC_KEYS;
}

export function envMarketSources(env: NodeJS.ProcessEnv): string[] | null {
  const list = env.ENSO_PLUGIN_MARKET?.split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s))
    .map((s) => (s.endsWith('/') ? s : `${s}/`));
  return list && list.length > 0 ? list : null;
}

export interface PluginMarketOptions {
  /** 插件数据目录；市场状态放在 market/ 下 */
  root: string;
  fetch: MarketFetch;
  hostVersion: string;
  publicKeys: string[];
  sources?: (chinaMirror: boolean) => string[];
  /** 随安装包内置的已签名索引 */
  builtin?: { index: string; signature: string } | null;
}

export type MarketIndexResult =
  | { ok: true; index: MarketIndex; stale: boolean }
  | { ok: false; error: string };

interface MarketState {
  maxSequence: number;
  chinaMirror: boolean;
}

export class PluginMarket {
  private current: { index: MarketIndex; stale: boolean } | null = null;
  private loading: Promise<MarketIndexResult> | null = null;

  constructor(private readonly options: PluginMarketOptions) {}

  private get dir() {
    return join(this.options.root, 'market');
  }

  private readState(): MarketState {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')) as unknown;
      const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      return {
        maxSequence: Number.isSafeInteger(r.maxSequence) ? (r.maxSequence as number) : 0,
        chinaMirror: r.chinaMirror === true,
      };
    } catch {
      return { maxSequence: 0, chinaMirror: false };
    }
  }

  private writeState(patch: Partial<MarketState>) {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...this.readState(), ...patch }));
    renameSync(`${file}.tmp`, file);
  }

  chinaMirror(): boolean {
    return this.readState().chinaMirror;
  }

  setChinaMirror(on: boolean): void {
    this.writeState({ chinaMirror: on });
  }

  private sources(): string[] {
    return (this.options.sources ?? marketSources)(this.chinaMirror());
  }

  private verify(bytes: Uint8Array, signature: string, minSequence: number) {
    return loadMarketIndex({
      bytes,
      signature,
      publicKeys: this.options.publicKeys,
      minSequence,
      hostVersion: this.options.hostVersion,
    });
  }

  private async fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
    const tmp = join(this.dir, 'tmp', randomUUID());
    mkdirSync(join(this.dir, 'tmp'), { recursive: true });
    try {
      await downloadPluginArchive(new URL(url), tmp, {
        fetch: this.options.fetch,
        maxBytes,
        timeoutMs: SOURCE_TIMEOUT_MS,
      });
      return await readFile(tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** 远端依次尝试 → 磁盘缓存 → 内置索引；均需验签且不早于已见 sequence */
  index(options: { refresh?: boolean } = {}): Promise<MarketIndexResult> {
    if (this.current && !options.refresh) return Promise.resolve({ ok: true, ...this.current });
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<MarketIndexResult> {
    if (this.options.publicKeys.length === 0)
      return { ok: false, error: '插件市场尚未配置签名公钥' };
    const { maxSequence } = this.readState();
    let lastError = '无法连接插件市场';
    for (const base of this.sources()) {
      try {
        const [bytes, sig] = await Promise.all([
          this.fetchBytes(`${base}index.json`, INDEX_MAX_BYTES),
          this.fetchBytes(`${base}index.json.sig`, 4096),
        ]);
        const r = this.verify(bytes, sig.toString('utf8'), maxSequence);
        if (!r.ok) {
          lastError = r.error;
          continue;
        }
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, 'index.json'), bytes);
        writeFileSync(join(this.dir, 'index.json.sig'), sig);
        this.writeState({ maxSequence: r.index.sequence });
        this.current = { index: r.index, stale: false };
        return { ok: true, ...this.current };
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
    }
    const fallback = this.offline(maxSequence);
    if (fallback) {
      this.current = { index: fallback, stale: true };
      return { ok: true, ...this.current };
    }
    return { ok: false, error: lastError };
  }

  private offline(maxSequence: number): MarketIndex | null {
    const candidates: MarketIndex[] = [];
    try {
      const r = this.verify(
        readFileSync(join(this.dir, 'index.json')),
        readFileSync(join(this.dir, 'index.json.sig'), 'utf8'),
        maxSequence
      );
      if (r.ok) candidates.push(r.index);
    } catch {}
    const { builtin } = this.options;
    if (builtin) {
      const r = this.verify(Buffer.from(builtin.index), builtin.signature, maxSequence);
      if (r.ok) candidates.push(r.index);
    }
    return candidates.sort((a, b) => b.sequence - a.sequence)[0] ?? null;
  }

  /** 下载到 dest 并校验 sha256；某个源的包不符就换下一个源 */
  async download(
    id: string,
    version: string | undefined,
    dest: string
  ): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    const r = await this.index();
    if (!r.ok) return r;
    const plugin = r.index.plugins.find((p) => p.id === id);
    if (!plugin) return { ok: false, error: `插件市场里没有 ${id}` };
    const entry = plugin.versions.find((v) => v.version === (version ?? plugin.latest));
    if (!entry) return { ok: false, error: `${id} 没有可安装的版本 ${version ?? ''}`.trim() };
    let lastError = '无法下载插件';
    for (const base of this.sources()) {
      try {
        await downloadPluginArchive(new URL(entry.path, base), dest, {
          fetch: this.options.fetch,
          maxBytes: Math.min(entry.size, PACKAGE_MAX_BYTES),
          timeoutMs: PACKAGE_TIMEOUT_MS,
        });
        if ((await sha256File(dest)) === entry.sha256) return { ok: true, version: entry.version };
        lastError = '插件包校验失败';
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
      rmSync(dest, { force: true });
    }
    return { ok: false, error: lastError };
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
