import { APPROVAL_MODES, type ApprovalMode, THINKING_LEVELS } from '@shared/types/agent';
import { MODEL_API_KINDS, type ModelApiKind } from '@shared/types/llm';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const RUN_NETWORK_TOOLS = ['web', 'browser', 'image_generation'] as const;

const TOOL_ALIASES: Record<string, string> = {
  bash: 'bash',
  shell: 'bash',
  powershell: 'powershell',
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
  web: 'web',
  web_search: 'web',
  web_fetch: 'web',
  browser: 'browser',
  imagegen: 'image_generation',
  image_generation: 'image_generation',
  ask_user: 'ask_user',
  askuser: 'ask_user',
  goal: 'goal',
  goal_complete: 'goal',
  goal_blocked: 'goal',
  goal_wait: 'goal',
  memory: 'memory',
  computer: 'computer',
  subagent: 'subagent',
  workflow: 'workflow',
  todo: 'todo',
  plan: 'plan',
  background_tasks: 'background_tasks',
  isolated_sandbox: 'isolated_sandbox',
  workspace_write: 'workspace_write',
};

export interface RunArgs {
  prompt?: string;
  cwd: string;
  mode: ApprovalMode;
  goal?: string;
  autoTurns: number;
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: ModelApiKind;
  reasoningEffort?: string;
  timeoutMs?: number;
  outputFormat: OutputFormat;
  resume?: string;
  continue: boolean;
  disallowedTools: string[];
  allowTools: string[];
  usageLog?: string;
  dataDir?: string;
}

export type ParseResult =
  | { ok: true; args: RunArgs }
  | { ok: false; error: string; help?: boolean };

export const RUN_USAGE = `enso-server run — 无界面跑一轮真实 agent 会话

用法:
  enso-server run --prompt <文本|@文件|-> [选项]

选项:
  --cwd <dir>                 工作目录，默认当前目录
  --mode <mode>               supervised | auto-edits | full | assistant（默认 full）
  --target <text> | --goal <text>
                              以 /goal 自动续跑；可与 --prompt 同时给出
  --auto-turns <n>            goal 自动轮数上限，默认 25
  --provider <id>             供应商 id；新建时默认 enso-run
  --model <id>                模型 id
  --api <kind>                openai-completions | openai-responses | anthropic-messages
                              以及供应商层支持的其它协议
  --api-key <key>             API key（也可用环境变量，见下）
  --base-url <url>            模型端点，例如 https://host/v1
  --reasoning-effort <level>  off | minimal | low | medium | high | xhigh | max
  --timeout-ms <n>            整次运行的墙钟上限；超时退出 124
  --output-format <format>    text | json | stream-json（默认 text）
  --resume <session id>       恢复已有会话
  --continue                  恢复当前目录最近一次 run 会话
  --disallowed-tools <list>   逗号或空白分隔的工具名或内置组 id
  --allow-tools <list>        重新允许 run 默认关掉的 web、browser、image_generation
  --usage-log <path>          用量 JSONL（每次模型调用一行，外加一行 summary）
  --data-dir <dir>            数据目录，覆盖 ENSO_DATA_DIR

环境变量（命令行优先）:
  ENSO_DATA_DIR ENSO_PROVIDER_ID ENSO_MODEL ENSO_API_KEY ENSO_BASE_URL ENSO_API
  ENSO_REASONING_EFFORT ENSO_TIMEOUT_MS
  ENSO_API_KEY 和 ENSO_BASE_URL 都没设置、也没指定供应商但给了模型时，整组回退
  OPENAI_API_KEY + OPENAI_BASE_URL，其次 ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
  未设置 ENSO_MODEL 时回退 OPENAI_MODEL；没给地址时用协议默认端点

已有 $ENSO_DATA_DIR/settings.json 里的 providers 会用；标志或环境变量可以覆盖或新建一条。
run 默认无人值守：会挡住的审批按档位当场拒绝，不会等待。web / browser / image_generation
默认关闭，避免除模型端点以外的出站请求。

退出码: 0 成功；1 运行失败；2 参数或配置错误；3 goal 阻塞或等待；
        4 自动轮数用尽或连续无进展；124 超时；130 SIGINT/SIGTERM。
诊断只写 stderr。`;

const FLAG_VALUE = new Set([
  '--prompt',
  '-p',
  '--cwd',
  '--mode',
  '--target',
  '--goal',
  '--auto-turns',
  '--provider',
  '--model',
  '--api',
  '--api-key',
  '--base-url',
  '--reasoning-effort',
  '--timeout-ms',
  '--output-format',
  '--resume',
  '--disallowed-tools',
  '--allow-tools',
  '--usage-log',
  '--data-dir',
]);

export function parseToolList(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/[A-Za-z0-9_.:-]+(?:\([^)]*\))?/g)) {
    const head = match[0].split('(')[0] || match[0];
    const key = head.toLowerCase();
    const canonical = TOOL_ALIASES[key] ?? key;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function disabledToolsForRun(
  disallowed: readonly string[],
  allow: readonly string[]
): string[] {
  const allowed = new Set(allow);
  const denied = new Set<string>();
  for (const id of RUN_NETWORK_TOOLS) if (!allowed.has(id)) denied.add(id);
  for (const id of allow) if (!disallowed.includes(id)) denied.delete(id);
  for (const id of disallowed) denied.add(id);
  return [...denied];
}

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** OPENAI_* / ANTHROPIC_* 只能整组取用，不和别家的 key、地址混搭。 */
function vendorEndpoint(
  env: NodeJS.ProcessEnv
): { apiKey: string; baseUrl?: string; api?: ModelApiKind } | undefined {
  const openai = envValue(env, 'OPENAI_API_KEY');
  if (openai) {
    const baseUrl = envValue(env, 'OPENAI_BASE_URL');
    return { apiKey: openai, ...(baseUrl ? { baseUrl } : {}) };
  }
  const anthropic = envValue(env, 'ANTHROPIC_API_KEY');
  if (anthropic) {
    const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL');
    return { apiKey: anthropic, api: 'anthropic-messages', ...(baseUrl ? { baseUrl } : {}) };
  }
  return undefined;
}

function parsePositiveInt(value: string, name: string, max: number): number | string {
  if (!/^[0-9]+$/.test(value)) return `${name} 必须是正整数`;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return `${name} 必须是 1 到 ${max} 的整数`;
  }
  return parsed;
}

export function parseRunArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultCwd = process.cwd()
): ParseResult {
  const values = new Map<string, string>();
  let continueSession = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--continue') {
      continueSession = true;
      continue;
    }
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!name.startsWith('--') && name !== '-p')
      return { ok: false, error: `无法识别的参数 ${token}` };
    if (!FLAG_VALUE.has(name)) return { ok: false, error: `无法识别的参数 ${name}` };
    const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
    let value = inline;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `${name} 需要一个值` };
      }
      i++;
    }
    if (values.has(name)) return { ok: false, error: `${name} 只能出现一次` };
    values.set(name, value);
  }
  if (help && values.size === 0 && !continueSession) return { ok: false, error: '', help: true };

  const prompt = values.get('--prompt') ?? values.get('-p');
  const goalFlag = values.get('--goal');
  const targetFlag = values.get('--target');
  if (goalFlag !== undefined && targetFlag !== undefined && goalFlag !== targetFlag) {
    return { ok: false, error: '--goal 和 --target 不一致' };
  }
  const goal = goalFlag ?? targetFlag;
  if (!prompt && !goal) return { ok: false, error: '需要 --prompt，或 --goal / --target' };
  if (prompt !== undefined && prompt !== '-' && !prompt.startsWith('@') && !prompt.trim()) {
    return { ok: false, error: '--prompt 不能为空' };
  }
  if (goal !== undefined && !goal.trim()) return { ok: false, error: '--goal 不能为空' };

  const resume = values.get('--resume')?.trim();
  if (continueSession && resume) return { ok: false, error: '--resume 和 --continue 不能同时使用' };
  if (resume === '') return { ok: false, error: '--resume 需要会话 id' };

  const modeText = values.get('--mode') ?? 'full';
  if (!(APPROVAL_MODES as readonly string[]).includes(modeText)) {
    return { ok: false, error: `--mode 必须是 ${APPROVAL_MODES.join(' | ')}` };
  }
  const formatText = values.get('--output-format') ?? 'text';
  if (!(OUTPUT_FORMATS as readonly string[]).includes(formatText)) {
    return { ok: false, error: '--output-format 必须是 text | json | stream-json' };
  }

  const apiText = values.get('--api') ?? envValue(env, 'ENSO_API');
  if (apiText && !(MODEL_API_KINDS as readonly string[]).includes(apiText)) {
    return { ok: false, error: `--api 必须是 ${MODEL_API_KINDS.join(' | ')}` };
  }

  const reasoning = values.get('--reasoning-effort') ?? envValue(env, 'ENSO_REASONING_EFFORT');
  if (
    reasoning &&
    reasoning !== 'off' &&
    reasoning !== 'none' &&
    !(THINKING_LEVELS as readonly string[]).includes(reasoning)
  ) {
    return {
      ok: false,
      error: '--reasoning-effort 必须是 off、none 或 minimal | low | medium | high | xhigh | max',
    };
  }

  let autoTurns = 25;
  const turnsText = values.get('--auto-turns');
  if (turnsText !== undefined) {
    const parsed = parsePositiveInt(turnsText, '--auto-turns', 10_000);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    autoTurns = parsed;
  }
  let timeoutMs: number | undefined;
  const timeoutText = values.get('--timeout-ms') ?? envValue(env, 'ENSO_TIMEOUT_MS');
  if (timeoutText !== undefined) {
    const parsed = parsePositiveInt(timeoutText, '--timeout-ms', 86_400_000);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    timeoutMs = parsed;
  }

  const providerId = values.get('--provider')?.trim() || envValue(env, 'ENSO_PROVIDER_ID');
  const modelId = values.get('--model')?.trim() || envValue(env, 'ENSO_MODEL', 'OPENAI_MODEL');
  let apiKey = values.get('--api-key') || envValue(env, 'ENSO_API_KEY');
  let baseUrl = values.get('--base-url')?.trim() || envValue(env, 'ENSO_BASE_URL');
  let api = apiText as ModelApiKind | undefined;
  // 厂商变量常年挂在环境里：只有没指定供应商、又给了模型时才拿来新建，否则继续用 settings 里的供应商
  const vendor = !apiKey && !baseUrl && !providerId && modelId ? vendorEndpoint(env) : undefined;
  if (vendor) {
    apiKey = vendor.apiKey;
    baseUrl = vendor.baseUrl;
    api ??= vendor.api;
  }

  return {
    ok: true,
    args: {
      ...(prompt !== undefined ? { prompt } : {}),
      cwd: values.get('--cwd')?.trim() || defaultCwd,
      mode: modeText as ApprovalMode,
      ...(goal ? { goal: goal.trim() } : {}),
      autoTurns,
      providerId,
      modelId,
      apiKey,
      baseUrl,
      ...(api ? { api } : {}),
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      outputFormat: formatText as OutputFormat,
      ...(resume ? { resume } : {}),
      continue: continueSession,
      disallowedTools: parseToolList(values.get('--disallowed-tools') ?? ''),
      allowTools: parseToolList(values.get('--allow-tools') ?? ''),
      usageLog: values.get('--usage-log')?.trim() || undefined,
      dataDir: values.get('--data-dir')?.trim() || undefined,
    },
  };
}
