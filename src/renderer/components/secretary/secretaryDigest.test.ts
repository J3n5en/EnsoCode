import type {
  SecretaryBoard,
  SecretaryCard,
  SecretaryProposal,
  SecretaryResultKind,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { secretaryDigest } from './secretaryDigest';

const NOW = new Date(2024, 4, 15, 15, 30).getTime();
const TODAY = new Date(2024, 4, 15, 9, 0).getTime();
const YESTERDAY = new Date(2024, 4, 14, 23, 0).getTime();

const session = (
  conversationId: string,
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso-code',
  title: `任务 ${conversationId}`,
  state: 'idle',
  startedAt: TODAY,
  stateSince: TODAY,
  secretaryConversationId: 'sec',
  ...over,
});

const proposal = (over: Partial<SecretaryProposal> = {}): SecretaryCard => ({
  kind: 'proposal',
  projectName: 'enso-code',
  proposal: {
    id: 'prop1',
    secretaryConversationId: 'sec',
    createdAt: TODAY,
    updatedAt: TODAY,
    status: 'pending',
    kind: 'dispatch',
    draft: { projectId: 'p1', prompt: '修一下侧栏', worktree: false },
    ...over,
  } as SecretaryProposal,
});

const board = (over: Partial<SecretaryBoard> = {}): SecretaryBoard => ({
  needsYou: [],
  running: [],
  todos: [],
  done: [],
  ...over,
});

describe('secretaryDigest', () => {
  it('按本地小时给问候语', () => {
    const at = (hour: number) => secretaryDigest(board(), new Date(2024, 4, 15, hour, 0).getTime());
    expect(at(8).greeting).toBe('Good morning');
    expect(at(12).greeting).toBe('Good afternoon');
    expect(at(18).greeting).toBe('Good evening');
  });

  it('今天只统计本地零点之后的派出与结果', () => {
    const digest = secretaryDigest(
      board({
        running: [session('run-today', { state: 'running', stateSince: TODAY + 60_000 })],
        done: [
          session('ok-today', { result: 'goal-complete', resultAt: TODAY + 120_000 }),
          session('ended-today', { result: 'turn-ended', resultAt: TODAY + 180_000 }),
          session('bad-today', { result: 'failed', resultAt: TODAY + 240_000 }),
          session('ok-yesterday', {
            result: 'goal-complete',
            startedAt: YESTERDAY,
            stateSince: YESTERDAY,
            resultAt: YESTERDAY,
          }),
        ],
        needsYou: [session('waiting-today', { state: 'waiting', stateSince: TODAY + 300_000 })],
      }),
      NOW
    );
    expect(digest.today).toEqual({ dispatched: 5, completed: 2, failed: 1, earlier: 0 });
  });

  it('完成与失败只数今天派出的会话的最终状态；之前派出或接手的完成另算', () => {
    const digest = secretaryDigest(
      board({
        running: [
          // 上一轮结束后又被追加目标、正在跑：不算完成
          session('again', { state: 'running', result: 'turn-ended', resultAt: TODAY + 1 }),
        ],
        done: [
          session('ok', { result: 'goal-complete', resultAt: TODAY + 2 }),
          // 失败后重试成功：最终是完成，不再算失败
          session('retried', { result: 'goal-complete', resultAt: TODAY + 3 }),
          session('bad', { result: 'failed', resultAt: TODAY + 4 }),
          // 昨天派出、今天才完成
          session('cross-day', {
            startedAt: YESTERDAY,
            stateSince: YESTERDAY,
            result: 'goal-complete',
            resultAt: TODAY + 5,
          }),
          // 昨天派出完成过，今天追加目标又完成、再手动标完成：仍是一件
          session('twice', {
            startedAt: YESTERDAY,
            stateSince: YESTERDAY,
            result: 'goal-complete',
            resultAt: TODAY + 6,
            manual: true,
          }),
          // 接手用户的会话不算派出
          session('taken', { takeover: true, result: 'goal-complete', resultAt: TODAY + 7 }),
        ],
      }),
      NOW
    );
    expect(digest.today).toEqual({ dispatched: 4, completed: 2, failed: 1, earlier: 3 });
  });

  it('计数取各组条数与待办数', () => {
    const digest = secretaryDigest(
      board({
        needsYou: [proposal(), session('waiting', { state: 'waiting' })],
        running: [session('run', { state: 'running' })],
        todos: [
          { id: 't1', text: '写周报', createdAt: TODAY, updatedAt: TODAY },
          {
            id: 't2',
            text: '在跑',
            createdAt: TODAY,
            updatedAt: TODAY,
            phase: 'active',
          },
        ],
      }),
      NOW
    );
    expect(digest.counts).toEqual({ needsYou: 2, running: 1, todos: 1 });
  });

  it('结果类型映射到颜色与说明', () => {
    const cases: [SecretaryResultKind, string, string][] = [
      ['goal-complete', 'ok', 'Goal complete'],
      ['turn-ended', 'ok', 'Turn ended'],
      ['goal-blocked', 'warn', 'Goal blocked'],
      ['needs-user', 'warn', 'Waiting for you'],
      ['stalled', 'warn', 'Stalled'],
      ['interrupted', 'warn', 'Interrupted'],
      ['failed', 'bad', 'Failed'],
    ];
    for (const [result, tone, label] of cases) {
      const [event] = secretaryDigest(board({ done: [session('c1', { result })] }), NOW).events;
      expect({ result, tone: event.tone, label: event.label }).toEqual({ result, tone, label });
    }
  });

  it('没有结果时在跑的算开始执行，其余按状态说明', () => {
    const digest = secretaryDigest(
      board({
        running: [session('run', { state: 'running' })],
        done: [session('idle', { state: 'idle' }), session('new', { state: 'not-started' })],
      }),
      NOW
    );
    const byId = Object.fromEntries(digest.events.map((event) => [event.conversationId, event]));
    expect(byId.run).toMatchObject({ tone: 'run', label: 'Started' });
    expect(byId.idle).toMatchObject({ tone: 'idle', label: 'Idle' });
    expect(byId.new).toMatchObject({ tone: 'idle', label: 'Not started' });
  });

  it('上一轮有结果、这一轮又在跑时，动态显示在跑而不是旧结果', () => {
    const [event] = secretaryDigest(
      board({ running: [session('again', { state: 'running', result: 'goal-complete' })] }),
      NOW
    ).events;
    expect(event).toMatchObject({ tone: 'run', label: 'Started', running: true });
  });

  it('还在等续跑时，动态不再显示上一轮的完成', () => {
    const digest = secretaryDigest(
      board({
        running: [
          session('c1', {
            state: 'idle',
            continuing: true,
            result: 'goal-complete',
            resultAt: TODAY,
            stateSince: TODAY + 5,
          }),
        ],
      }),
      NOW
    );
    expect(digest.events[0]).toMatchObject({ label: 'In progress', tone: 'run', at: TODAY + 5 });
    expect(digest.counts.running).toBe(1);
  });

  it('会话事件带项目、标题、最后一句与打开用的会话 id', () => {
    const [event] = secretaryDigest(
      board({
        running: [
          session('c1', { state: 'running', title: '跑全量测试', lastText: '正在跑第 3 个包' }),
        ],
      }),
      NOW
    ).events;
    expect(event).toEqual({
      id: 'session:c1',
      at: TODAY,
      tone: 'run',
      projectName: 'enso-code',
      title: '跑全量测试',
      label: 'Started',
      detail: '正在跑第 3 个包',
      conversationId: 'c1',
      running: true,
    });
  });

  it('压掉和静默的更新按时间出现在动态里', () => {
    const digest = secretaryDigest(
      board({
        running: [session('c1', { state: 'running', title: '验收' })],
        activity: [
          { at: NOW - 1000, conversationId: 'c1', kind: 'turn-ended', text: '第 2 轮在跑' },
          { at: NOW, conversationId: 'c1', kind: 'seen', text: '秘书已查看' },
        ],
      }),
      NOW
    );
    const activity = digest.events.filter((event) => event.id.startsWith('activity:'));
    expect(activity.map((event) => event.label)).toEqual(['Secretary saw this', 'Turn ended']);
    expect(activity[1]).toMatchObject({ title: '验收', detail: '第 2 轮在跑' });
  });

  it('待确认提案进动态，标题优先用草案标题，其次提示词首行', () => {
    const titled = proposal();
    const untitled = proposal({
      id: 'prop2',
      createdAt: TODAY + 1000,
      draft: { projectId: 'p1', prompt: '整理账单\n第二行不要', worktree: false },
    } as Partial<SecretaryProposal>);
    const digest = secretaryDigest(board({ needsYou: [titled, untitled] }), NOW);
    expect(digest.events.map((event) => event.title)).toEqual(['整理账单', '修一下侧栏']);
    expect(digest.events[0]).toMatchObject({
      tone: 'warn',
      label: 'Waiting for your confirmation',
      projectName: 'enso-code',
    });
  });

  it('档案提案用固定标题，没有项目就留空', () => {
    const card = proposal({
      kind: 'profile',
      draft: { name: '小安' },
    } as Partial<SecretaryProposal>);
    const [event] = secretaryDigest(
      board({ needsYou: [{ ...card, projectName: undefined } as SecretaryCard] }),
      NOW
    ).events;
    expect(event).toMatchObject({ title: 'Update the secretary profile', projectName: '' });
  });

  it('动态按时间倒序，投影本身不截断', () => {
    const done = Array.from({ length: 25 }, (_, index) =>
      session(`c${index}`, { resultAt: TODAY + index * 1000, result: 'turn-ended' })
    );
    const digest = secretaryDigest(board({ done }), NOW);
    expect(digest.events).toHaveLength(25);
    expect(digest.events[0].id).toBe('session:c24');
    expect(digest.events.at(-1)?.id).toBe('session:c0');
  });

  it('开始执行取本次开始的时间，上一轮的结果时间不算', () => {
    const [event] = secretaryDigest(
      board({
        running: [
          session('again', {
            state: 'running',
            stateSince: TODAY + 60_000,
            result: 'turn-ended',
            resultAt: TODAY,
          }),
        ],
      }),
      NOW
    ).events;
    expect(event).toMatchObject({ label: 'Started', at: TODAY + 60_000 });
  });

  it('完成、需要你、失败取结果发生的时间；没有结果按状态起始时间', () => {
    const events = secretaryDigest(
      board({
        needsYou: [
          session('ask', {
            state: 'waiting',
            stateSince: TODAY + 1,
            result: 'needs-user',
            resultAt: TODAY + 2,
          }),
          session('bad', {
            state: 'error',
            stateSince: TODAY + 3,
            result: 'failed',
            resultAt: TODAY + 4,
          }),
          session('approval', { state: 'waiting', stateSince: TODAY + 5 }),
        ],
        done: [
          session('ok', { stateSince: TODAY + 6, result: 'goal-complete', resultAt: TODAY + 7 }),
        ],
      }),
      NOW
    ).events;
    expect(Object.fromEntries(events.map((event) => [event.id, event.at]))).toEqual({
      'session:ask': TODAY + 2,
      'session:bad': TODAY + 4,
      'session:approval': TODAY + 5,
      'session:ok': TODAY + 7,
    });
  });

  it('时间相同时按条目标识兜底，与输入顺序无关', () => {
    const cards = ['b', 'c', 'a'].map((id) => session(id, { state: 'running' }));
    const ids = (running: SecretaryCard[]) =>
      secretaryDigest(board({ running }), NOW).events.map((event) => event.id);
    expect(ids(cards)).toEqual(['session:a', 'session:b', 'session:c']);
    expect(ids([...cards].reverse())).toEqual(ids(cards));
  });
});
