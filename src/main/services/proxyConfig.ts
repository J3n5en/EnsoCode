import {
  DEFAULT_NO_PROXY,
  isValidProxyUrl,
  mergeNoProxy,
  normalizeProxyMode,
  type ProxyEnvPatch,
  type ProxyMode,
  parseResolveProxy,
  proxyEnvPatch,
} from '@shared/proxy';
import { type Session, session } from 'electron';
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { sendAgentCommand } from './agentHost';

const FETCH_DISPATCHER_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;
const SYSTEM_PROBE_URL = 'https://www.google.com';

function installFetchDispatcher(proxyUrl: string | null, noProxy: string): void {
  if (proxyUrl) {
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: proxyUrl,
        noProxy,
        ...FETCH_DISPATCHER_TIMEOUTS,
      })
    );
    return;
  }
  setGlobalDispatcher(new Agent(FETCH_DISPATCHER_TIMEOUTS));
}

function applyEnv(patch: ProxyEnvPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

export class ProxyConfig {
  private mode: ProxyMode = 'system';
  private customProxyUrl = '';
  private proxyUrl: string | null = null;
  private resolutionPromise: Promise<boolean> = Promise.resolve(true);
  private readonly sessions = new Set<Session>();
  private readonly inheritedNoProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  private dispatcherInstalled = false;

  constructor(defaultSession?: Session) {
    if (defaultSession) this.sessions.add(defaultSession);
  }

  attachSession(target: Session): void {
    this.sessions.add(target);
    void this.applySessionRules(target);
  }

  whenReady(): Promise<boolean> {
    return this.resolutionPromise;
  }

  getProxyUrl(): string | null {
    return this.proxyUrl;
  }

  getProxyMode(): ProxyMode {
    return this.mode;
  }

  setProxyMode(mode: ProxyMode): void {
    this.mode = mode;
  }

  setCustomProxyUrl(url: string): void {
    if (isValidProxyUrl(url) || url.trim() === '') this.customProxyUrl = url.trim();
  }

  initFromConfig(mode: unknown, customUrl: unknown): void {
    this.mode = normalizeProxyMode(mode);
    if (typeof customUrl === 'string' && (isValidProxyUrl(customUrl) || customUrl.trim() === '')) {
      this.customProxyUrl = customUrl.trim();
    } else if (this.mode === 'custom') {
      this.mode = 'system';
    }
    this.ensureDispatcher();
    void this.resolveProxy();
  }

  resolveProxy(): Promise<boolean> {
    const mode = this.mode;
    const customProxyUrl = this.customProxyUrl;
    const resolution = this.resolutionPromise.then(
      () => this.resolveNow(mode, customProxyUrl),
      () => this.resolveNow(mode, customProxyUrl)
    );
    this.resolutionPromise = resolution;
    return resolution;
  }

  private ensureDispatcher(): void {
    if (this.dispatcherInstalled) return;
    installFetchDispatcher(null, '');
    this.dispatcherInstalled = true;
  }

  private async resolveNow(mode: ProxyMode, customProxyUrl: string): Promise<boolean> {
    try {
      this.ensureDispatcher();
      if (mode === 'none') {
        await this.applyDirect();
        return true;
      }
      if (mode === 'custom' && customProxyUrl) {
        await this.applyCustom(customProxyUrl);
        return true;
      }
      await this.setSessionProxy({ mode: 'system' });
      const probe = this.primarySession();
      const resolved = probe ? parseResolveProxy(await probe.resolveProxy(SYSTEM_PROBE_URL)) : null;
      if (resolved) {
        const noProxy = mergeNoProxy(DEFAULT_NO_PROXY, this.inheritedNoProxy);
        this.commitProxy(resolved, noProxy);
      } else {
        this.commitDirect();
      }
      return true;
    } catch (error) {
      console.error('[proxy] resolve failed', error);
      return false;
    }
  }

  private async applyDirect(): Promise<void> {
    await this.setSessionProxy({ mode: 'direct' });
    this.commitDirect();
  }

  private async applyCustom(proxyUrl: string): Promise<void> {
    await this.setSessionProxy({ proxyRules: proxyUrl });
    this.commitProxy(proxyUrl, mergeNoProxy(DEFAULT_NO_PROXY, this.inheritedNoProxy));
  }

  private commitProxy(proxyUrl: string, noProxy: string): void {
    this.proxyUrl = proxyUrl;
    const patch = proxyEnvPatch(proxyUrl, noProxy);
    applyEnv(patch);
    installFetchDispatcher(proxyUrl, noProxy);
    this.pushWorker(patch);
  }

  private commitDirect(): void {
    this.proxyUrl = null;
    const patch = proxyEnvPatch(null, '');
    applyEnv(patch);
    installFetchDispatcher(null, '');
    this.pushWorker(patch);
  }

  private pushWorker(env: ProxyEnvPatch): void {
    sendAgentCommand({ type: 'set-proxy-env', env });
  }

  private primarySession(): Session | undefined {
    return [...this.sessions][0];
  }

  private async setSessionProxy(config: Parameters<Session['setProxy']>[0]): Promise<void> {
    await Promise.all([...this.sessions].map((target) => target.setProxy(config)));
  }

  private async applySessionRules(target: Session): Promise<void> {
    if (this.mode === 'none') {
      await target.setProxy({ mode: 'direct' });
      return;
    }
    if (this.mode === 'custom' && this.customProxyUrl) {
      await target.setProxy({ proxyRules: this.customProxyUrl });
      return;
    }
    await target.setProxy({ mode: 'system' });
  }
}

let instance: ProxyConfig | null = null;

export function getProxyConfig(): ProxyConfig {
  instance ??= new ProxyConfig(session.defaultSession);
  return instance;
}
