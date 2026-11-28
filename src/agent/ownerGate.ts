import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  PLUGIN_MESSAGE_TYPE,
  type PluginInjectSender,
  parsePluginInjectSender,
} from '@shared/extensionPlugins/protocol';
import { classifyProtectedCommand, programTokens } from './protectedActions';

export type OwnerOriginSource = 'user' | 'plugin-trusted' | 'plugin-owner' | 'user-confirmed';

export type TurnTriggerOrigin =
  | { kind: 'owner'; source: OwnerOriginSource }
  | {
      kind: 'external';
      pluginId: string;
      pluginName?: string;
      sender?: PluginInjectSender;
      /** 主人打开了「非主人消息必须确认」 */
      confirm: boolean;
    };

export type OwnerGateCategory = 'dispatch' | 'subagent' | 'command';

export interface OwnerGateAuditEntry {
  at: number;
  action: string;
  category: OwnerGateCategory;
  pluginId: string;
  sender?: PluginInjectSender;
  ok: boolean;
}

/** 非主人轮次里放行的敏感动作。相对 dataDir */
export const OWNER_GATE_AUDIT_LOG = 'owner-gate-audit.log';

export interface OwnerGateMatch {
  category: OwnerGateCategory;
  action: string;
  detail?: string;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SPLIT = /\|\|?|&&?|;|\n|\$\(|`|\)/;
const GATED_PROTECTED = new Set(['deploy', 'payment', 'external-send', 'delete', 'secret']);
const DISPATCH_TOOLS = new Set([
  'session_create',
  'session_send',
  'todo_item_dispatch',
  'secretary_message',
  'session_takeover_propose',
  'schedule_add',
  'delegate',
  'retry_delegation',
  'routine_propose',
  'bridge_ask',
]);
const GH_WRITE: Record<string, ReadonlySet<string>> = {
  pr: new Set(['create', 'merge', 'close', 'reopen', 'comment', 'review', 'edit', 'ready']),
  issue: new Set(['create', 'close', 'reopen', 'comment', 'edit']),
  release: new Set(['create', 'delete', 'upload', 'edit']),
  repo: new Set(['create', 'delete', 'archive']),
};
const RELEASE_BINS = new Set([
  'vercel',
  'wrangler',
  'firebase',
  'netlify',
  'changeset',
  'semantic-release',
]);
const RELEASE_VERBS = new Set(['deploy', 'publish', 'upload', 'release']);
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);
const ZH_DENY = [
  '不同意',
  '不批准',
  '不允许',
  '不确认',
  '不可以',
  '拒绝',
  '取消',
  '不要',
  '不行',
  '禁止',
  '停止',
  '驳回',
];
const ZH_NEGATED_ALLOW =
  /(?:不|别|勿|未|没|暂不|先不|无需|不用)(?:要|能|可|准|必|再)?(?:同意|确认|批准|允许|放行|可以|行|执行|继续|推|发)/;
const ZH_ALLOW = [
  '继续执行',
  '同意',
  '确认',
  '批准',
  '允许',
  '放行',
  '可以',
  '好的',
  '准了',
  '执行',
];
const EN_DENY =
  /\b(?:no|nope|deny|denied|reject|rejected|decline|declined|cancel|cancelled|canceled|abort|stop|disagree|disapprove)\b|\bdo not\b|\bnot approved\b|\bnot\b|(?:^|\s)don't(?:\s|$)/i;
const EN_ALLOW =
  /\b(?:yes|yeah|yep|ok|okay|approve|approved|confirm|confirmed|allow|allowed|accept|accepted|proceed|lgtm)\b|\bgo ahead\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((token) => token && !token.startsWith('-'));
}

/** 否定优先。空回答、拒绝和超时默认项都不能当成 owner 确认 */
export function isOwnerConfirmationAnswer(answer: string): boolean {
  const text = answer.trim();
  if (!text) return false;
  if (ZH_DENY.some((phrase) => text.includes(phrase))) return false;
  if (ZH_NEGATED_ALLOW.test(text)) return false;
  if (/(?:^|[^\p{L}\p{N}])否(?:$|[^\p{L}\p{N}])/u.test(text)) return false;
  if (EN_DENY.test(text)) return false;
  if (ZH_ALLOW.some((phrase) => text.includes(phrase))) return true;
  if (/(?:^|[^\p{L}\p{N}])行(?:$|[^\p{L}\p{N}])/u.test(text)) return true;
  return EN_ALLOW.test(text);
}

function gitSubcommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) break;
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (
      /^(?:--git-dir|--work-tree|--namespace|--super-prefix|--config-env|-c)=/.test(token) ||
      (token.startsWith('-C') && token.length > 2)
    ) {
      index += 1;
      continue;
    }
    index += 1;
  }
  const sub = args[index];
  return sub && !sub.startsWith('-') ? sub : undefined;
}

function ghApiWrites(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(token)) return true;
    if (token === '-X' || token === '--method') {
      const method = (args[index + 1] ?? '').toUpperCase();
      if (method && method !== 'GET' && method !== 'HEAD') return true;
    }
    const inline = /^(?:-X|--method=)([A-Za-z]+)$/.exec(token);
    if (inline && !/^(?:GET|HEAD)$/i.test(inline[1])) return true;
  }
  return false;
}

function ghAction(args: readonly string[]): string | null {
  const group = firstPositional(args);
  if (!group) return null;
  const rest = args.slice(args.indexOf(group) + 1);
  if (group === 'workflow' && firstPositional(rest) === 'run') return 'gh workflow run';
  if (group === 'api') return ghApiWrites(rest) ? 'gh api' : null;
  const verb = firstPositional(rest);
  return verb && GH_WRITE[group]?.has(verb) ? `gh ${group} ${verb}` : null;
}

function releaseAction(program: string, args: readonly string[]): string | null {
  if (program === 'firebase' && firstPositional(args) === 'deploy') return 'firebase deploy';
  if (program === 'changeset' && firstPositional(args) === 'publish') return 'changeset publish';
  if (program === 'semantic-release') return 'semantic-release';
  const rest = program === 'pnpm' && args[0] === 'dlx' ? args.slice(1) : args;
  if (program !== 'npx' && program !== 'bunx' && !(program === 'pnpm' && args[0] === 'dlx'))
    return null;
  const binToken = firstPositional(rest);
  const bin = basename(binToken ?? '');
  if (!binToken || !RELEASE_BINS.has(bin)) return null;
  const verb = firstPositional(rest.slice(rest.indexOf(binToken) + 1));
  if (bin === 'semantic-release' || bin === 'changeset' || (verb && RELEASE_VERBS.has(verb)))
    return verb ? `${program} ${bin} ${verb}` : `${program} ${bin}`;
  return null;
}

function matchCommand(command: string, depth: number): OwnerGateMatch | null {
  if (depth >= 3) return null;
  for (const segment of command.split(SPLIT)) {
    const tokens = programTokens(segment);
    if (tokens.length === 0) continue;
    const program = basename(tokens[0]);
    const args = tokens.slice(1);
    if (SHELLS.has(program)) {
      const flag = args.indexOf('-c');
      if (flag !== -1) {
        const inner = matchCommand(args.slice(flag + 1).join(' '), depth + 1);
        if (inner) return inner;
      }
    }
    if (program === 'git') {
      const sub = gitSubcommand(args);
      if (sub === 'push' || sub === 'send-email')
        return { category: 'command', action: `git ${sub}` };
    }
    if (program === 'gh') {
      const action = ghAction(args);
      if (action) return { category: 'command', action };
    }
    const release = releaseAction(program, args);
    if (release) return { category: 'command', action: release };
  }
  return null;
}

function protectedAction(command: string, depth = 0): string {
  if (depth >= 3) return command.trim();
  for (const segment of command.split(SPLIT)) {
    if (!classifyProtectedCommand(segment)) continue;
    const tokens = programTokens(segment);
    const program = basename(tokens[0] ?? '');
    const args = tokens.slice(1);
    if (SHELLS.has(program)) {
      const flag = args.indexOf('-c');
      if (flag !== -1) return protectedAction(args.slice(flag + 1).join(' '), depth + 1);
    }
    const sub = firstPositional(args);
    if (
      (program === 'pnpm' || program === 'npm' || program === 'yarn' || program === 'bun') &&
      (sub === 'run' || sub === 'run-script')
    ) {
      const script = firstPositional(args.slice(args.indexOf(sub) + 1));
      return script ? `${program} run ${script}` : `${program} ${sub}`;
    }
    return sub ? `${program} ${sub}` : program || segment.trim();
  }
  return command.trim();
}

export function classifyOwnerGatedCommand(command: string): OwnerGateMatch | null {
  const direct = matchCommand(command, 0);
  if (direct) return direct;
  const category = classifyProtectedCommand(command);
  if (category && GATED_PROTECTED.has(category))
    return { category: 'command', action: protectedAction(command) };
  return null;
}

export function classifyOwnerGatedTool(toolName: string, params: unknown): OwnerGateMatch | null {
  if (
    DISPATCH_TOOLS.has(toolName) ||
    toolName.endsWith('__bridge_ask') ||
    toolName.endsWith('__cron_create')
  ) {
    return { category: 'dispatch', action: toolName };
  }
  const record = isRecord(params) ? params : undefined;
  if (toolName === 'subagent') {
    const operation = record?.operation;
    return operation === 'spawn' || operation === 'send' || operation === 'resume'
      ? { category: 'subagent', action: `subagent ${operation}` }
      : null;
  }
  if (toolName === 'workflow') {
    const stopOnly = Boolean(record?.stop) && !record?.preset && !record?.script && !record?.resume;
    return stopOnly ? null : { category: 'subagent', action: 'workflow' };
  }
  if ((toolName === 'bash' || toolName === 'powershell') && typeof record?.command === 'string')
    return classifyOwnerGatedCommand(record.command);
  return null;
}

function describeTrigger(origin: TurnTriggerOrigin): string {
  if (origin.kind !== 'external') return '未知外部来源';
  const plugin = origin.pluginName || origin.pluginId;
  const who = origin.sender?.displayName || origin.sender?.userId || origin.sender?.chatId;
  if (plugin && who) return `插件 ${plugin}，发送者 ${who}`;
  if (plugin) return `插件 ${plugin}`;
  return '未知外部来源';
}

function ownerGateError(gate: OwnerGate, match: OwnerGateMatch): Error {
  return new Error(
    `需要 owner 确认（Owner confirmation required）。来源：${describeTrigger(gate.origin())}。被拦截的动作：${match.action}。请调用 ask_user 请 owner 确认（提供「同意」「拒绝」选项），或等待 owner 在会话或私聊里回复确认后再执行。未确认前禁止重试。可在「秘书 → 联系方式 → 主人身份」绑定 GitHub 账号，或把外部消息处理改回「交给 agent 判断」。`
  );
}

/** 本轮能不能开工。缺省是用户自己发起；外部插件投递进来后保持拦截，直到 owner 确认 */
export class OwnerGate {
  private state: TurnTriggerOrigin = { kind: 'owner', source: 'user' };
  /**
   * 最近一条 user 消息是不是 Main 标记过的 owner 亲手输入。秘书会话里 Main 的投递（会话回传、
   * 同事消息、触发器、定时）也是 user 消息，只有这一位能把它们和 owner 自己说的话分开。
   */
  private ownerInput = false;
  /** 秘书资料里信任的插件：只有它们以 owner 身份投递的消息才算 owner 触发 */
  private readonly trustedPlugins: ReadonlySet<string>;

  constructor(options?: { trustedPlugins?: ReadonlySet<string> }) {
    this.trustedPlugins = options?.trustedPlugins ?? new Set();
  }

  origin(): TurnTriggerOrigin {
    return this.state;
  }

  isOwner(): boolean {
    return this.state.kind === 'owner';
  }

  /**
   * 本轮由 owner 触发：最近一条输入是 Main 标记过的 owner 输入，或是被信任的插件以 owner 身份
   * （Main 按 owner 绑定或插件的 injectTrusted 权限判定）投递的消息；其他插件投递一进来就不算。
   */
  isOwnerInputTurn(): boolean {
    return this.state.kind === 'owner' && this.ownerInput;
  }

  observeMessage(message: unknown, ownerInput = false): void {
    if (!isRecord(message)) return;
    if (message.role === 'user') {
      this.state = { kind: 'owner', source: 'user' };
      this.ownerInput = ownerInput;
      return;
    }
    if (message.role !== 'custom' || message.customType !== PLUGIN_MESSAGE_TYPE) return;
    const details = isRecord(message.details) ? message.details : {};
    const pluginId = typeof details.pluginId === 'string' ? details.pluginId : 'unknown';
    this.ownerInput = details.origin === 'owner' && this.trustedPlugins.has(pluginId);
    const pluginName = typeof details.pluginName === 'string' ? details.pluginName : undefined;
    const sender = parsePluginInjectSender(details.sender) ?? undefined;
    if (details.origin === 'owner') {
      this.state = { kind: 'owner', source: details.sender ? 'plugin-owner' : 'plugin-trusted' };
      return;
    }
    this.state = {
      kind: 'external',
      pluginId,
      ...(pluginName ? { pluginName } : {}),
      ...(sender ? { sender } : {}),
      confirm: details.ownerConfirm === true,
    };
  }

  syncFromMessages(messages: readonly unknown[]): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isRecord(message)) continue;
      const plugin = message.role === 'custom' && message.customType === PLUGIN_MESSAGE_TYPE;
      if (message.role === 'user' || plugin) {
        this.observeMessage(message);
        return;
      }
    }
  }

  confirmByOwner(): void {
    this.state = { kind: 'owner', source: 'user-confirmed' };
  }

  handleAskUserAnswer(answer: string): boolean {
    if (this.state.kind !== 'external' || !isOwnerConfirmationAnswer(answer)) return false;
    this.confirmByOwner();
    return true;
  }
}

/** 只有原会话里的真人回答能放行。超时自动选项和秘书代答都不算 */
export function applyOwnerAskResolution(
  gate: OwnerGate | undefined,
  resolution: { by?: string; answer?: unknown } | undefined
): boolean {
  if (!gate || resolution?.by !== 'user' || typeof resolution.answer !== 'string') return false;
  return gate.handleAskUserAnswer(resolution.answer);
}

export function withOwnerGate(
  definition: ToolDefinition,
  gate: OwnerGate,
  audit?: (entry: OwnerGateAuditEntry) => void
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const origin = gate.origin();
      if (origin.kind === 'external') {
        const match = classifyOwnerGatedTool(definition.name, params);
        if (match) {
          if (origin.confirm) throw ownerGateError(gate, match);
          const record = (ok: boolean) =>
            audit?.({
              at: Date.now(),
              action: match.action,
              category: match.category,
              pluginId: origin.pluginId,
              ...(origin.sender ? { sender: origin.sender } : {}),
              ok,
            });
          try {
            const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
            record(true);
            return result;
          } catch (error) {
            record(false);
            throw error;
          }
        }
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
