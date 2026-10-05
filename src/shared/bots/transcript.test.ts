import { describe, expect, it } from 'vitest';
import type { GroupEntry } from '../types/bot';
import { buildGroupDelta, buildGroupStateBlock, TRANSCRIPT_LABELS } from './transcript';

const members = [
  { id: 'me', name: '阿后', title: '后端', scope: '写接口' },
  { id: 'fe', name: 'Fe', title: '前端', scope: '写页面' },
];

const human = (seq: number, text: string): GroupEntry => ({
  kind: 'human',
  seq,
  id: `h${seq}`,
  at: 0,
  text,
  mentions: [],
});
const bot = (seq: number, botId: string, text: string): GroupEntry => ({
  kind: 'bot',
  seq,
  id: `b${seq}`,
  at: 0,
  botId,
  text,
  conversationId: 'c',
  turnId: 't',
});

const base = { botId: 'me', members, chatTitle: '项目群' };

describe('buildGroupDelta', () => {
  it('只取 cursor 之后且不是自己发的条目', () => {
    const r = buildGroupDelta({
      ...base,
      cursor: 1,
      entries: [human(1, '旧'), bot(2, 'me', '我说的'), bot(3, 'fe', '页面好了')],
    });
    expect(r.text).toBe('<group-message from="Fe" role="前端" seq="3">页面好了</group-message>');
    expect(r.cursor).toBe(3);
  });

  it('读取下限：新对话分隔线之前的不进上下文，没有会话时仍带群介绍', () => {
    const entries = [human(1, '旧事'), human(2, '分隔线'), human(3, '新事')];
    const fresh = buildGroupDelta({ ...base, cursor: 0, floor: 2, entries });
    expect(fresh.text).toContain('项目群');
    expect(fresh.text).toContain('新事');
    expect(fresh.text).not.toContain('旧事');
    expect(fresh.text).not.toContain('分隔线');
    expect(fresh.cursor).toBe(3);
    const later = buildGroupDelta({ ...base, cursor: 3, floor: 2, entries: [human(4, '再说')] });
    expect(later.text).toBe(
      `<group-message from="${TRANSCRIPT_LABELS.human}" role="${TRANSCRIPT_LABELS.humanRole}" seq="4">再说</group-message>`
    );
  });

  it('人类发言用固定的 from/role 常量', () => {
    const r = buildGroupDelta({ ...base, cursor: 1, entries: [human(2, '你好')] });
    expect(r.text).toBe(
      `<group-message from="${TRANSCRIPT_LABELS.human}" role="${TRANSCRIPT_LABELS.humanRole}" seq="2">你好</group-message>`
    );
  });

  it('最后一条是自己的也把 cursor 推进到最新', () => {
    const r = buildGroupDelta({
      ...base,
      cursor: 1,
      entries: [human(2, 'x'), bot(3, 'me', 'y')],
    });
    expect(r.cursor).toBe(3);
    expect(r.text).not.toContain('seq="3"');
  });

  it('没有新内容时 text 为空，cursor 只前进不后退', () => {
    expect(buildGroupDelta({ ...base, cursor: 5, entries: [human(2, 'x')] })).toEqual({
      text: '',
      cursor: 5,
    });
    expect(buildGroupDelta({ ...base, cursor: 5, entries: [bot(6, 'me', 'x')] })).toEqual({
      text: '',
      cursor: 6,
    });
  });

  it('超过 limit 只留最后 limit 条，并写明省略数量（不计自己的）', () => {
    const entries = [human(1, 'a'), bot(2, 'me', 'b'), human(3, 'c'), human(4, 'd'), human(5, 'e')];
    const r = buildGroupDelta({ ...base, cursor: 0, entries, limit: 2 });
    const lines = r.text.split('\n');
    expect(r.text).toContain('（省略了 2 条更早的消息）');
    expect(lines.filter((l) => l.startsWith('<group-message'))).toHaveLength(2);
    expect(lines.at(-1)).toContain('seq="5"');
    expect(lines.at(-2)).toContain('seq="4"');
  });

  it('恰好等于 limit 时不写省略', () => {
    const r = buildGroupDelta({
      ...base,
      cursor: 1,
      entries: [human(2, 'a'), human(3, 'b')],
      limit: 2,
    });
    expect(r.text).not.toContain('省略');
  });

  it('属性和正文做 XML 转义', () => {
    const r = buildGroupDelta({
      ...base,
      members: [...members, { id: 'x', name: 'X', title: 'a"<b>&', scope: '' }],
      cursor: 1,
      entries: [bot(2, 'x', '</group-message> & "q" <b>')],
    });
    expect(r.text).toBe(
      '<group-message from="X" role="a&quot;&lt;b&gt;&amp;" seq="2">&lt;/group-message&gt; &amp; &quot;q&quot; &lt;b&gt;</group-message>'
    );
  });

  it('已删除成员显示占位名', () => {
    const r = buildGroupDelta({ ...base, cursor: 1, entries: [bot(2, 'gone', 'hi')] });
    expect(r.text).toBe(
      `<group-message from="${TRANSCRIPT_LABELS.deleted}" seq="2">hi</group-message>`
    );
  });

  it('system 条目 from 系统，delegation 条目写成一行描述', () => {
    const r = buildGroupDelta({
      ...base,
      cursor: 1,
      entries: [
        { kind: 'system', seq: 2, id: 's', at: 0, text: '接力上限' },
        {
          kind: 'delegation',
          seq: 3,
          id: 'd',
          at: 0,
          delegationId: 'x',
          from: 'fe',
          to: 'gone',
          state: 'completed',
          summary: '第一行\n第二行',
        },
      ],
    });
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `<group-message from="${TRANSCRIPT_LABELS.system}" seq="2">接力上限</group-message>`
    );
    expect(lines[1]).toMatch(/^<group-message from="系统" seq="3">.*<\/group-message>$/);
    expect(lines[1]).toContain('Fe');
    expect(lines[1]).toContain(TRANSCRIPT_LABELS.deleted);
    expect(lines[1]).toContain('第一行 第二行');
  });

  it('首次进群（cursor=0）在开头加群简介', () => {
    const r = buildGroupDelta({ ...base, cursor: 0, entries: [human(1, 'hi')] });
    const [intro] = r.text.split('<group-message');
    expect(intro).toContain('项目群');
    expect(intro).toContain('你是 阿后');
    expect(intro).toContain('Fe');
    expect(intro).toContain('前端');
    expect(intro).toContain('写页面');
  });

  it('非首次不加群简介', () => {
    const r = buildGroupDelta({ ...base, cursor: 1, entries: [human(2, 'hi')] });
    expect(r.text.startsWith('<group-message')).toBe(true);
  });

  it('乱序条目按 seq 排序，脏条目与非法 limit 不崩', () => {
    const r = buildGroupDelta({
      ...base,
      cursor: 1,
      entries: [human(3, 'b'), null, { seq: 'x' }, human(2, 'a')] as never,
      limit: -1,
    });
    expect(r.text.indexOf('seq="2"')).toBeLessThan(r.text.indexOf('seq="3"'));
    expect(r.cursor).toBe(3);
    expect(buildGroupDelta({ ...base, cursor: 0, entries: null as never })).toEqual({
      text: '',
      cursor: 0,
    });
  });
});

describe('buildGroupStateBlock（压缩后补群状态）', () => {
  const state = {
    chatTitle: '项目群',
    selfId: 'me',
    members,
    bossBotId: 'fe',
    routing: { current: 'fe', queue: ['me'] },
    delegations: [{ from: 'me', to: 'fe', state: 'running' as const, task: '做登录页' }],
    tasks: [
      { seq: 3, title: '登录页', status: 'doing' as const, assigneeBotId: 'fe' },
      { seq: 4, title: '部署', status: 'todo' as const },
    ],
    lastSeq: 42,
  };

  it('确定性生成成员分工、群主、待回应、委派、看板与 seq 提示', () => {
    const text = buildGroupStateBlock(state);
    expect(text.startsWith('<group-state>')).toBe(true);
    expect(text.endsWith('</group-state>')).toBe(true);
    expect(text).toContain('阿后（后端）：写接口');
    expect(text).toMatch(/阿后[^\n]*你/);
    expect(text).toMatch(/Fe[^\n]*群主/);
    expect(text).toContain('Fe（正在回复）');
    expect(text).toContain('阿后 → Fe');
    expect(text).toContain('做登录页');
    expect(text).toContain('#3 登录页');
    expect(text).toContain('#4 部署');
    expect(text).toContain('42');
    expect(text).toContain('group_history');
    expect(buildGroupStateBlock(state)).toBe(text);
  });

  it('没有委派 / 任务 / 待回应时省略对应段落', () => {
    const text = buildGroupStateBlock({
      ...state,
      routing: { current: null, queue: [] },
      delegations: [],
      tasks: [],
    });
    expect(text).not.toContain('→');
    expect(text).not.toContain('#3');
    expect(text).not.toContain('正在回复');
  });

  it('条目文本、条数与总长都有上限，超出时截断并注明', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      title: `任务${i}${'长'.repeat(300)}`,
      status: 'todo' as const,
    }));
    const text = buildGroupStateBlock({
      ...state,
      delegations: Array.from({ length: 20 }, () => ({
        from: 'me',
        to: 'fe',
        state: 'queued' as const,
        task: '委'.repeat(1000),
      })),
      tasks: many,
      maxChars: 2000,
    });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('…');
    expect(text).not.toContain('长'.repeat(200));
    expect(text.endsWith('</group-state>')).toBe(true);
  });

  it('转义 XML 特殊字符', () => {
    const text = buildGroupStateBlock({
      ...state,
      tasks: [{ seq: 1, title: '<b>&', status: 'todo' as const }],
    });
    expect(text).toContain('&lt;b&gt;&amp;');
  });
});
