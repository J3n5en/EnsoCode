import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClaudeHookEvent, PluginHookSpawn } from '../shared/types/plugins';
import {
  applyUpdatedInput,
  createClaudeHooksExtension,
  createProcessHookRunner,
  type HookRunner,
  matchesHook,
  parseHookOutput,
  toClaudeToolInput,
  toClaudeToolName,
} from './claudeHooks';

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type RunResult = Awaited<ReturnType<HookRunner>>;

const ctx = {
  sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/tmp/s.jsonl' },
  signal: undefined,
};

function hook(event: ClaudeHookEvent, command: string, matcher?: string): PluginHookSpawn {
  return { plugin: 'p', root: '/root', dataDir: '/data', event, command, matcher };
}

function setup(
  hooks: PluginHookSpawn[],
  respond: (hook: PluginHookSpawn, input: Record<string, unknown>) => Partial<RunResult>,
  role: { kind: 'parent' } | { kind: 'subagent'; agentType: string } = { kind: 'parent' },
  resumed = false
) {
  const inputs: Record<string, unknown>[] = [];
  const notices: string[] = [];
  const run: HookRunner = async (h, input) => {
    inputs.push(input);
    return { exitCode: 0, stdout: '', stderr: '', ...respond(h, input) };
  };
  const ext = createClaudeHooksExtension({
    hooks,
    cwd: '/proj',
    role,
    resumed,
    run,
    onNotice: (t) => notices.push(t),
  });
  const handlers = new Map<string, Handler>();
  const factory = typeof ext === 'function' ? ext : ext.factory;
  factory({ on: (name: string, h: Handler) => handlers.set(name, h) } as never);
  const fire = async (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return { inputs, notices, handlers, fire };
}

describe('matchesHook', () => {
  it('空、* 匹配全部；名单精确匹配；其余按非锚定正则', () => {
    expect(matchesHook(undefined, 'Bash')).toBe(true);
    expect(matchesHook('', 'Bash')).toBe(true);
    expect(matchesHook('*', 'Bash')).toBe(true);
    expect(matchesHook('Edit|Write', 'Write')).toBe(true);
    expect(matchesHook('Edit, Write', 'Write')).toBe(true);
    expect(matchesHook('Edit|Write', 'MultiEdit')).toBe(false);
    expect(matchesHook('Edit', 'NotebookEdit')).toBe(false);
    expect(matchesHook('mcp__.*__write', 'mcp__fs__write_file')).toBe(true);
    expect(matchesHook('Notebook.*', 'Edit')).toBe(false);
    expect(matchesHook('([', 'Edit')).toBe(false);
  });
});

describe('tool mapping', () => {
  it('映射 Enso 工具名到 Claude 工具名', () => {
    expect(toClaudeToolName('bash')).toBe('Bash');
    expect(toClaudeToolName('apply_patch')).toBe('Edit');
    expect(toClaudeToolName('find')).toBe('Glob');
    expect(toClaudeToolName('subagent')).toBe('Task');
    expect(toClaudeToolName('mcp__fs__read')).toBe('mcp__fs__read');
    expect(toClaudeToolName('custom_tool')).toBe('custom_tool');
  });

  it('path→file_path，单条 edits 附 old_string/new_string，其余透传', () => {
    expect(toClaudeToolInput('read', { path: 'a.ts', offset: 3 })).toEqual({
      file_path: 'a.ts',
      offset: 3,
    });
    expect(
      toClaudeToolInput('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] })
    ).toEqual({
      file_path: 'a',
      edits: [{ oldText: 'x', newText: 'y' }],
      old_string: 'x',
      new_string: 'y',
    });
    expect(toClaudeToolInput('grep', { path: 'src', pattern: 'x' })).toEqual({
      path: 'src',
      pattern: 'x',
    });
  });

  it('applyUpdatedInput 反向映射并原地覆盖出现的键', () => {
    const input: Record<string, unknown> = { path: 'a', content: 'old', keep: 1 };
    applyUpdatedInput('write', input, { file_path: 'b', content: 'new' });
    expect(input).toEqual({ path: 'b', content: 'new', keep: 1 });
    const edit: Record<string, unknown> = { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] };
    applyUpdatedInput('edit', edit, { new_string: 'z' });
    expect(edit).toEqual({ path: 'a', edits: [{ oldText: 'x', newText: 'z' }] });
    const bash: Record<string, unknown> = { command: 'ls' };
    applyUpdatedInput('bash', bash, { command: 'ls -la' });
    expect(bash).toEqual({ command: 'ls -la' });
  });
});

describe('parseHookOutput', () => {
  it('exit 0 JSON 解析各字段', () => {
    const out = parseHookOutput({
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: 'hi',
        hookSpecificOutput: {
          additionalContext: 'ctx',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no',
          updatedInput: { command: 'x' },
        },
      }),
      stderr: '',
    });
    expect(out).toMatchObject({
      block: false,
      systemMessage: 'hi',
      additionalContext: 'ctx',
      permissionDecision: 'deny',
      permissionDecisionReason: 'no',
      updatedInput: { command: 'x' },
    });
  });

  it('decision block / continue false 阻断', () => {
    expect(
      parseHookOutput({ exitCode: 0, stdout: '{"decision":"block","reason":"r"}', stderr: '' })
    ).toMatchObject({ block: true, reason: 'r' });
    expect(
      parseHookOutput({ exitCode: 0, stdout: '{"continue":false,"stopReason":"s"}', stderr: '' })
    ).toMatchObject({ block: true, reason: 's' });
  });

  it('纯文本仅对上下文类事件成为 additionalContext', () => {
    const r = { exitCode: 0, stdout: 'plain\n', stderr: '' };
    expect(parseHookOutput(r, 'SessionStart').additionalContext).toBe('plain');
    expect(parseHookOutput(r, 'PreToolUse').additionalContext).toBeUndefined();
  });

  it('exit 2 阻断用 stderr；其他错误非阻断', () => {
    expect(parseHookOutput({ exitCode: 2, stdout: '', stderr: 'bad\n' })).toMatchObject({
      block: true,
      reason: 'bad',
    });
    const err = parseHookOutput({ exitCode: 1, stdout: '', stderr: 'oops' });
    expect(err.block).toBe(false);
    expect(err.error).toContain('oops');
    expect(
      parseHookOutput({ exitCode: null, stdout: '', stderr: '', timedOut: true }).error
    ).toMatch(/timed out/);
  });
});

describe('createClaudeHooksExtension', () => {
  it('没有匹配事件的 hook 时不注册任何 handler', () => {
    expect(setup([], () => ({})).handlers.size).toBe(0);
    const sub = setup([hook('Stop', 'x')], () => ({}), { kind: 'subagent', agentType: 'a' });
    expect(sub.handlers.size).toBe(0);
  });

  it('PreToolUse：按 Claude 工具名匹配，deny 阻断', async () => {
    const t = setup([hook('PreToolUse', 'guard', 'Bash')], () => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
    }));
    expect(
      await t.fire('tool_call', { toolName: 'read', toolCallId: 'r', input: { path: 'a' } })
    ).toBeUndefined();
    expect(t.inputs).toHaveLength(0);
    expect(
      await t.fire('tool_call', { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm' } })
    ).toEqual({ block: true, reason: 'nope' });
    expect(t.inputs[0]).toMatchObject({
      session_id: 'sess-1',
      transcript_path: '/tmp/s.jsonl',
      cwd: '/proj',
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'rm' },
      tool_use_id: 'c1',
    });
  });

  it('PreToolUse：exit 2 阻断，多 hook 原因换行拼接', async () => {
    const t = setup([hook('PreToolUse', 'a'), hook('PreToolUse', 'b')], (h) => ({
      exitCode: 2,
      stderr: `no-${h.command}`,
    }));
    expect(
      await t.fire('tool_call', { toolName: 'bash', toolCallId: 'c', input: { command: 'x' } })
    ).toEqual({ block: true, reason: 'no-a\nno-b' });
  });

  it('PreToolUse：updatedInput 原地改 input；context 并入 PostToolUse 反馈', async () => {
    const t = setup([hook('PreToolUse', 'pre'), hook('PostToolUse', 'post')], (h) =>
      h.event === 'PreToolUse'
        ? {
            stdout: JSON.stringify({
              hookSpecificOutput: {
                updatedInput: { file_path: 'b.ts' },
                additionalContext: 'pre-ctx',
              },
            }),
          }
        : { exitCode: 2, stderr: 'lint failed' }
    );
    const input = { path: 'a.ts', content: 'x' };
    expect(
      await t.fire('tool_call', { toolName: 'write', toolCallId: 'w', input })
    ).toBeUndefined();
    expect(input).toEqual({ path: 'b.ts', content: 'x' });
    const content = [{ type: 'text', text: 'ok' }];
    const result = (await t.fire('tool_result', {
      toolName: 'write',
      toolCallId: 'w',
      input,
      content,
      isError: false,
    })) as { content: Array<{ text: string }> };
    expect(result.content[0]).toEqual(content[0]);
    expect(result.content[1]?.text).toMatch(/^<hook feedback>\n[\s\S]*<\/hook feedback>$/);
    expect(result.content[1]?.text).toContain('lint failed');
    expect(result.content[1]?.text).toContain('pre-ctx');
    expect(t.inputs[1]).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'b.ts', content: 'x' },
      tool_response: { content: 'ok', is_error: false },
    });
  });

  it('PostToolUse 无反馈时不改结果', async () => {
    const t = setup([hook('PostToolUse', 'post')], () => ({}));
    expect(
      await t.fire('tool_result', {
        toolName: 'bash',
        toolCallId: 'x',
        input: {},
        content: [],
        isError: false,
      })
    ).toBeUndefined();
  });

  it('SessionStart + UserPromptSubmit 的 context 合并注入', async () => {
    const t = setup([hook('SessionStart', 's', 'startup'), hook('UserPromptSubmit', 'u')], (h) => ({
      stdout: h.event === 'SessionStart' ? 'start ctx' : 'prompt ctx',
    }));
    const r1 = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'hello' })) as {
      message: { customType: string; content: string; display: boolean };
    };
    expect(r1.message.customType).toBe('claude-hook-context');
    expect(r1.message.display).toBe(false);
    expect(r1.message.content).toContain('start ctx');
    expect(r1.message.content).toContain('prompt ctx');
    expect(t.inputs[0]).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(t.inputs[1]).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    const r2 = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'again' })) as {
      message: { content: string };
    };
    expect(r2.message.content).not.toContain('start ctx');
    expect(t.inputs.filter((i) => i.hook_event_name === 'SessionStart')).toHaveLength(1);
  });

  it('custom 启动保留 SessionStart 上下文，不产生 UserPromptSubmit 拒绝说明', async () => {
    const t = setup([hook('SessionStart', 's'), hook('UserPromptSubmit', 'u')], (h) =>
      h.event === 'SessionStart'
        ? { stdout: 'start ctx' }
        : { exitCode: 2, stderr: 'user-only guard' }
    );
    const event = {
      messageType: 'custom',
      message: { customType: 'extension-task', content: 'continue task', display: false },
    };
    expect(await t.fire('before_agent_start', event)).toEqual({
      message: { customType: 'claude-hook-context', content: 'start ctx', display: false },
    });
    expect(await t.fire('before_agent_start', event)).toBeUndefined();
    expect(t.notices).toEqual([]);
    expect(t.inputs.map((input) => input.hook_event_name)).toEqual(['SessionStart']);

    const userResult = (await t.fire('before_agent_start', {
      messageType: 'user',
      prompt: 'hello',
    })) as { message: { content: string } };
    expect(userResult.message.content).toContain('UserPromptSubmit hook blocked this prompt');
    expect(userResult.message.content).not.toContain('start ctx');
    expect(t.inputs[1]).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  });

  it('压缩后的 SessionStart 上下文可由 custom 启动消费且只注入一次', async () => {
    const t = setup([hook('SessionStart', 's', 'compact')], () => ({
      stdout: 'after compact',
    }));
    const event = {
      messageType: 'custom',
      message: { customType: 'extension-task', content: 'continue task', display: false },
    };
    expect(await t.fire('before_agent_start', event)).toBeUndefined();
    await t.fire('session_compact', { reason: 'threshold' });
    expect(await t.fire('before_agent_start', event)).toEqual({
      message: { customType: 'claude-hook-context', content: 'after compact', display: false },
    });
    expect(await t.fire('before_agent_start', event)).toBeUndefined();
  });

  it('恢复的会话首轮以 resume 触发 SessionStart', async () => {
    const t = setup(
      [hook('SessionStart', 's', 'resume')],
      () => ({ stdout: 'resumed ctx' }),
      {
        kind: 'parent',
      },
      true
    );
    const r = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'x' })) as {
      message: { content: string };
    };
    expect(t.inputs[0]).toMatchObject({ source: 'resume' });
    expect(r.message.content).toContain('resumed ctx');
  });

  it('SessionStart matcher 过滤 source；compact 触发', async () => {
    const t = setup([hook('SessionStart', 's', 'compact')], () => ({ stdout: 'after compact' }));
    expect(
      await t.fire('before_agent_start', { messageType: 'user', prompt: 'first' })
    ).toBeUndefined();
    expect(t.inputs).toHaveLength(0);
    await t.fire('session_compact', { reason: 'threshold' });
    expect(t.inputs[0]).toMatchObject({ source: 'compact' });
    const r = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'x' })) as {
      message: { content: string };
    };
    expect(r.message.content).toContain('after compact');
  });

  it('UserPromptSubmit 阻断时注入拒绝说明并通知', async () => {
    const t = setup([hook('UserPromptSubmit', 'u')], () => ({ exitCode: 2, stderr: 'secret' }));
    const r = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'x' })) as {
      message: { content: string };
    };
    expect(r.message.content).toContain('UserPromptSubmit hook blocked this prompt: secret');
    expect(t.notices.join('\n')).toContain('secret');
  });

  it('没有 context 时 before_agent_start 不返回 message', async () => {
    const t = setup([hook('UserPromptSubmit', 'u')], () => ({}));
    expect(
      await t.fire('before_agent_start', { messageType: 'user', prompt: 'x' })
    ).toBeUndefined();
  });

  it('Stop 阻断续跑，同一轮最多 3 次，新 prompt 重置', async () => {
    const t = setup([hook('Stop', 's')], () => ({
      stdout: '{"decision":"block","reason":"keep going"}',
    }));
    expect(await t.fire('agent_before_settle', { outcome: 'aborted' })).toBeUndefined();
    expect(t.inputs).toHaveLength(0);
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await t.fire('agent_before_settle', { outcome: 'completed' }));
    expect(results[0]).toEqual({
      entries: [
        {
          type: 'custom_message',
          customType: 'claude-hook-stop',
          content: 'keep going',
          display: true,
        },
      ],
      continue: true,
    });
    expect(results[2]).toBeDefined();
    expect(results[3]).toBeUndefined();
    expect(t.inputs.map((i) => i.stop_hook_active)).toEqual([false, true, true, true]);
    await t.fire('before_agent_start', { messageType: 'user', prompt: 'next' });
    expect(await t.fire('agent_before_settle', { outcome: 'completed' })).toBeDefined();
  });

  it('Stop 输出 continue:false 不会续跑', async () => {
    const t = setup([hook('Stop', 's')], () => ({
      stdout: '{"continue":false,"stopReason":"done"}',
    }));
    expect(await t.fire('agent_before_settle', { outcome: 'completed' })).toBeUndefined();
  });

  it('systemMessage 与非阻断错误走 onNotice', async () => {
    const t = setup([hook('PreToolUse', 'a'), hook('PreToolUse', 'b')], (h) =>
      h.command === 'a'
        ? { stdout: '{"systemMessage":"heads up"}' }
        : { exitCode: 1, stderr: 'boom' }
    );
    expect(
      await t.fire('tool_call', { toolName: 'bash', toolCallId: 'c', input: { command: 'x' } })
    ).toBeUndefined();
    expect(t.notices.some((n) => n.includes('heads up'))).toBe(true);
    expect(t.notices.some((n) => n.includes('boom'))).toBe(true);
  });

  it('PreCompact / SessionEnd 字段映射', async () => {
    const t = setup([hook('PreCompact', 'c', 'manual'), hook('SessionEnd', 'e')], () => ({}));
    await t.fire('session_before_compact', { reason: 'threshold' });
    expect(t.inputs).toHaveLength(0);
    await t.fire('session_before_compact', { reason: 'manual' });
    await t.fire('session_shutdown', { reason: 'quit' });
    expect(t.inputs[0]).toMatchObject({ trigger: 'manual', custom_instructions: '' });
    expect(t.inputs[1]).toMatchObject({
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    });
  });

  it('subagent：SubagentStart context 首轮注入，不跑 UPS；SubagentStop 可续跑', async () => {
    const t = setup(
      [
        hook('SubagentStart', 'ss', 'explorer'),
        hook('SubagentStop', 'st'),
        hook('UserPromptSubmit', 'u'),
        hook('SessionStart', 's'),
      ],
      (h) =>
        h.event === 'SubagentStart' ? { stdout: 'sub ctx' } : { exitCode: 2, stderr: 'not yet' },
      { kind: 'subagent', agentType: 'explorer' }
    );
    const r = (await t.fire('before_agent_start', { messageType: 'user', prompt: 'task' })) as {
      message: { content: string };
    };
    expect(t.inputs[0]).toMatchObject({
      hook_event_name: 'SubagentStart',
      agent_type: 'explorer',
      agent_id: 'sess-1',
    });
    expect(r.message.content).toContain('sub ctx');
    expect(t.inputs).toHaveLength(1);
    expect(
      await t.fire('before_agent_start', { messageType: 'user', prompt: 'task2' })
    ).toBeUndefined();
    const settle = (await t.fire('agent_before_settle', { outcome: 'completed' })) as {
      continue: boolean;
    };
    expect(settle.continue).toBe(true);
    expect(t.inputs[1]).toMatchObject({
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_type: 'explorer',
    });
  });
});

describe('createProcessHookRunner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hooks-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = createProcessHookRunner(dir);
  const spawnHook = (command: string, timeoutSec?: number): PluginHookSpawn => ({
    plugin: 'p',
    root: join(dir, 'root'),
    dataDir: join(dir, 'data', 'nested'),
    event: 'PreToolUse',
    command,
    timeoutSec,
  });

  it.skipIf(process.platform === 'win32')('回显 stdin 并注入环境变量', async () => {
    const script = join(dir, 'echo.sh');
    writeFileSync(
      script,
      'cat > "$CLAUDE_PLUGIN_DATA/in.json"; printf "%s|%s|%s" "$CLAUDE_PROJECT_DIR" "$CLAUDE_PLUGIN_ROOT" "$(pwd -P)"\n'
    );
    const h = spawnHook(`bash "${script}"`);
    const result = await run(h, { hello: 'world' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(h.dataDir, 'in.json'), 'utf8'))).toEqual({
      hello: 'world',
    });
    const [project, root] = result.stdout.split('|');
    expect(project).toBe(dir);
    expect(root).toBe(h.root);
  });

  it.skipIf(process.platform === 'win32')('exit 2 带 stderr', async () => {
    const result = await run(spawnHook('echo denied >&2; exit 2'), {});
    expect(result).toMatchObject({ exitCode: 2, stderr: 'denied\n' });
  });

  it.skipIf(process.platform === 'win32')('超时杀进程', async () => {
    const started = Date.now();
    const result = await run(spawnHook('sleep 5 & sleep 5', 0.3), {});
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
