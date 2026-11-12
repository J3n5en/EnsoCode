import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  completedEditWriteFingerprint,
  foldTimeline,
  patchStreamingTimeline,
  shouldAutoExpandAppliedFileChanges,
  shouldShowToolOutputAfterFileChanges,
  type TimelineItem,
  terminalErrorText,
} from './timeline';
import { textItem, thinkingItem, toolItem, user, userItem } from './timeline.testUtils';

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
    expect(group.summary).toBeUndefined();
  });

  it('组头带上组内批次标签，按出现顺序去重拼接', () => {
    const items = [
      { ...toolItem('t1', 'bash'), batchLabel: 'Ran tests' },
      toolItem('t2', 'read'),
      { ...toolItem('t3', 'grep'), batchLabel: 'Searched auth/' },
      { ...toolItem('t4', 'grep'), batchLabel: 'Ran tests' },
      textItem('x'),
    ] as TimelineItem[];
    const folded = foldTimeline(items, false, new Set());
    const group = folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.summary).toBe('Ran tests · Searched auth/');
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

  it('compact：图片 read 像文件改动一样留在组外，普通 read 仍进组', () => {
    const image = {
      ...toolItem('img', 'read'),
      state: 'running',
      imagePath: '/tmp/a.png',
    } as TimelineItem;
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
      image,
    ];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group', 'tool']);
    expect(folded[2]).toMatchObject({ key: 'img', kind: 'tool' });
    const done = foldTimeline(
      [
        userItem('u0'),
        toolItem('a1', 'read'),
        toolItem('a2', 'grep'),
        toolItem('a3', 'read'),
        { ...toolItem('img', 'read'), imagePath: '/tmp/a.png' } as TimelineItem,
      ],
      false,
      new Set(),
      { compact: true }
    );
    expect(done.map((item) => (item.kind === 'tool' ? item.key : item.kind))).toEqual([
      'user',
      'tool-group',
      'img',
    ]);
  });

  it('失败的图片 read 不钉在组外', () => {
    const failed = {
      ...toolItem('img', 'read'),
      state: 'error',
      imagePath: '/tmp/a.png',
    } as TimelineItem;
    const folded = foldTimeline(
      [
        userItem('u0'),
        toolItem('a1', 'read'),
        toolItem('a2', 'grep'),
        toolItem('a3', 'ls'),
        failed,
      ],
      false,
      new Set(),
      { compact: true }
    );
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.children.map((item) => item.key)).toContain('img');
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

  it('compact：运行中的尾段在两次调用之间仍标 exploring，被后续内容隔开或结束后才落定', () => {
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
    ];
    const exploring = (list: TimelineItem[], running: boolean) =>
      (
        foldTimeline(list, running, new Set(), { compact: true }).find(
          (i) => i.kind === 'tool-group'
        ) as Extract<TimelineItem, { kind: 'tool-group' }>
      ).exploring;
    expect(exploring(items, true)).toBe(true);
    expect(exploring([...items, thinkingItem('th')], true)).toBe(true);
    expect(exploring([...items, toolItem('b', 'bash')], true)).toBe(false);
    expect(exploring(items, false)).toBe(false);
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

  it('explore_mark 的 goal 作摘要', () => {
    expect(tool({ goal: 'find auth' })).toMatchObject({ summary: 'find auth' });
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

describe('mcp 代理调用行', () => {
  const proxy = (args: Record<string, unknown>) =>
    buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'mcp', arguments: args }],
        },
      ],
      false,
      []
    )[0];

  it('call 行按真实工具名与内层参数展示', () => {
    expect(
      proxy({ action: 'call', tool: 'mcp__github__search_issues', arguments: { query: 'bug' } })
    ).toMatchObject({ name: 'mcp__github__search_issues', summary: 'bug' });
  });

  it('list / describe 保留代理名并摘要目标', () => {
    expect(proxy({ action: 'list' })).toMatchObject({ name: 'mcp', summary: 'list' });
    expect(proxy({ action: 'describe', tool: 'mcp__github__search_issues' })).toMatchObject({
      name: 'mcp',
      summary: 'mcp__github__search_issues',
    });
  });
});

describe('compaction 摘要行', () => {
  it('插件注入的消息渲染为带来源的行，其它 custom 消息不显示', () => {
    const timeline = buildTimeline(
      [
        user('hi'),
        {
          role: 'custom',
          content: [{ type: 'text', text: '提醒：构建完成' }],
          timestamp: 9,
          pluginSource: { pluginId: 'enso.example.notes', pluginName: 'Notes' },
        },
        { role: 'custom', content: [{ type: 'text', text: 'hidden' }] },
      ],
      false
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'plugin-message']);
    expect(timeline[1]).toMatchObject({
      kind: 'plugin-message',
      text: '提醒：构建完成',
      pluginId: 'enso.example.notes',
      pluginName: 'Notes',
    });
  });

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

  it('压缩后用量只挂在最后一次压缩的分隔行和提示上', () => {
    const summary = (text: string) => ({
      role: 'compactionSummary',
      content: [{ type: 'text' as const, text }],
      tokensBefore: 9000,
    });
    const timeline = buildTimeline(
      [summary('A'), user('a'), summary('B'), user('kept'), user('after')],
      false,
      [],
      undefined,
      { compactionNoticeAt: 4, compactionTokensAfter: 1200 }
    );
    const rows = timeline.filter(
      (item) => item.kind === 'compaction' || item.kind === 'compaction-notice'
    );
    expect(
      rows.map((item) => [item.kind, 'tokensAfter' in item ? item.tokensAfter : null])
    ).toEqual([
      ['compaction', null],
      ['compaction', 1200],
      ['compaction-notice', 1200],
    ]);
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

  it('锚点不在最新摘要之后（冷缓存清空时记成 0）时不钉提示，不能顶成尾窗首行', () => {
    const tail: ProjectedMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'before' }] },
      { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
      user('kept'),
    ];
    for (const compactionNoticeAt of [0, 3, 691]) {
      const timeline = buildTimeline(tail, false, [], undefined, {
        compactionNoticeAt,
        historyBaseIndex: 690,
      });
      expect(timeline.map((item) => item.kind)).toEqual(['text', 'compaction', 'user']);
    }
  });

  it('尾窗分页时锚点按绝对下标落在摘要之后', () => {
    const timeline = buildTimeline(
      [
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('kept'),
        user('new-after-compact'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 692, historyBaseIndex: 690 }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'compaction',
      'user',
      'compaction-notice',
      'user',
    ]);
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

  it('没有落盘结果时摘要取补丁头里的目标文件，不显示参数 JSON', () => {
    const patchCall = (input: string): ProjectedMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'patch-2', name: 'apply_patch', arguments: { input } }],
    });
    const summaryOf = (...messages: ProjectedMessage[]) => {
      const [item] = buildTimeline(messages, true, [], '/repo');
      return item?.kind === 'tool' ? item.summary : null;
    };
    expect(summaryOf(patchCall('*** Begin Patch\n*** Add File: /repo/tests/a.test.js\n+imp'))).toBe(
      'tests/a.test.js'
    );
    expect(
      summaryOf(
        patchCall(
          '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts\n*** End Patch'
        )
      )
    ).toBe('3 files');
    expect(summaryOf(patchCall('*** Begin Patch\n*** Add Fi'))).toBe('');
    expect(
      summaryOf(patchCall('*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'), {
        role: 'toolResult',
        toolCallId: 'patch-2',
        toolName: 'apply_patch',
        isError: true,
        content: [{ type: 'text', text: 'preflight failed' }],
        fileChanges: [],
      })
    ).toBe('a.ts');
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
