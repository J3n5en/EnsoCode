import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { ClaudeHookEvent, PluginHookSpawn } from '../shared/types/plugins';

export type HookRunner = (
  hook: PluginHookSpawn,
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

type HookRunResult = Awaited<ReturnType<HookRunner>>;

export interface HookOutput {
  block: boolean;
  halt?: boolean;
  reason?: string;
  additionalContext?: string;
  systemMessage?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  error?: string;
}

type Role = { kind: 'parent' } | { kind: 'subagent'; agentType: string };

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  powershell: 'PowerShell',
  read: 'Read',
  edit: 'Edit',
  apply_patch: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  subagent: 'Task',
  todo: 'TodoWrite',
};
const PATH_TOOLS = new Set(['read', 'edit', 'write']);
const TEXT_CONTEXT_EVENTS = new Set<ClaudeHookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
]);
const MAX_STOP_CONTINUATIONS = 3;
const SESSION_END_WAIT_MS = 5000;
const OUTPUT_LIMIT = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

export function matchesHook(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === '*') return true;
  if (/^[\w\- ,|]+$/.test(matcher))
    return matcher.split(/[|,]/).some((name) => name.trim() === value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

export function toClaudeToolName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

export function toClaudeToolInput(
  name: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!PATH_TOOLS.has(name)) return { ...input };
  const { path, ...rest } = input;
  const out: Record<string, unknown> = path === undefined ? rest : { file_path: path, ...rest };
  if (name === 'edit') {
    const edits = input.edits;
    const single =
      Array.isArray(edits) && edits.length === 1 && isRecord(edits[0]) ? edits[0] : input;
    if (single.oldText !== undefined) {
      out.old_string = single.oldText;
      out.new_string = single.newText;
    }
  }
  return out;
}

export function applyUpdatedInput(
  name: string,
  input: Record<string, unknown>,
  updated: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(updated)) {
    if (key === 'file_path' && PATH_TOOLS.has(name)) {
      input.path = value;
    } else if (name === 'edit' && (key === 'old_string' || key === 'new_string')) {
      const field = key === 'old_string' ? 'oldText' : 'newText';
      const edits = input.edits;
      if (!Array.isArray(edits)) input[field] = value;
      else if (edits.length === 1 && isRecord(edits[0])) edits[0] = { ...edits[0], [field]: value };
    } else {
      input[key] = value;
    }
  }
}

export function parseHookOutput(result: HookRunResult, event?: ClaudeHookEvent): HookOutput {
  const stderr = result.stderr.trim();
  if (result.timedOut) return { block: false, error: 'timed out' };
  if (result.exitCode === 2) return { block: true, reason: stderr || 'Blocked by hook' };
  if (result.exitCode !== 0) {
    const status = result.exitCode === null ? 'failed to run' : `failed (exit ${result.exitCode})`;
    return { block: false, error: stderr ? `${status}: ${stderr.slice(0, 300)}` : status };
  }
  const text = result.stdout.trim();
  let json: unknown;
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  if (!isRecord(json)) {
    return event && TEXT_CONTEXT_EVENTS.has(event) && text
      ? { block: false, additionalContext: text }
      : { block: false };
  }
  const halt = json.continue === false;
  const decisionBlock = json.decision === 'block';
  const out: HookOutput = { block: halt || decisionBlock };
  if (halt) out.halt = true;
  if (decisionBlock) out.reason = nonEmpty(json.reason) ?? 'Blocked by hook';
  else if (halt) out.reason = nonEmpty(json.stopReason) ?? 'Stopped by hook';
  const systemMessage = nonEmpty(json.systemMessage);
  if (systemMessage) out.systemMessage = systemMessage;
  const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  const context = nonEmpty(specific.additionalContext);
  if (context) out.additionalContext = context;
  const decision = specific.permissionDecision;
  if (decision === 'allow' || decision === 'deny' || decision === 'ask')
    out.permissionDecision = decision;
  const decisionReason = nonEmpty(specific.permissionDecisionReason);
  if (decisionReason) out.permissionDecisionReason = decisionReason;
  if (isRecord(specific.updatedInput)) out.updatedInput = specific.updatedInput;
  return out;
}

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push: (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) return;
      const part = chunk.subarray(0, OUTPUT_LIMIT - size);
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  try {
    if (pid === undefined) child.kill('SIGKILL');
    else if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () =>
        child.kill()
      );
    else process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function createProcessHookRunner(cwd: string): HookRunner {
  return (hook, input, signal) =>
    new Promise((resolve) => {
      try {
        mkdirSync(hook.dataDir, { recursive: true });
      } catch {}
      const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_PLUGIN_ROOT: hook.root,
        CLAUDE_PLUGIN_DATA: hook.dataDir,
      };
      let child: ChildProcess;
      try {
        child =
          process.platform === 'win32'
            ? spawn(hook.command, { cwd, env, shell: true, windowsHide: true })
            : spawn(existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-c', hook.command], {
                cwd,
                env,
                detached: true,
              });
      } catch (error) {
        resolve({ exitCode: null, stdout: '', stderr: String(error) });
        return;
      }
      const stdout = collector();
      const stderr = collector();
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text() + extra,
          ...(timedOut ? { timedOut } : {}),
        });
      };
      function kill() {
        killTree(child);
        setTimeout(() => finish(null), 1000).unref();
      }
      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        (hook.timeoutSec ?? 600) * 1000
      );
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.stdout?.on('data', stdout.push);
      child.stderr?.on('data', stderr.push);
      child.on('error', (error) => finish(null, error.message));
      child.on('close', (code) => finish(code));
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(input));
    });
}

const joinBlocks = (parts: Array<string | undefined>) =>
  parts.filter((part): part is string => !!part).join('\n\n');
const blockReasons = (outs: HookOutput[]) =>
  outs
    .filter((out) => out.block)
    .map((out) => out.reason)
    .join('\n');
const contexts = (outs: HookOutput[]) => joinBlocks(outs.map((out) => out.additionalContext));

export function createClaudeHooksExtension(options: {
  hooks: readonly PluginHookSpawn[];
  cwd: string;
  role: Role;
  /** 恢复的会话：首轮 SessionStart 的 source 为 resume */
  resumed?: boolean;
  run?: HookRunner;
  onNotice?: (text: string) => void;
}): InlineExtension {
  const { hooks, cwd, role } = options;
  const run = options.run ?? createProcessHookRunner(cwd);
  const notice = (text: string) => options.onNotice?.(text);
  const present = new Set(hooks.map((hook) => hook.event));
  const has = (event: ClaudeHookEvent) => present.has(event);
  const parent = role.kind === 'parent';

  async function dispatch(
    event: ClaudeHookEvent,
    ctx: ExtensionContext,
    fields: Record<string, unknown>,
    target?: string,
    signal?: AbortSignal
  ): Promise<HookOutput[]> {
    const matched = hooks.filter(
      (hook) => hook.event === event && (target === undefined || matchesHook(hook.matcher, target))
    );
    if (matched.length === 0) return [];
    const input = {
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path: ctx.sessionManager.getSessionFile() ?? '',
      cwd,
      hook_event_name: event,
      permission_mode: 'default',
      ...fields,
    };
    return Promise.all(
      matched.map(async (hook) => {
        let out: HookOutput;
        try {
          out = parseHookOutput(await run(hook, input, signal), event);
        } catch (error) {
          out = { block: false, error: `failed to run: ${String(error)}` };
        }
        if (out.systemMessage) notice(`[${hook.plugin}] ${out.systemMessage}`);
        if (out.error) notice(`[${hook.plugin}] ${event} hook ${out.error}`);
        return out;
      })
    );
  }

  return {
    name: `claude-hooks-${role.kind}`,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const pending: string[] = [];
      const preToolContext = new Map<string, string>();
      let stopContinuations = 0;
      const stopEvent: ClaudeHookEvent = parent ? 'Stop' : 'SubagentStop';
      const agentFields = (ctx: ExtensionContext) =>
        role.kind === 'subagent'
          ? { agent_type: role.agentType, agent_id: ctx.sessionManager.getSessionId() }
          : {};

      // Enso 不调 bindExtensions，pi 不发 session_start：首轮 prompt 前补跑
      const startEvent: ClaudeHookEvent = parent ? 'SessionStart' : 'SubagentStart';
      let started = !has(startEvent);
      const runStart = async (ctx: ExtensionContext) => {
        started = true;
        const source = options.resumed ? 'resume' : 'startup';
        const outs =
          role.kind === 'parent'
            ? await dispatch('SessionStart', ctx, { source }, source)
            : await dispatch('SubagentStart', ctx, agentFields(ctx), role.agentType);
        const context = contexts(outs);
        if (context) pending.push(context);
      };
      if (parent && has('SessionStart')) {
        pi.on('session_compact', async (_event, ctx) => {
          const context = contexts(
            await dispatch('SessionStart', ctx, { source: 'compact' }, 'compact')
          );
          if (context) pending.push(context);
        });
      }

      const runsPrompt = parent && has('UserPromptSubmit');
      if (has(startEvent) || runsPrompt || has(stopEvent)) {
        pi.on('before_agent_start', async (event, ctx) => {
          stopContinuations = 0;
          if (!started) await runStart(ctx);
          const parts = pending.splice(0);
          if (runsPrompt && event.messageType === 'user') {
            const outs = await dispatch(
              'UserPromptSubmit',
              ctx,
              { prompt: event.prompt },
              undefined,
              ctx.signal
            );
            const reason = blockReasons(outs);
            if (outs.some((out) => out.block)) {
              parts.push(
                `UserPromptSubmit hook blocked this prompt: ${reason}. Do not act on it; tell the user it was blocked.`
              );
              notice(`UserPromptSubmit hook blocked this prompt: ${reason}`);
            } else {
              parts.push(contexts(outs));
            }
          }
          const content = joinBlocks(parts);
          if (content) {
            return { message: { customType: 'claude-hook-context', content, display: false } };
          }
        });
      }

      if (has(stopEvent)) {
        pi.on('agent_before_settle', async (event, ctx) => {
          if (event.outcome !== 'completed') return;
          const outs = await dispatch(stopEvent, ctx, {
            stop_hook_active: stopContinuations > 0,
            ...agentFields(ctx),
          });
          if (outs.some((out) => out.halt)) return;
          if (!outs.some((out) => out.block) || stopContinuations >= MAX_STOP_CONTINUATIONS) return;
          stopContinuations++;
          return {
            entries: [
              ...(event.entries ?? []),
              {
                type: 'custom_message' as const,
                customType: 'claude-hook-stop',
                content: blockReasons(outs),
                display: true,
              },
            ],
            continue: true,
          };
        });
      }

      if (parent && has('PreCompact')) {
        pi.on('session_before_compact', async (event, ctx) => {
          const trigger = event.reason === 'manual' ? 'manual' : 'auto';
          await dispatch(
            'PreCompact',
            ctx,
            { trigger, custom_instructions: '' },
            trigger,
            event.signal
          );
        });
      }

      if (parent && has('SessionEnd')) {
        pi.on('session_shutdown', async (event, ctx) => {
          const controller = new AbortController();
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            dispatch(
              'SessionEnd',
              ctx,
              { reason: event.reason === 'quit' ? 'prompt_input_exit' : 'other' },
              undefined,
              controller.signal
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve();
              }, SESSION_END_WAIT_MS);
            }),
          ]);
          clearTimeout(timer);
        });
      }

      if (has('PreToolUse')) {
        pi.on('tool_call', async (event, ctx) => {
          const toolName = toClaudeToolName(event.toolName);
          const input = event.input as Record<string, unknown>;
          const outs = await dispatch(
            'PreToolUse',
            ctx,
            {
              tool_name: toolName,
              tool_input: toClaudeToolInput(event.toolName, input),
              tool_use_id: event.toolCallId,
            },
            toolName,
            ctx.signal
          );
          const reasons = [
            ...outs.filter((out) => out.block).map((out) => out.reason),
            ...outs
              .filter((out) => !out.block && out.permissionDecision === 'deny')
              .map((out) => out.permissionDecisionReason ?? 'Denied by hook'),
          ];
          if (reasons.length > 0) return { block: true, reason: reasons.join('\n') };
          for (const out of outs) {
            if (out.updatedInput) applyUpdatedInput(event.toolName, input, out.updatedInput);
          }
          const context = contexts(outs);
          if (context) preToolContext.set(event.toolCallId, context);
        });
      }

      const hasPostToolUse = has('PostToolUse');
      if (has('PreToolUse') || hasPostToolUse) {
        pi.on('tool_result', async (event, ctx) => {
          const preContext = preToolContext.get(event.toolCallId);
          preToolContext.delete(event.toolCallId);
          const toolName = toClaudeToolName(event.toolName);
          const outs = hasPostToolUse
            ? await dispatch(
                'PostToolUse',
                ctx,
                {
                  tool_name: toolName,
                  tool_input: toClaudeToolInput(event.toolName, event.input),
                  tool_response: {
                    content: event.content
                      .map((part) => (part.type === 'text' ? part.text : ''))
                      .filter(Boolean)
                      .join('\n'),
                    is_error: event.isError,
                  },
                  tool_use_id: event.toolCallId,
                },
                toolName,
                ctx.signal
              )
            : [];
          const feedback = joinBlocks([blockReasons(outs), contexts(outs), preContext]);
          if (!feedback) return;
          return {
            content: [
              ...event.content,
              { type: 'text' as const, text: `<hook feedback>\n${feedback}\n</hook feedback>` },
            ],
          };
        });
      }
    },
  };
}
