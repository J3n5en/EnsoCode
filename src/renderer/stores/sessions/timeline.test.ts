import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  completedEditWriteFingerprint,
  foldTimeline,
  historyPageChrome,
  isReadOnlyCommand,
  parseSandboxOutput,
  patchStreamingTimeline,
  shouldAutoExpandAppliedFileChanges,
  shouldPrefetchOlderHistory,
  shouldShowToolOutputAfterFileChanges,
  type TimelineItem,
  terminalErrorText,
} from './timeline';

const user = (text: string): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('historyPageChrome', () => {
  it('空时间线不占 Header，避免盖住 Preparing / 空态', () => {
    expect(historyPageChrome(false, true, false)).toBe('none');
    expect(historyPageChrome(false, false, false)).toBe('none');
  });

  it('有消息时：在途 loading、翻到顶才 start、短会话不提示开头', () => {
    expect(historyPageChrome(true, true, true)).toBe('loading');
    expect(historyPageChrome(true, true, false, true)).toBe('loading');
    expect(historyPageChrome(true, false, false)).toBe('none');
    expect(historyPageChrome(true, false, false, false)).toBe('none');
    expect(historyPageChrome(true, false, false, true)).toBe('start');
    expect(historyPageChrome(true, false, true)).toBe('none');
    expect(historyPageChrome(true, false, undefined)).toBe('none');
  });
});

describe('shouldPrefetchOlderHistory', () => {
  it('工具组收拢后撑不满视口时给出加载入口，不在进会话时自动拉一页', () => {
    expect(shouldPrefetchOlderHistory(true, false, 400, 700)).toBe(true);
    expect(shouldPrefetchOlderHistory(true, false, 700, 700)).toBe(true);
    expect(shouldPrefetchOlderHistory(true, false, 780, 700)).toBe(true);
    expect(historyPageChrome(true, false, true, false, true)).toBe('more');
    expect(historyPageChrome(true, false, true)).toBe('none');
  });

  it('内容已经超出视口、正在加载、或没有更早历史时不预取', () => {
    expect(shouldPrefetchOlderHistory(true, false, 1200, 700)).toBe(false);
    expect(shouldPrefetchOlderHistory(true, true, 400, 700)).toBe(false);
    expect(shouldPrefetchOlderHistory(false, false, 400, 700)).toBe(false);
  });
});

describe('buildTimeline', () => {
  it('historyBaseIndex 让行 key 用绝对下标，prepend 后已有行 key 不变', () => {
    const timeline = buildTimeline([user('tail')], false, [], undefined, {
      historyBaseIndex: 40,
    });
    expect(timeline[0]).toMatchObject({ kind: 'user', key: '40', text: 'tail' });
  });

  describe('user 消息发送时间与任务完成耗时统计', () => {
    it('user 消息保留发送时间戳 timestamp', () => {
      const timeline = buildTimeline(
        [{ role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1726700000000 }],
        false
      );
      expect(timeline[0]).toMatchObject({
        kind: 'user',
        timestamp: 1726700000000,
      });
    });

    it('会话运行中（running=true）时，最新一轮 assistant 消息的 turnDurationMs 为 undefined', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '写个函数' }], timestamp: 1726700000000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '正在写...' }],
            duration: 2000,
            stopReason: 'pending',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700002000 },
          },
        ],
        true
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0].kind).toBe('text');
      expect(textItems[0].turnDurationMs).toBeUndefined();
      expect(textItems[0].turnEnd).toBeUndefined();
    });

    it('会话结束后（running=false），assistant 消息计算本轮模型与工具活跃总耗时', () => {
      const timeline = buildTimeline(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: '查一下并修改' }],
            timestamp: 1726700000000,
          },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
            duration: 1500,
            stopReason: 'toolUse',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700001500 },
          },
          {
            role: 'toolResult',
            toolCallId: 't1',
            toolName: 'read',
            toolDurationMs: 800,
            content: [{ type: 'text', text: 'content' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '已读完' }],
            duration: 2200,
            stopReason: 'stop',
            timing: { stepStartMs: 1726700002300, completedMs: 1726700004500 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 4500, // 1500 + 800 + 2200
        perf: { runMs: 2200, turnMs: 4500 },
      });
    });

    it('整轮耗时不计 ask_user 等待时间', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问个问题' }], timestamp: 1726700000000 },
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { question: '确定？' } },
            ],
            duration: 1000,
            stopReason: 'toolUse',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700001000 },
          },
          {
            role: 'toolResult',
            toolCallId: 'q1',
            toolName: 'ask_user',
            toolDurationMs: 60000,
            content: [{ type: 'text', text: '确定' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '好的已继续' }],
            duration: 2000,
            stopReason: 'stop',
            timing: { stepStartMs: 1726700061000, completedMs: 1726700063000 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 3000, // 1000 + 2000，排除 ask_user 的 60000
        perf: { runMs: 2000, turnMs: 3000 },
      });
    });

    it('多轮对话：历史轮次保留耗时，当前运行中轮次耗时待完结', () => {
      const timeline = buildTimeline(
        [
          // 第一轮
          { role: 'user', content: [{ type: 'text', text: '第一轮' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答1' }],
            duration: 1200,
            stopReason: 'stop',
            timing: { stepStartMs: 1000, completedMs: 2200 },
          },
          // 第二轮（进行中）
          { role: 'user', content: [{ type: 'text', text: '第二轮' }], timestamp: 3000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答2进行中...' }],
            duration: 800,
            stopReason: 'pending',
            timing: { stepStartMs: 3000 },
          },
        ],
        true
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems).toHaveLength(2);
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnDurationMs: 1200,
      });
      expect(textItems[1]).toMatchObject({
        kind: 'text',
      });
      expect(textItems[1].turnDurationMs).toBeUndefined();
    });

    it('若无 stepRunMs/toolDurationMs，则以 assistant 时间戳与 user 时间戳之差作为耗时兜底', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 },
          { role: 'assistant', content: [{ type: 'text', text: '你好呀' }], timestamp: 3500 },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems).toHaveLength(1);
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 2500, // 3500 - 1000
      });
    });

    it('最新一轮 stopReason=pending 时不展示耗时（即使 running=false）', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '半截' }],
            duration: 2000,
            stopReason: 'pending',
            timing: { stepStartMs: 1000, completedMs: 3000 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });

    it('仅有 duration、无 timing.completedMs 时不计入活跃用时', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '你好呀' }],
            duration: 5000,
            stopReason: 'stop',
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });

    it('有 ask_user 但缺 step 计时时，不用墙钟差兜底（避免把等待算进去）', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问个问题' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { question: '确定？' } },
            ],
            stopReason: 'toolUse',
          },
          {
            role: 'toolResult',
            toolCallId: 'q1',
            toolName: 'ask_user',
            content: [{ type: 'text', text: '确定' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            timestamp: 70_000,
            stopReason: 'stop',
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });
  });

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

const toolItem = (key: string, name = 'bash', edits: TimelineItem[] = []): TimelineItem =>
  ({
    kind: 'tool',
    key,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: edits.length > 0 ? [{ oldText: 'a', newText: 'b' }] : null,
  }) as TimelineItem;

const userItem = (key: string): TimelineItem => ({ kind: 'user', key, text: 'q', images: [] });
const textItem = (key: string): TimelineItem => ({
  kind: 'text',
  key,
  text: 'a',
  streaming: false,
});
const thinkingItem = (key: string): TimelineItem => ({
  kind: 'thinking',
  key,
  text: 't',
  streaming: false,
  durationMs: null,
});

describe('重试过的瞬态错误不渲染', () => {
  const err = (text = '503 status code (no body)'): ProjectedMessage => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: text,
  });
  const assistant = (text: string): ProjectedMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const user = (text: string): ProjectedMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });

  it('错误消息紧跟另一条 assistant（已重试）时不产生 error 项，末条保留', () => {
    // 回放场景：耗尽失败的一轮在 session 文件里留下每次尝试的错误消息
    const items = buildTimeline([user('q'), err(), err(), err(), err()], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(1);
  });

  it('重试成功后回放：错误项全部隐藏', () => {
    const items = buildTimeline([user('q'), err(), assistant('ok')], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(0);
  });

  it('终态错误后面是新一轮 user 消息：错误项保留', () => {
    const items = buildTimeline([user('q'), err(), user('again'), assistant('ok')], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(1);
  });

  it('running 中的末条错误（重试倒计时）从一开始就不渲染，终态（非 running）才渲染', () => {
    // 先渲染再删除会导致屏幕抽搐：running 期间错误文本只展示在 RetryBar 上
    const messages = [user('q'), err()];
    expect(buildTimeline(messages, true).filter((item) => item.kind === 'error')).toHaveLength(0);
    expect(buildTimeline(messages, false).filter((item) => item.kind === 'error')).toHaveLength(1);
  });
});

describe('terminalErrorText', () => {
  const errored: ProjectedMessage = {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: '503 status code (no body)',
  };

  it('消息已展示同一错误时不重复显示底部错误', () => {
    expect(terminalErrorText([errored], '503 status code (no body)')).toBeUndefined();
  });

  it('无同文本错误消息时原样返回（spawn 失败等没有消息载体的错误）', () => {
    expect(terminalErrorText([], 'invalid spawn request')).toBe('invalid spawn request');
    expect(terminalErrorText([errored], 'other error')).toBe('other error');
  });

  it('error 为空时返回 undefined', () => {
    expect(terminalErrorText([errored], undefined)).toBeUndefined();
  });
});

describe('isReadOnlyCommand', () => {
  it.each([
    'ls -la',
    'rg -n "foo" src',
    'grep -r foo . | head -20',
    'cat package.json',
    'find . -name "*.ts" | wc -l',
    'git status && git log --oneline -5',
    'cd packages/phone && ls src',
    'FOO=1 rg foo 2>/dev/null',
    'rg foo 2>&1 | sort | uniq -c',
    '/usr/bin/tree -L 2',
    'sed -n 1,20p src/a.ts',
    'git diff --stat',
    'git remote -v',
    'git config --get user.name',
    'LC_ALL=C sort a.txt',
    "awk -F: '{print $1}' /etc/passwd",
    'yq .a f.yml',
  ])('只读：%s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf dist',
    'ls > out.txt',
    'cat a >> b',
    'sed -i "s/a/b/" x',
    'find . -name "*.log" -delete',
    'find . -exec rm {} \\;',
    'git commit -m x',
    'git checkout -- .',
    'ls && npm install',
    'echo $(rm -rf x)',
    'pnpm test',
    'xargs rm',
    '',
    // 绕过向量
    'ls & rm -rf x',
    'cat <(rm -rf x)',
    'env rm -rf x',
    'awk \'BEGIN{system("rm -rf x")}\' a.txt',
    "sed 's/a/b/e' a.txt",
    'sed --in-place=.bak s/a/b/ x',
    'yq -i .a=1 f.yml',
    'sort -o out.txt in.txt',
    'git log --output=/tmp/x',
    'find . -execdir rm {} \\;',
    'find . -fprint /tmp/x',
    'git config --unset user.name',
    'git remote remove origin',
    'GIT_EXTERNAL_DIFF=./evil git diff',
    'rg foo 2>err.txt',
    'ls\rrm -rf x',
  ])('非只读：%s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });
});

describe('foldTimeline', () => {
  it.each([false, true])('compact=%s：同一回复的连续思考合并，耗时只计一次', (compact) => {
    const messages: ProjectedMessage[] = [
      user('检查布局'),
      {
        role: 'assistant',
        stopReason: 'stop',
        timing: { stepStartMs: 1000, thinkingEndMs: 114000, completedMs: 115000 },
        content: [
          { type: 'thinking', text: '**Preparing focus measurement**' },
          { type: 'text', text: '  \n' },
          { type: 'thinking', text: '**Preparing editor geometry baseline**' },
          { type: 'thinking', text: '**Preparing delayed geometry check**' },
          { type: 'text', text: '完成' },
        ],
      },
    ];
    const items = buildTimeline(messages, false, [], undefined, { historyBaseIndex: 40 });
    const before = structuredClone(items);
    const folded = foldTimeline(items, false, new Set(), { compact });
    expect(folded).toMatchObject([
      { kind: 'user' },
      {
        kind: 'thinking',
        key: '41-0',
        text: '**Preparing focus measurement**\n\n**Preparing editor geometry baseline**\n\n**Preparing delayed geometry check**',
        streaming: false,
        durationMs: 113000,
        startedAt: 1000,
      },
      { kind: 'text', text: '完成' },
    ]);
    expect(items).toEqual(before);
    expect(folded[0]).toBe(items[0]);
    expect(folded[2]).toBe(items.at(-1));
  });

  it('连续的标签思考与原生思考合并，并保留已知计时', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          timing: { stepStartMs: 1000, completedMs: 5000 },
          content: [
            { type: 'text', text: '<thinking>先检查</thinking><thinking>再测量</thinking>' },
            { type: 'thinking', text: '原生思考' },
            { type: 'text', text: '<thinking>最后核对</thinking>' },
          ],
        },
      ],
      false
    );
    expect(foldTimeline(items, false, new Set())).toEqual([
      {
        kind: 'thinking',
        key: '0-0-0',
        text: '先检查\n\n再测量\n\n原生思考\n\n最后核对',
        streaming: false,
        durationMs: 4000,
        startedAt: 1000,
      },
    ]);
  });

  it('流式新增思考片段和后续补丁沿用首段 key，结束后整块停止流式', () => {
    const snapshot = (texts: string[], settled = false): ProjectedMessage[] => [
      user('检查'),
      {
        role: 'assistant',
        stopReason: settled ? 'stop' : 'pending',
        content: [
          ...texts.map((text) => ({ type: 'thinking' as const, text })),
          { type: 'text', text: '' },
        ],
      },
    ];
    const first = foldTimeline(buildTimeline(snapshot(['第一段']), true), true, new Set());
    const raw = buildTimeline(snapshot(['第一段', '第二']), true);
    const nextMessages = snapshot(['第一段', '第二段']);
    const patched = patchStreamingTimeline(raw, nextMessages, true);
    expect(patched).not.toBeNull();
    const folded = foldTimeline(patched!, true, new Set());
    expect(foldTimeline(raw, true, new Set())).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', key: first[1].key, text: '第一段\n\n第二', streaming: true },
    ]);
    expect(folded).toMatchObject([
      { kind: 'user' },
      {
        kind: 'thinking',
        key: first[1].key,
        text: '第一段\n\n第二段',
        streaming: true,
        durationMs: null,
      },
    ]);
    expect(folded).toEqual(foldTimeline(buildTimeline(nextMessages, true), true, new Set()));
    expect(
      foldTimeline(buildTimeline(snapshot(['第一段', '第二段'], true), false), false, new Set())
    ).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', key: first[1].key, text: '第一段\n\n第二段', streaming: false },
    ]);
  });

  it('正文、工具和不同回复之间的思考不合并', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '一' },
            { type: 'text', text: '说明' },
            { type: 'thinking', text: '二' },
            { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'thinking', text: '三' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', text: '四' }] },
        user('继续'),
        { role: 'assistant', content: [{ type: 'thinking', text: '五' }] },
      ],
      false
    );
    expect(foldTimeline(items, false, new Set())).toEqual(items);
  });

  it('工具组展开后也只展示一个连续思考块，不改变工具顺序和计数', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'r1', name: 'read' },
            { type: 'thinking', text: '一' },
            { type: 'thinking', text: '二' },
            { type: 'toolCall', id: 'r2', name: 'read' },
            { type: 'toolCall', id: 'r3', name: 'read' },
          ],
        },
      ],
      false
    );
    const collapsed = foldTimeline(items, false, new Set());
    const expanded = foldTimeline(items, false, new Set([collapsed[0].key]));
    expect(collapsed).toMatchObject([
      {
        kind: 'tool-group',
        count: 3,
        children: [
          { kind: 'tool', key: '0-0' },
          { kind: 'thinking', key: '0-1', text: '一\n\n二' },
          { kind: 'tool', key: '0-3' },
          { kind: 'tool', key: '0-4' },
        ],
      },
    ]);
    expect(expanded.map((item) => item.key)).toEqual([
      collapsed[0].key,
      '0-0',
      '0-1',
      '0-3',
      '0-4',
    ]);
  });

  it('compact：只读 bash 进探索组，cat 记作 read、rg 记作 search', () => {
    const items = [
      { ...toolItem('a1', 'bash'), summary: 'cat README.md' },
      { ...toolItem('a2', 'bash'), summary: 'rg -n foo src' },
      toolItem('a3', 'read'),
      { ...toolItem('b', 'bash'), summary: 'pnpm test' },
    ] as TimelineItem[];
    const folded = foldTimeline(items, false, new Set(), { compact: true });
    expect(folded.map((i) => (i.kind === 'tool' ? i.summary : i.kind))).toEqual([
      'tool-group',
      'pnpm test',
    ]);
    const group = folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 1, others: 0 });
  });

  it('连续 ≥3 条工具收拢为组头，thinking 收进组，统计归类', () => {
    const items = [
      userItem('u0'),
      toolItem('t1', 'bash'),
      thinkingItem('th'),
      toolItem('t2', 'read'),
      toolItem('t3', 'grep'),
      textItem('x'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(3);
    expect(group.stats).toEqual({ commands: 1, reads: 1, searches: 1, others: 0 });
  });

  it('不足 3 条工具不折叠', () => {
    const items = [toolItem('t1'), toolItem('t2'), textItem('x')];
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'tool',
      'tool',
      'text',
    ]);
  });

  it('edit(diff)行不进组，平铺在组头之后', () => {
    const items = [
      toolItem('t1'),
      toolItem('e1', 'edit', [{} as TimelineItem]),
      toolItem('t2'),
      toolItem('t3'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).edits).not.toBeNull();
  });

  it('running 时最后一轮的段不折叠，历史段照折', () => {
    const items = [
      userItem('u0'),
      toolItem('a1'),
      toolItem('a2'),
      toolItem('a3'),
      textItem('x'),
      userItem('u1'),
      toolItem('b1'),
      toolItem('b2'),
      toolItem('b3'),
    ];
    const folded = foldTimeline(items, true, new Set());
    expect(folded.map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool',
      'tool',
      'tool',
    ]);
    // 同样的数据 idle 后全部收拢
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool-group',
    ]);
  });

  it('展开的组按原始顺序平铺 children', () => {
    const items = [toolItem('t1'), thinkingItem('th'), toolItem('t2'), toolItem('t3')];
    const collapsed = foldTimeline(items, false, new Set());
    const groupKey = collapsed[0].key;
    const expanded = foldTimeline(items, false, new Set([groupKey]));
    expect(expanded.map((i) => i.key)).toEqual([groupKey, 't1', 'th', 't2', 't3']);
  });

  it('compact：running 只读工具进组，不钉组外', () => {
    const runningTool = { ...toolItem('r', 'read'), state: 'running' } as TimelineItem;
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
      runningTool,
    ];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((i) => i.kind)).toEqual(['user', 'tool-group']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(4);
    expect(group.exploring).toBe(true);
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 2, others: 0 });
    const expanded = foldTimeline(items, true, new Set([group.key]), { compact: true });
    expect(expanded.map((i) => i.key)).toEqual(['u0', group.key, 'a1', 'a2', 'a3', 'r']);
  });

  it('compact 关时 running 最后一轮仍平铺', () => {
    const items = [userItem('u0'), toolItem('a1'), toolItem('a2'), toolItem('a3')];
    expect(foldTimeline(items, true, new Set(), { compact: false }).map((i) => i.kind)).toEqual([
      'user',
      'tool',
      'tool',
      'tool',
    ]);
  });

  it('compact：只读工具才进组，bash 打断段并平铺在外', () => {
    const items = [
      toolItem('a1', 'read'),
      toolItem('a2', 'read'),
      toolItem('a3', 'grep'),
      toolItem('b', 'bash'),
      toolItem('a4', 'read'),
    ];
    const folded = foldTimeline(items, false, new Set(), { compact: true });
    expect(folded.map((i) => (i.kind === 'tool' ? i.name : i.kind))).toEqual([
      'tool-group',
      'bash',
      'read',
    ]);
    const group = folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(3);
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 1, others: 0 });
    expect(group.exploring).toBe(false);
    // 关：沿用旧逻辑，bash 一起收
    const legacy = foldTimeline(items, false, new Set(), { compact: false });
    expect(legacy.map((i) => i.kind)).toEqual(['tool-group']);
    expect((legacy[0] as Extract<TimelineItem, { kind: 'tool-group' }>).count).toBe(5);
  });

  it('compact：组内有 running 只读工具时组头标 exploring', () => {
    const running = { ...toolItem('r', 'read'), state: 'running' } as TimelineItem;
    const items = [toolItem('a1', 'read'), toolItem('a2', 'ls'), toolItem('a3', 'grep'), running];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((i) => i.kind)).toEqual(['tool-group']);
    expect((folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>).exploring).toBe(true);
  });

  it('todo 行不进组，平铺在组头之后', () => {
    const items = [toolItem('t1'), toolItem('td', 'todo'), toolItem('t2'), toolItem('t3')];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).name).toBe('todo');
  });
});

describe('streaming 判定(最后一个有内容的 part)', () => {
  it('thinking 是唯一有内容的 part 且 running 时,thinking 处于流式中', () => {
    const timeline = buildTimeline(
      [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '思考内容...' },
            { type: 'text', text: '' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([{ kind: 'user' }, { kind: 'thinking', streaming: true }]);
  });

  it('thinking 后有非空 text 时,text 流式、thinking 已完结', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 't' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
  });
});

describe('工具路径摘要相对化', () => {
  const cwd = '/Users/j3n5en/project/enso-code';
  const tool = (args: Record<string, unknown>, root?: string) =>
    buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: args }],
        },
      ],
      false,
      [],
      root
    )[0];

  it('项目内绝对路径显示相对路径', () => {
    expect(tool({ path: `${cwd}/src/renderer/components/chat/Markdown.tsx` }, cwd)).toMatchObject({
      summary: 'src/renderer/components/chat/Markdown.tsx',
    });
  });

  it('file_path 同样相对化', () => {
    expect(tool({ file_path: `${cwd}/a.ts` }, cwd)).toMatchObject({ summary: 'a.ts' });
  });

  it('项目外路径保持绝对', () => {
    expect(tool({ path: '/tmp/foo.ts' }, cwd)).toMatchObject({ summary: '/tmp/foo.ts' });
  });

  it('未传 cwd 保持原样', () => {
    expect(tool({ path: `${cwd}/a.ts` })).toMatchObject({ summary: `${cwd}/a.ts` });
  });

  it('前缀碰巧相同的目录不误切', () => {
    expect(tool({ path: `${cwd}-bak/a.ts` }, cwd)).toMatchObject({
      summary: `${cwd}-bak/a.ts`,
    });
  });

  it('cwd 本身显示为 .', () => {
    expect(tool({ path: cwd }, cwd)).toMatchObject({ summary: '.' });
  });

  it('Windows 盘符路径相对 POSIX 项目 cwd', () => {
    expect(tool({ path: 'D:/root/semble/README.md' }, '/root/semble')).toMatchObject({
      summary: 'README.md',
    });
    expect(tool({ path: 'D:\\root\\semble' }, '/root/semble')).toMatchObject({ summary: '.' });
  });

  it('command 不受影响', () => {
    expect(
      buildTimeline(
        [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
            ],
          },
        ],
        false,
        [],
        cwd
      )[0]
    ).toMatchObject({ summary: 'pnpm test' });
  });
});

describe('compaction 摘要行', () => {
  it('compactionSummary 消息渲染为 compaction 行，带摘要与压缩前 token 数', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'SUMMARY' }],
          tokensBefore: 9000,
        },
        user('new'),
      ],
      false
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction', 'user']);
    expect(timeline[1]).toMatchObject({
      kind: 'compaction',
      summary: 'SUMMARY',
      tokensBefore: 9000,
    });
    expect(timeline[1]).not.toHaveProperty('verified');
  });

  it('verified 摘要行带 verified', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'S' }],
          tokensBefore: 1,
          verified: true,
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'compaction', verified: true });
  });

  it('memory 摘要行带 memory，且 compaction-notice 也带', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'S' }],
          tokensBefore: 1,
          verified: true,
          memory: true,
        },
        user('kept'),
        user('after'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 2 }
    );
    expect(timeline[0]).toMatchObject({ kind: 'compaction', memory: true });
    expect(timeline.find((item) => item.kind === 'compaction-notice')).toMatchObject({
      memory: true,
    });
  });

  it('compaction 行不打断 tool-group 折叠之外的顺序，且不被 foldTimeline 吞掉', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
      false
    );
    const folded = foldTimeline(timeline, false, new Set());
    expect(folded.map((item) => item.kind)).toEqual(['user', 'compaction', 'text']);
  });

  it('压缩进行中时在时间线末尾挂 loading 行，不重复钉摘要提示', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('new'),
      ],
      false,
      [],
      undefined,
      { compaction: 'running' }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'compaction',
      'user',
      'compaction-progress',
    ]);
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-progress', state: 'running' });
  });

  it('忙碌中排队压缩时末尾挂 queued 行', () => {
    const timeline = buildTimeline([user('q')], true, [], undefined, { compaction: 'queued' });
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-progress', state: 'queued' });
  });

  it('没有锚点时不钉压完提示（老行为会永远贴底，新消息被顶到提示上方）', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('new'),
      ],
      false
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction', 'user']);
  });

  it('压完提示钉在压缩发生那一刻：锚点之前的消息在上，之后的新消息在下', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'SUMMARY' }],
          tokensBefore: 9000,
        },
        user('kept'),
        user('new-after-compact'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 3 }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'compaction',
      'user',
      'compaction-notice',
      'user',
    ]);
    expect(timeline[3]).toMatchObject({
      kind: 'compaction-notice',
      summary: 'SUMMARY',
      tokensBefore: 9000,
    });
    expect(timeline.at(-1)).toMatchObject({ kind: 'user', text: 'new-after-compact' });
  });

  it('锚点在末尾（压完还没发新消息）时提示落在最后', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('kept'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 3 }
    );
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-notice', summary: 'S' });
  });

  it('摘要就在锚点位置（整段都被压掉）时不重复钉提示', () => {
    const timeline = buildTimeline(
      [user('old'), { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] }],
      false,
      [],
      undefined,
      { compactionNoticeAt: 2 }
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction']);
  });

  it('锚点陈旧（消息比锚点少）时不钉提示', () => {
    const timeline = buildTimeline([user('old')], false, [], undefined, { compactionNoticeAt: 5 });
    expect(timeline.map((item) => item.kind)).toEqual(['user']);
  });
});

describe('buildTimeline 运行中工具的增量输出', () => {
  const runningBash: ProjectedMessage[] = [
    user('跑测试'),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } }],
    },
  ];

  it('running 工具用 toolOutputs 的增量快照填充 output', () => {
    const timeline = buildTimeline(runningBash, true, [], undefined, {
      toolOutputs: { t1: 'PASS a\nPASS b' },
    });
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'running', output: 'PASS a\nPASS b' });
  });

  it('未开始执行的同轮工具不跳表：无 startedAt，仍标 running', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'sleep 5' } },
            { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'a.ts' } },
          ],
        },
      ],
      true,
      [],
      undefined,
      { toolStartedAt: { 'bash-1': 1_000 } }
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      state: 'running',
      startedAt: 1_000,
    });
    expect(timeline[2]).toMatchObject({
      kind: 'tool',
      name: 'write',
      state: 'running',
      startedAt: null,
    });
  });

  it('无增量时 running 工具 output 仍为 null（行不可展开）', () => {
    const timeline = buildTimeline(runningBash, true);
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'running', output: null });
  });

  it('真实 toolResult 覆盖残留的增量快照', () => {
    const timeline = buildTimeline(
      [
        ...runningBash,
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          isError: false,
          content: [{ type: 'text', text: 'final output' }],
        },
      ],
      true,
      [],
      undefined,
      { toolOutputs: { t1: 'PASS a' } }
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'ok', output: 'final output' });
  });
});

describe('patchStreamingTimeline', () => {
  const pending = (text: string): ProjectedMessage => ({
    role: 'assistant',
    stopReason: 'pending',
    content: [{ type: 'thinking', text }],
  });

  it('思考变长时复用前缀行对象，只换末条 thinking', () => {
    const prefix = user('问');
    const first = [prefix, pending('abc')];
    const previous = buildTimeline(first, true);
    const next = patchStreamingTimeline(previous, [prefix, pending('abcdef')], true);
    expect(next).not.toBeNull();
    expect(next).toHaveLength(previous.length);
    expect(next![0]).toBe(previous[0]);
    expect(next![1]).not.toBe(previous[1]);
    expect(next![1]).toMatchObject({ kind: 'thinking', text: 'abcdef', streaming: true });
  });

  it('思考文本没变时返回原数组', () => {
    const messages = [user('问'), pending('abc')];
    const previous = buildTimeline(messages, true);
    expect(patchStreamingTimeline(previous, messages, true)).toBe(previous);
  });

  it('非 running、工具结果、新 part 出现时不走补丁', () => {
    const prefix = user('问');
    const thinking = pending('abc');
    const previous = buildTimeline([prefix, thinking], true);
    expect(patchStreamingTimeline(previous, [prefix, thinking], false)).toBeNull();
    expect(
      patchStreamingTimeline(
        previous,
        [
          prefix,
          thinking,
          {
            role: 'toolResult',
            toolCallId: 't1',
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
        true
      )
    ).toBeNull();
    expect(
      patchStreamingTimeline(
        previous,
        [
          prefix,
          {
            role: 'assistant',
            stopReason: 'pending',
            content: [
              { type: 'thinking', text: 'abc' },
              { type: 'text', text: '答案' },
            ],
          },
        ],
        true
      )
    ).toBeNull();
  });
});

describe('apply_patch timeline', () => {
  const call: ProjectedMessage = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'patch-1', name: 'apply_patch', arguments: { patch: '***' } },
    ],
  };

  it('partial error 仍携带所有实际落盘文件，不把参数意图当 diff', () => {
    const changes = [
      { path: 'src/a.ts', oldText: 'a', newText: 'aa', type: 'update' as const },
      { path: 'old.ts', oldText: 'old', newText: '', type: 'delete' as const },
      { path: 'new.ts', oldText: '', newText: 'new', type: 'add' as const },
    ];
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          isError: true,
          content: [{ type: 'text', text: 'partially applied' }],
          fileChanges: changes,
          applyPatchOutcome: {
            status: 'partial',
            applied: changes.map((change) => change.path),
            failed: ['failed.ts'],
            error: 'source delete failed',
            input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
            unattempted: ['later.ts'],
            uncertain: ['unknown.ts'],
          },
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({
      kind: 'tool',
      name: 'apply_patch',
      state: 'error',
      fileChanges: changes,
      edits: null,
    });
    expect(shouldShowToolOutputAfterFileChanges(timeline[0])).toBe(true);
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Failed paths:\n- failed.ts'),
    });
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Uncertain:\n- unknown.ts'),
    });
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Input:\n*** Begin Patch'),
    });
  });

  it('apply_patch 结果从无到有时才自动展开，历史挂载时不展开', () => {
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          content: [],
          fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ name: 'apply_patch', state: 'ok' });
    expect(shouldAutoExpandAppliedFileChanges(timeline[0], false)).toBe(true);
    expect(shouldAutoExpandAppliedFileChanges(timeline[0], true)).toBe(false);
  });

  it('全量预检失败没有 fileChanges，不从 patch 参数造 diff', () => {
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          isError: true,
          content: [{ type: 'text', text: 'preflight failed' }],
          fileChanges: [],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ fileChanges: [], edits: null, writeContent: null });
  });

  it('有实际修改的 partial result 会改变 Changes 指纹', () => {
    const withResult: ProjectedMessage[] = [
      call,
      {
        role: 'toolResult',
        toolCallId: 'patch-1',
        toolName: 'apply_patch',
        isError: true,
        content: [],
        fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
      },
    ];
    expect(completedEditWriteFingerprint(withResult)).not.toBe(
      completedEditWriteFingerprint([call])
    );
  });
});

describe('completedEditWriteFingerprint', () => {
  it('思考变长不改变指纹，完成的 edit 才会变', () => {
    const readCall: ProjectedMessage = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } }],
    };
    const thinking: ProjectedMessage = {
      role: 'assistant',
      stopReason: 'pending',
      content: [{ type: 'thinking', text: 'a' }],
    };
    const before = [user('改'), readCall, thinking];
    const afterThink: ProjectedMessage[] = [
      user('改'),
      readCall,
      { ...thinking, content: [{ type: 'thinking', text: 'ab' }] },
    ];
    expect(completedEditWriteFingerprint(afterThink)).toBe(completedEditWriteFingerprint(before));

    const editCall: ProjectedMessage = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'e1',
          name: 'edit',
          arguments: { path: 'a.ts', oldText: 'x', newText: 'y' },
        },
      ],
    };
    const editResult: ProjectedMessage = {
      role: 'toolResult',
      toolCallId: 'e1',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    };
    expect(completedEditWriteFingerprint([...before, editCall, editResult])).not.toBe(
      completedEditWriteFingerprint(before)
    );
  });
});
