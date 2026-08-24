import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelApiKind, ModelEntry, ScanAppId } from '@shared/types';
import { parse as parseYaml } from 'yaml';

/** 扫描到的原始 provider（含明文 apiKey，仅存于主进程） */
export interface DiscoveredProvider {
  appId: ScanAppId;
  name: string;
  api: ModelApiKind;
  apiKey: string;
  baseUrl: string;
  models: ModelEntry[];
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** 归一化各来源的协议标识到 pi sdk 的 Api 类型 */
export function toApiKind(rawType: string, baseUrl = ''): ModelApiKind {
  const type = rawType
    .trim()
    .toLowerCase()
    .replace(/[_\s.]+/g, '-');
  const url = baseUrl.toLowerCase();

  if (
    /^(anthropic|claude)/.test(type) ||
    type.includes('anthropic-messages') ||
    url.includes('api.anthropic.com')
  ) {
    return 'anthropic-messages';
  }
  if (
    /^gemini/.test(type) ||
    type.includes('google-generative-ai') ||
    url.includes('generativelanguage.googleapis.com')
  ) {
    return 'google-generative-ai';
  }
  if (type === 'ollama' || url.includes(':11434')) {
    return 'ollama';
  }
  if (/responses?$/.test(type)) {
    return 'openai-responses';
  }
  return 'openai-completions';
}

/** 模型列表：兼容 字符串数组 / 对象数组 / id→meta 映射 三种形态 */
export function toModelEntries(models: unknown): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const push = (id: string, label?: string) => {
    const trimmed = id.trim();
    if (trimmed && !entries.some((entry) => entry.id === trimmed)) {
      entries.push({ id: trimmed, ...(label && label !== trimmed ? { label } : {}) });
    }
  };

  if (Array.isArray(models)) {
    for (const model of models) {
      if (typeof model === 'string') {
        push(model);
      } else {
        const item = obj(model);
        push(str(item.id ?? item.name ?? item.model), str(item.name));
      }
    }
  } else if (models && typeof models === 'object') {
    for (const [id, meta] of Object.entries(models)) {
      push(id, str(obj(meta).name ?? obj(meta).label));
    }
  }
  return entries;
}

async function openSqlite(dbPath: string) {
  const { default: Database } = await import('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

// ---- Alma: sqlite providers 表 ----

export async function readAlma(dbPath: string): Promise<DiscoveredProvider[]> {
  const db = await openSqlite(dbPath);
  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .get();
    if (!hasTable) return [];

    const rows = db
      .prepare(
        "SELECT name, type, api_key, base_url, api_format, models, available_models FROM providers WHERE type != 'acp'"
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => {
      const models = toModelEntries(parseJson(row.models));
      return {
        appId: 'alma',
        name: str(row.name) || 'Alma Provider',
        api: toApiKind(str(row.api_format) || str(row.type), str(row.base_url)),
        apiKey: str(row.api_key),
        baseUrl: str(row.base_url),
        models: models.length > 0 ? models : toModelEntries(parseJson(row.available_models)),
      };
    });
  } finally {
    db.close();
  }
}

// ---- CC Switch: sqlite providers 表，settings_config 按 app_type 解析 ----

type CcParsed = { apiKey: string; baseUrl: string; api: ModelApiKind; models: ModelEntry[] };

function parseCcSwitchConfig(appType: string, config: Record<string, unknown>): CcParsed | null {
  switch (appType) {
    case 'claude':
    case 'claude-desktop': {
      const env = obj(config.env);
      const modelIds = [
        str(env.ANTHROPIC_MODEL),
        str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
        str(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
        str(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      ].filter(Boolean);
      return {
        apiKey: str(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
        baseUrl: str(env.ANTHROPIC_BASE_URL),
        api: 'anthropic-messages',
        models: toModelEntries(modelIds),
      };
    }
    case 'gemini': {
      const env = obj(config.env);
      const model = str(env.GEMINI_MODEL);
      return {
        apiKey: str(env.GEMINI_API_KEY),
        baseUrl: str(env.GOOGLE_GEMINI_BASE_URL),
        api: 'google-generative-ai',
        models: toModelEntries(model ? [model] : []),
      };
    }
    case 'opencode': {
      const options = obj(config.options);
      return {
        apiKey: str(options.apiKey),
        baseUrl: str(options.baseURL),
        api: toApiKind(str(config.npm), str(options.baseURL)),
        models: toModelEntries(config.models),
      };
    }
    case 'openclaw':
      return {
        apiKey: str(config.apiKey),
        baseUrl: str(config.baseUrl),
        api: toApiKind(str(config.api), str(config.baseUrl)),
        models: toModelEntries(config.models),
      };
    case 'hermes':
      return {
        apiKey: str(config.api_key),
        baseUrl: str(config.base_url),
        api: toApiKind(str(config.api_mode), str(config.base_url)),
        models: toModelEntries(config.models),
      };
    default:
      return null;
  }
}

export async function readCcSwitch(dbPath: string): Promise<DiscoveredProvider[]> {
  const db = await openSqlite(dbPath);
  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .get();
    if (!hasTable) return [];

    const rows = db
      .prepare('SELECT app_type, name, settings_config FROM providers')
      .all() as Record<string, unknown>[];

    return rows.flatMap((row) => {
      const appType = str(row.app_type).toLowerCase();
      const config = obj(parseJson(row.settings_config));
      const parsed = parseCcSwitchConfig(appType, config);
      if (!parsed) return [];
      return [
        {
          appId: 'cc-switch' as const,
          name: str(row.name) || `${appType} provider`,
          ...parsed,
        },
      ];
    });
  } finally {
    db.close();
  }
}

// ---- Cherry Studio: leveldb 中 persist:cherry-studio 的 llm.providers ----

function decodeLevelValue(value: Buffer): Record<string, unknown> | null {
  // Local Storage 的 value 以 UTF-16/带控制字节存储，剔除 0 字节后按 UTF-8 解析
  const bytes = Array.from(value).filter((byte) => byte !== 0);
  let text = '';
  for (const char of Buffer.from(bytes).toString('utf8')) {
    const code = char.codePointAt(0) ?? 0;
    text += code < 32 && code !== 9 && code !== 10 && code !== 13 ? ' ' : char;
  }
  return obj(parseJson(text.trim())) || null;
}

export async function readCherryStudio(leveldbDir: string): Promise<DiscoveredProvider[]> {
  // leveldb 可能被运行中的 Cherry Studio 锁定，拷贝快照后读取
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-provider-scan-'));
  try {
    fs.cpSync(leveldbDir, snapshot, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'LOCK',
    });

    const { Level } = await import('level');
    const db = new Level<Buffer, Buffer>(snapshot, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
    });

    try {
      await db.open();
      for await (const [key, value] of db.iterator()) {
        if (!key.toString('utf8').includes('persist:cherry-studio')) continue;

        const root = decodeLevelValue(value);
        const llm = obj(parseJson(root?.llm));
        const providers = Array.isArray(llm.providers) ? llm.providers : [];
        return providers.flatMap((provider) => {
          const item = obj(provider);
          const name = str(item.name ?? item.id);
          if (!name) return [];
          return [
            {
              appId: 'cherry-studio' as const,
              name,
              api: toApiKind(str(item.type || item.id), str(item.apiHost)),
              apiKey: str(item.apiKey),
              baseUrl: str(item.apiHost || item.baseUrl),
              models: toModelEntries(item.models),
            },
          ];
        });
      }
      return [];
    } finally {
      await db.close().catch(() => {});
    }
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

// ---- Hermes / OpenClaw: yaml provider 列表 ----

function readYamlProviders(appId: ScanAppId, providers: unknown[]): DiscoveredProvider[] {
  return providers.flatMap((provider) => {
    const item = obj(provider);
    const name = str(item.name ?? item.id);
    if (!name) return [];
    const baseUrl = str(item.apiHost || item.baseUrl || item.base_url);
    return [
      {
        appId,
        name,
        api: toApiKind(str(item.type), baseUrl),
        apiKey: str(item.apiKey || item.api_key),
        baseUrl,
        models: toModelEntries(item.models),
      },
    ];
  });
}

export function readHermes(configPath: string): DiscoveredProvider[] {
  const config = parseYaml(fs.readFileSync(configPath, 'utf8'));
  const providers = config?.llm?.providers;
  return readYamlProviders('hermes', Array.isArray(providers) ? providers : []);
}

export function readOpenClaw(configPath: string): DiscoveredProvider[] {
  const config = parseYaml(fs.readFileSync(configPath, 'utf8'));
  const providers = config?.providers;
  return readYamlProviders('openclaw', Array.isArray(providers) ? providers : []);
}

// ---- Claude Code: ~/.claude/settings.json 的 env 变量（支持 _后缀 多套配置） ----

export function readClaudeCode(settingsPath: string): DiscoveredProvider[] {
  const settings = obj(parseJson(fs.readFileSync(settingsPath, 'utf8')));
  const env = obj(settings.env);

  const defaultModels = toModelEntries(
    [
      str(env.ANTHROPIC_MODEL),
      str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      str(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      str(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    ].filter(Boolean)
  );

  // 按 ANTHROPIC_AUTH_TOKEN[_suffix] 分组，配对同后缀的 ANTHROPIC_BASE_URL[_suffix]
  const providers: DiscoveredProvider[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = /^ANTHROPIC_AUTH_TOKEN(?:_(.+))?$/.exec(key);
    if (!match) continue;
    const suffix = match[1] ?? '';
    const apiKey = str(value);
    if (!apiKey) continue;

    const baseUrl = str(
      suffix ? (env[`ANTHROPIC_BASE_URL_${suffix}`] ?? '') : env.ANTHROPIC_BASE_URL
    );
    providers.push({
      appId: 'claude-code',
      name: suffix ? `Claude Code (${suffix})` : 'Claude Code',
      api: 'anthropic-messages',
      apiKey,
      baseUrl,
      models: suffix ? [] : defaultModels,
    });
  }

  // 仅配置了 ANTHROPIC_API_KEY 的情况
  if (!providers.some((provider) => provider.name === 'Claude Code')) {
    const apiKey = str(env.ANTHROPIC_API_KEY);
    if (apiKey) {
      providers.push({
        appId: 'claude-code',
        name: 'Claude Code',
        api: 'anthropic-messages',
        apiKey,
        baseUrl: str(env.ANTHROPIC_BASE_URL),
        models: defaultModels,
      });
    }
  }

  return providers;
}

// ---- Codex: ~/.codex/config.toml 的 model_providers + auth.json ----

export async function readCodex(configPath: string): Promise<DiscoveredProvider[]> {
  const { parse: parseToml } = await import('smol-toml');
  const config = obj(parseToml(fs.readFileSync(configPath, 'utf8')));

  let authKey = '';
  try {
    const auth = obj(
      parseJson(fs.readFileSync(path.join(path.dirname(configPath), 'auth.json'), 'utf8'))
    );
    authKey = str(auth.OPENAI_API_KEY);
  } catch {}

  const providers: DiscoveredProvider[] = [];
  for (const [providerId, entry] of Object.entries(obj(config.model_providers))) {
    const item = obj(entry);
    const envKey = str(item.env_key);
    const apiKey = (envKey && str(process.env[envKey])) || authKey;
    providers.push({
      appId: 'codex',
      name: str(item.name) || providerId,
      api: str(item.wire_api) === 'responses' ? 'openai-responses' : 'openai-completions',
      apiKey,
      baseUrl: str(item.base_url),
      models: toModelEntries(str(config.model) ? [str(config.model)] : []),
    });
  }

  // 没有自定义 provider 但已登录 API key：官方 OpenAI
  if (providers.length === 0 && authKey) {
    providers.push({
      appId: 'codex',
      name: 'OpenAI (Codex)',
      api: 'openai-responses',
      apiKey: authKey,
      baseUrl: '',
      models: toModelEntries(str(config.model) ? [str(config.model)] : []),
    });
  }

  return providers;
}

// ---- Grok CLI: ~/.grok/auth.json（仅 API key 登录模式可导入，OAuth session 无凭证） ----

export function readGrok(authPath: string): DiscoveredProvider[] {
  const auth = obj(parseJson(fs.readFileSync(authPath, 'utf8')));
  const apiKey = str(auth.apiKey ?? auth.api_key ?? auth.GROK_API_KEY);
  if (!apiKey) return [];
  return [
    {
      appId: 'grok',
      name: 'Grok',
      api: 'openai-completions',
      apiKey,
      baseUrl: 'https://api.x.ai/v1',
      models: [],
    },
  ];
}

// ---- Cursor: state.vscdb（sqlite）中 applicationUser 的自定义 OpenAI key ----

export async function readCursor(stateDbPath: string): Promise<DiscoveredProvider[]> {
  const db = await openSqlite(stateDbPath);
  try {
    const row = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'"
      )
      .get() as { value?: string } | undefined;
    if (!row?.value) return [];

    const state = obj(parseJson(row.value));
    const apiKey = str(state.openAIKey ?? state.openAIAPIKey);
    if (!apiKey) return [];

    return [
      {
        appId: 'cursor',
        name: 'Cursor (OpenAI Key)',
        api: 'openai-completions',
        apiKey,
        baseUrl: str(state.openAIBaseUrl),
        models: [],
      },
    ];
  } finally {
    db.close();
  }
}
