import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import type { TimelineMessage } from './reducer';
import {
  buildTimeline,
  codemodeView,
  parseSandboxOutput,
  readImagePreviewPath,
  summarizeSandboxCalls,
} from './timeline';
import { user } from './timeline.testUtils';

describe('buildTimeline', () => {
  it('toolResult 折进对应 toolCall 条目，不单独成行', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'file body' }],
        },
      ],
      false
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      summary: 'a.ts',
      output: 'file body',
      state: 'ok',
    });
  });

  it('read 图片（含 svg / 动图）把可预览的绝对路径带到工具行，文本和失败不带', () => {
    expect(readImagePreviewPath({ path: '/tmp/a.png' })).toBe('/tmp/a.png');
    expect(readImagePreviewPath({ path: '/tmp/icon.svg' })).toBe('/tmp/icon.svg');
    expect(readImagePreviewPath({ path: '/tmp/anim.gif' })).toBe('/tmp/anim.gif');
    expect(readImagePreviewPath({ path: '/tmp/anim.webp' })).toBe('/tmp/anim.webp');
    expect(readImagePreviewPath({ path: 'assets/logo.svg' }, '/proj')).toBe(
      '/proj/assets/logo.svg'
    );
    expect(readImagePreviewPath({ path: 'a.ts' }, '/proj')).toBeNull();
    expect(readImagePreviewPath({ path: 'a.png' })).toBeNull();
    expect(readImagePreviewPath({})).toBeNull();
    expect(readImagePreviewPath({ path: 'C:\\a\\b.png' })).toBe('C:\\a\\b.png');
    expect(readImagePreviewPath({ path: 'x.png' }, 'C:\\proj')).toBe('C:\\proj\\x.png');
    expect(readImagePreviewPath({ path: '\\\\server\\share\\a.png' })).toBeNull();
    expect(readImagePreviewPath({ path: '//server/share/a.png' })).toBeNull();
    expect(readImagePreviewPath({ path: 1, file_path: '/tmp/a.webp' })).toBe('/tmp/a.webp');

    const image = buildTimeline(
      [
        user('看图'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'img', name: 'read', arguments: { path: 'shot.png' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'img',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'Read image file [image/png]' }],
        },
      ],
      false,
      [],
      '/proj'
    );
    expect(image[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      imagePath: '/proj/shot.png',
      output: 'Read image file [image/png]',
    });

    const failed = buildTimeline(
      [
        user('看图'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'bad', name: 'read', arguments: { path: '/tmp/missing.png' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'bad',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'ENOENT' }],
        },
      ],
      false,
      [],
      '/proj'
    );
    expect(failed[1]).toMatchObject({ kind: 'tool', state: 'error' });
    expect(failed[1]).not.toHaveProperty('imagePath');
  });

  it('把 toolResult 的 RTK 元数据完整带到对应工具行', () => {
    const rtk = {
      status: 'compressed' as const,
      originalCommand: 'git status --short',
      rewrittenCommand: 'rtk git status --short',
      inputTokens: 800,
      outputTokens: 200,
      reason: 'supported command',
    };
    const timeline = buildTimeline(
      [
        user('检查状态'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 't1',
              name: 'bash',
              arguments: { command: rtk.originalCommand },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'clean' }],
          rtk,
        },
      ],
      false
    );

    expect(timeline[1]).toMatchObject({ kind: 'tool', rtk });
  });

  it('托管拒绝的判定记录带到对应工具行，工具行为失败', () => {
    const approvalReview = {
      verdict: 'deny' as const,
      model: 'jev-latest',
      allow: 0.67,
      ask: 0.1,
      block: 0.23,
      reason: 'unclear_target' as const,
    };
    const timeline = buildTimeline(
      [
        user('看下数据库'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '.env' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'Auto-managed approval denied this tool call.' }],
          approvalReview,
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'error', approvalReview });
  });

  it('运行中的命令行带调用 id 供转后台；转后台的结果带任务 id', () => {
    const call = (id: string, name: string): TimelineMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: { command: 'sleep 99' } }],
    });
    const running = buildTimeline([user('跑'), call('t1', 'bash')], true);
    expect(running[1]).toMatchObject({ kind: 'tool', state: 'running', callId: 't1' });
    expect(buildTimeline([user('读'), call('r1', 'read')], true)[1]).not.toHaveProperty('callId');

    const moved = buildTimeline(
      [
        user('跑'),
        call('t1', 'powershell'),
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'powershell',
          content: [{ type: 'text', text: 'moved' }],
          backgroundTaskId: 'task-1-abc',
        },
      ],
      false
    );
    expect(moved[1]).toMatchObject({ kind: 'tool', state: 'ok', backgroundTaskId: 'task-1-abc' });
    expect(moved[1]).not.toHaveProperty('callId');

    const failed = buildTimeline(
      [
        user('跑'),
        call('t2', 'bash'),
        {
          role: 'toolResult',
          toolCallId: 't2',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'sudo: a terminal is required' }],
          shellFailure: { kind: 'tty_required', retryable: false, exitCode: 1 },
        },
      ],
      false
    );
    expect(failed[1]).toMatchObject({
      kind: 'tool',
      state: 'error',
      shellFailure: { kind: 'tty_required', retryable: false, exitCode: 1 },
    });
  });

  it('运行中的阻塞等待带调用 id 与等待类型，供「不等了」', () => {
    const call = (id: string, name: string, args: Record<string, unknown>): TimelineMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: args }],
    });
    const row = (name: string, args: Record<string, unknown>) =>
      buildTimeline([user('等'), call('w1', name, args)], true)[1];
    expect(row('subagent', { operation: 'wait', runId: 'r' })).toMatchObject({
      callId: 'w1',
      waiting: 'subagent',
    });
    expect(
      row('subagent', { operation: 'spawn', description: 'd', prompt: 'p', wait: true })
    ).toMatchObject({ callId: 'w1', waiting: 'subagent' });
    expect(row('task_output', { taskId: 't', timeout_ms: 1000 })).toMatchObject({
      callId: 'w1',
      waiting: 'task',
    });
    expect(
      row('subagent', { operation: 'spawn', description: 'd', prompt: 'p' })
    ).not.toHaveProperty('waiting');
    expect(row('task_output', { taskId: 't' })).not.toHaveProperty('callId');
  });

  it('exec 摘要用首行 JS，source 保留全文，结果 JSON 解析为 value/calls', () => {
    const code = 'const pkg = await read({ path: "package.json" });\nreturn pkg;';
    const output = JSON.stringify({
      status: 'completed',
      value: { ok: true },
      calls: [
        { name: 'read', ok: true },
        { name: 'ls', ok: true },
      ],
    });
    const timeline = buildTimeline(
      [
        user('试试 code mode'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'e1', name: 'exec', arguments: { code } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'e1',
          toolName: 'exec',
          isError: false,
          content: [{ type: 'text', text: output }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'exec',
      summary: 'const pkg = await read({ path: "package.json" });',
      source: code,
      output,
      state: 'ok',
    });
    expect(parseSandboxOutput(output)).toEqual({
      status: 'completed',
      value: { ok: true },
      calls: [
        { name: 'read', ok: true },
        { name: 'ls', ok: true },
      ],
    });
  });

  it('codemode 卡片：剥掉 pi 结果头，嵌套调用摘要来自 codemodeCalls，失败标 error', () => {
    const code = 'const a = await tools.read({ path: "a.ts" });\nreturn a.length;';
    const timeline = buildTimeline(
      [
        user('用 codemode'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'codemode', arguments: { code } },
            { type: 'toolCall', id: 'c2', name: 'codemode', arguments: { code: 'throw 1' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'codemode',
          isError: false,
          codemodeCalls: [{ name: 'read', ok: true, summary: 'a.ts' }],
          content: [{ type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n42' }],
        },
        {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'codemode',
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error: 1',
            },
          ],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'codemode',
      source: code,
      output: '42',
      state: 'ok',
      sandbox: { status: 'completed', value: '42', calls: [{ name: 'read', ok: true }] },
    });
    expect(timeline[2]).toMatchObject({
      state: 'error',
      sandbox: { status: 'failed', error: 'Script error: 1', calls: [] },
    });
  });

  it('codemode 卡片：console 块拆成独立字段并去掉标签', () => {
    expect(codemodeView('<console_output>\nkeys [1]\n 0\n</console_output>', false, null)).toEqual({
      status: 'completed',
      value: '',
      console: 'keys [1]\n 0',
      calls: [],
    });
    expect(codemodeView('42\n<console_output>\na\n\nb\n</console_output>', false, null)).toEqual({
      status: 'completed',
      value: '42',
      console: 'a\n\nb',
      calls: [],
    });
    expect(
      codemodeView('<console_output>\nlog\n</console_output>\nScript error:\nboom', true, null)
    ).toEqual({ status: 'failed', error: 'Script error:\nboom', console: 'log', calls: [] });
    // 截断后缺闭合标签：原样保留
    const cut = '<console_output>\nlog…truncated';
    expect(codemodeView(cut, false, null)).toEqual({ status: 'completed', value: cut, calls: [] });
  });

  it('codemode 运行中按 <parent>/<n> 统计嵌套待审批', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'codemode', arguments: { code: 'x' } }],
        },
      ],
      true,
      [],
      undefined,
      {
        pendingApprovals: [
          {
            requestId: 'apr-1',
            tool: 'apply_patch',
            kind: 'file-edit',
            summary: 'a.ts',
            toolCallId: 'c1/1',
          },
          {
            requestId: 'apr-2',
            tool: 'bash',
            kind: 'command',
            summary: 'ls',
            toolCallId: 'c10/1',
          },
        ],
      }
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'running', nestedPending: 1 });
  });

  it('exec 调用按工具名首次出现顺序计数', () => {
    expect(
      summarizeSandboxCalls([
        { name: 'grep', ok: true },
        { name: 'read', ok: true },
        { name: 'grep', ok: false },
        { name: 'grep', ok: true },
      ])
    ).toBe('grep ×3 read ×1');
    expect(summarizeSandboxCalls([])).toBe('');
  });

  it('Hashline edit 从头部提取路径并从 toolResult 生成 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'hashline-1',
              name: 'edit',
              arguments: { input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+hello' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'hashline-1',
          toolName: 'edit',
          editDiff: { oldText: 'world\n', newText: 'hello\n' },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'edit',
      summary: 'src/a.ts',
      edits: [{ oldText: 'world\n', newText: 'hello\n' }],
      state: 'ok',
    });
  });

  it('legacy 单块 {path,oldText,newText} edit 也生成 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'e1',
              name: 'edit',
              arguments: { path: 'src/a.ts', oldText: 'world', newText: 'hello' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'e1',
          toolName: 'edit',
          content: [{ type: 'text', text: 'Successfully replaced 1 block(s)' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      name: 'edit',
      summary: 'src/a.ts',
      edits: [{ oldText: 'world', newText: 'hello' }],
    });
  });

  it('edit 执行失败时不合成 diff：文件没改，不能显示成已应用', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'e-err',
              name: 'edit',
              arguments: {
                path: 'src/a.ts',
                input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+x',
                oldText: 'world',
                newText: 'hello',
              },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'e-err',
          toolName: 'edit',
          isError: true,
          content: [
            { type: 'text', text: 'edit accepts either hashline input or replace edits, not both' },
          ],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ name: 'edit', state: 'error', edits: null });
  });

  it('replace edit 没有 editDiff 时继续使用参数中的路径与 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'replace-1',
              name: 'edit',
              arguments: { path: 'b.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'replace-1',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      summary: 'b.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
      state: 'ok',
    });
  });

  it('参数 edits 优先于 toolResult editDiff', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'both-1',
              name: 'edit',
              arguments: { path: 'b.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'both-1',
          toolName: 'edit',
          editDiff: { oldText: 'wrong-old', newText: 'wrong-new' },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      summary: 'b.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
  });

  it('仍在运行的 Hashline edit 显示头部路径且 edits 为 null', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'running-1',
              name: 'edit',
              arguments: { input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+hello' },
            },
          ],
        },
      ],
      true
    );
    expect(timeline[1]).toMatchObject({ summary: 'src/a.ts', edits: null, state: 'running' });
  });

  it('不完整 editDiff 不生成 edits 且不抛错', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'dirty-1', name: 'edit', arguments: {} }],
        },
        {
          role: 'toolResult',
          toolCallId: 'dirty-1',
          toolName: 'edit',
          editDiff: { oldText: 'before\n' } as unknown as { oldText: string; newText: string },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', edits: null, state: 'ok' });
  });

  it('无结果的 toolCall 在会话 running 且 pending reviewing 时标 reviewing', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts' } }],
        },
      ],
      true,
      [],
      undefined,
      {
        pendingApprovals: [
          {
            requestId: 'apr-1',
            tool: 'write',
            kind: 'file-write',
            summary: 'a.ts',
            toolCallId: 't1',
            phase: 'reviewing',
          },
        ],
      }
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'reviewing', name: 'write' });
  });

  it('无结果的 toolCall 在会话 running 时标为 running', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'running', summary: 'pnpm test' });
  });

  it('无结果的 toolCall 在会话 idle 时标为 error（中断残留，不再 loading）', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'error', output: null });
  });

  it('历史轮次里缺结果的 toolCall（abort 残留/同步未齐）不标 running，即使会话正在运行', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'a.ts' } }],
        },
        user('继续'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'ls' } }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', name: 'edit', state: 'ok' });
    expect(timeline[2]).toMatchObject({ kind: 'tool', name: 'bash', state: 'running' });
  });

  it('末条 assistant 后只跟 toolResult：已完成的标终态，并行未完成的仍标 running', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          isError: false,
          content: [{ type: 'text', text: 'body' }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', name: 'read', state: 'ok' });
    expect(timeline[1]).toMatchObject({ kind: 'tool', name: 'bash', state: 'running' });
  });

  it('失败的 toolResult 标为 error', () => {
    const timeline = buildTimeline(
      [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'edit' }] },
        {
          role: 'toolResult',
          toolCallId: 't1',
          isError: true,
          content: [{ type: 'text', text: 'no match' }],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'error', output: 'no match' });
  });

  it('text 与 thinking 各自成块，最后一块在 running 时标 streaming', () => {
    const timeline = buildTimeline(
      [
        user('hi'),
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '想一想' },
            { type: 'text', text: '回答' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
    expect(timeline.some((item) => item.kind === 'text' && item.turnEnd)).toBe(false);
  });

  it('idle 时本轮最后一条正文标 turnEnd，中间步不标', () => {
    const timeline = buildTimeline(
      [
        user('改'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '先看' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '结论' }],
        },
        user('还没答'),
      ],
      false
    );
    expect(timeline.filter((item) => item.kind === 'text')).toMatchObject([
      { text: '先看' },
      { text: '结论', turnEnd: true },
    ]);
    expect(timeline.filter((item) => item.kind === 'text' && item.turnEnd)).toHaveLength(1);
  });

  it('整段 <thinking> 包裹的 text 变成 thinking 块，标签不入正文', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<thinking>\n**Analyzing** antigravity.ts\n</thinking>',
            },
          ],
        },
      ],
      false
    );
    expect(timeline).toEqual([
      {
        kind: 'thinking',
        key: '0-0',
        text: '**Analyzing** antigravity.ts',
        streaming: false,
        durationMs: null,
      },
    ]);
  });

  it('正文中夹着的 <thinking> 拆成 thinking 与 text，工具行不受影响', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<thinking>\n先 grep\n</thinking>',
            },
            { type: 'toolCall', id: 't1', name: 'grep', arguments: { pattern: 'high' } },
            {
              type: 'text',
              text: '前缀<thinking>再读文件</thinking>\n结论',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'grep',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline).toMatchObject([
      { kind: 'thinking', text: '先 grep', streaming: false },
      { kind: 'tool', name: 'grep', state: 'ok' },
      { kind: 'text', text: '前缀' },
      { kind: 'thinking', text: '再读文件' },
      { kind: 'text', text: '结论' },
    ]);
  });

  it('流式中未闭合的 <thinking> 当 thinking 跟看，不露开标签', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '<thinking>\n正在想' }],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([{ kind: 'thinking', text: '正在想', streaming: true }]);
  });

  it('多 step 轮次：末 step 的 turnMs 累计模型与工具活跃用时，中间 step 不带', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          timing: { stepStartMs: 1_000, firstTokenMs: 1_500, completedMs: 3_000 },
          content: [
            { type: 'text', text: '先看看' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          toolDurationMs: 30_000,
          content: [{ type: 'text', text: 'body' }],
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 60_000, firstTokenMs: 61_000, completedMs: 87_000 },
          content: [{ type: 'text', text: '完成' }],
        },
      ],
      false
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatchObject({ perf: { runMs: 2_000 } });
    expect(texts[0].kind === 'text' && texts[0].perf?.turnMs).toBeUndefined();
    // 模型 2s + 工具 30s + 模型 27s；中间 27s 空档不计。
    expect(texts[1]).toMatchObject({ perf: { runMs: 27_000, turnMs: 59_000 } });
  });

  it('整轮总用时不包含等待 ask_user 回答的时间', () => {
    const timeline = buildTimeline(
      [
        user('先问我再继续'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          duration: 2_000,
          timing: { stepStartMs: 1_000, completedMs: 3_000 },
          content: [
            {
              type: 'toolCall',
              id: 'ask-1',
              name: 'ask_user',
              arguments: { question: '继续吗？' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'ask-1',
          toolName: 'ask_user',
          toolDurationMs: 20 * 60_000,
          content: [{ type: 'text', text: '继续' }],
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          duration: 3_000,
          timing: { stepStartMs: 20 * 60_000 + 3_000, completedMs: 20 * 60_000 + 6_000 },
          content: [{ type: 'text', text: '完成' }],
        },
      ],
      false
    );
    const lastText = timeline.findLast((item) => item.kind === 'text');
    expect(lastText).toMatchObject({ perf: { runMs: 3_000, turnMs: 5_000 } });
  });

  it('单 step 轮次不带 turnMs（与 runMs 重复）；新一轮 user 消息重置轮起点', () => {
    const timeline = buildTimeline(
      [
        user('a'),
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 1_000, completedMs: 2_000 },
          content: [{ type: 'text', text: '一' }],
        },
        user('b'),
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 10_000, completedMs: 12_000 },
          content: [{ type: 'text', text: '二' }],
        },
      ],
      false
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts[0]).toMatchObject({ perf: { runMs: 1_000 } });
    expect(texts[1]).toMatchObject({ perf: { runMs: 2_000 } });
    for (const item of texts) {
      expect(item.kind === 'text' && item.perf?.turnMs).toBeUndefined();
    }
  });

  it('轮次仍在 running（末 step 未完成）时不带 turnMs', () => {
    const timeline = buildTimeline(
      [
        user('a'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          timing: { stepStartMs: 1_000, completedMs: 2_000 },
          content: [{ type: 'text', text: '一' }],
        },
        {
          role: 'assistant',
          stopReason: 'pending',
          timing: { stepStartMs: 5_000 },
          content: [{ type: 'text', text: '二' }],
        },
      ],
      true
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts[1].kind === 'text' && texts[1].perf).toBeUndefined();
  });

  it('空内容的 part 不产出条目', () => {
    const timeline = buildTimeline(
      [{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'unknown' }] }],
      false
    );
    expect(timeline).toHaveLength(0);
  });

  it('merges parent custom notifications by time without converting them into messages', () => {
    const messages: ProjectedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'before' }],
        timestamp: 10,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'after' }],
        timestamp: 30,
      },
    ];
    const customEntries = [
      {
        kind: 'agent-dispatch' as const,
        child: {
          sessionId: 'parent::cw-child',
          generation: 'child-g1',
          instanceId: '123e4567-e89b-42d3-a456-426614174000',
          instanceName: 'Scout · a1',
          typeKey: 'builtin:scout' as const,
        },
        at: 20,
      },
    ];
    const timeline = buildTimeline(messages, false, customEntries);
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'session-custom', 'text']);
    expect(messages).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'session-custom',
      entry: { kind: 'agent-dispatch' },
    });
  });

  it('工具批次标签不单独成行，挂到批次首个工具行上', () => {
    const messages: ProjectedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'grep', arguments: { pattern: 'x' } },
          { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'a' } },
        ],
        timestamp: 10,
      } as ProjectedMessage,
    ];
    const timeline = buildTimeline(messages, false, [
      { kind: 'tool-batch-label', callId: 'c1', label: 'Searched auth', at: 20 },
    ]);
    expect(timeline.some((item) => item.kind === 'session-custom')).toBe(false);
    const tools = timeline.filter((item) => item.kind === 'tool');
    expect(tools.map((item) => (item.kind === 'tool' ? item.batchLabel : null))).toEqual([
      'Searched auth',
      undefined,
    ]);
  });

  it('keeps the complete child capability receipt in a custom timeline row', () => {
    const receiptEntry = {
      kind: 'capability-receipt' as const,
      receipt: {
        receiptId: '123e4567-e89b-42d3-a456-426614174040',
        operationId: '123e4567-e89b-42d3-a456-426614174041',
        child: {
          sessionId: 'parent::cw-enso',
          generation: 'enso-g1',
          parent: { sessionId: 'parent', generation: 'parent-g1' },
          instanceId: '123e4567-e89b-42d3-a456-426614174042',
          instanceName: 'Enso · a1',
          typeKey: 'agent:enso' as const,
          profileId: 'enso-locked-v1' as const,
        },
        turnId: 'turn-1',
        requestId: '123e4567-e89b-42d3-a456-426614174043',
        capabilityId: 'appearance.theme' as const,
        risk: 'reversible' as const,
        subject: { kind: 'setting' as const, id: 'theme', label: 'Theme' },
        outcome: 'succeeded' as const,
        summary: 'Theme changed to dark',
        changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
        occurredAt: 20,
        sequence: 1,
      },
    };
    const timeline = buildTimeline([], false, [receiptEntry]);
    expect(timeline).toMatchObject([
      {
        kind: 'session-custom',
        entry: {
          kind: 'capability-receipt',
          receipt: {
            outcome: 'succeeded',
            changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
          },
        },
      },
    ]);
  });
});
