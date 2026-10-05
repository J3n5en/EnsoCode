import { describe, expect, it } from 'vitest';
import type { BotChat, BotProfile } from '../types/bot';
import {
  assignTeamNames,
  buildTeamFile,
  parseTeamFile,
  parseTeamSpec,
  selectTeamMembers,
  TEAM_FILE_FORMAT,
  TEAM_FILE_MAX_CHARS,
  TEAM_FILE_VERSION,
  type TeamSpec,
  teamMemberDrafts,
  uniqueBotName,
} from './team';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function member(key: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    name,
    title: `${name} title`,
    scope: `${name} scope`,
    persona: `You are ${name}.`,
    avatar: { color: '#7c5cff' },
    tools: 'all',
    approvalMode: 'auto-edits',
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: true },
    ...extra,
  };
}

function spec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Squad',
    bossKey: 'pm',
    workspace: 'chat-home',
    routing: { mode: 'smart', maxHops: 6, maxTurnsPerBot: 2 },
    members: [
      member('pm', 'Lin', { delegation: { canDelegateTo: ['fe', 'be'], acceptFrom: [] } }),
      member('fe', 'Fe', { delegation: { canDelegateTo: [], acceptFrom: ['pm'] } }),
      member('be', 'Be'),
    ],
    ...extra,
  };
}

const fileText = (team: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: TEAM_FILE_FORMAT, version: TEAM_FILE_VERSION, team, ...extra });

describe('parseTeamSpec', () => {
  it('接受合法团队', () => {
    const team = parseTeamSpec(spec());
    expect(team?.members.map((m) => m.key)).toEqual(['pm', 'fe', 'be']);
    expect(team?.routing).toEqual({ mode: 'smart', maxHops: 6, maxTurnsPerBot: 2 });
  });

  it('拒绝未知字段（顶层、成员、嵌套）', () => {
    expect(parseTeamSpec(spec({ projectId: 'x' }))).toBeNull();
    expect(
      parseTeamSpec(spec({ members: [member('pm', 'A', { engine: {} }), member('b', 'B')] }))
    ).toBeNull();
    expect(
      parseTeamSpec(
        spec({
          members: [member('pm', 'A', { memory: { enabled: true, items: [] } }), member('b', 'B')],
        })
      )
    ).toBeNull();
  });

  it('拒绝群主不在成员中、引用不存在的成员、重复 key、成员不足或过多', () => {
    expect(parseTeamSpec(spec({ bossKey: 'nobody' }))).toBeNull();
    expect(
      parseTeamSpec(
        spec({
          members: [
            member('pm', 'A', { delegation: { canDelegateTo: ['ghost'], acceptFrom: 'any' } }),
            member('b', 'B'),
          ],
        })
      )
    ).toBeNull();
    expect(parseTeamSpec(spec({ members: [member('pm', 'A'), member('pm', 'B')] }))).toBeNull();
    expect(parseTeamSpec(spec({ members: [member('pm', 'A')] }))).toBeNull();
    expect(
      parseTeamSpec(
        spec({ members: Array.from({ length: 13 }, (_, i) => member(i ? `m${i}` : 'pm', `N${i}`)) })
      )
    ).toBeNull();
  });

  it('拒绝非法枚举、越界路由、非法名字和超长人设', () => {
    expect(parseTeamSpec(spec({ workspace: 'member-home' }))).toBeNull();
    expect(
      parseTeamSpec(spec({ routing: { mode: 'smart', maxHops: 99, maxTurnsPerBot: 2 } }))
    ).toBeNull();
    expect(
      parseTeamSpec(spec({ members: [member('pm', 'has space'), member('b', 'B')] }))
    ).toBeNull();
    expect(
      parseTeamSpec(spec({ members: [member('pm', 'A', { tools: 'root' }), member('b', 'B')] }))
    ).toBeNull();
    expect(
      parseTeamSpec(
        spec({ members: [member('pm', 'A', { persona: 'x'.repeat(20_001) }), member('b', 'B')] })
      )
    ).toBeNull();
  });
});

describe('parseTeamFile', () => {
  it('解析合法文件', () => {
    const result = parseTeamFile(fileText(spec(), { exportedAt: '2026-10-04T00:00:00.000Z' }));
    expect(result).toMatchObject({ ok: true, team: { title: 'Squad' } });
  });

  it('坏 JSON、超长、版本不符、格式不符、未知字段', () => {
    expect(parseTeamFile('{oops')).toEqual({ ok: false, error: 'invalid-json' });
    expect(parseTeamFile(' '.repeat(TEAM_FILE_MAX_CHARS + 1))).toEqual({
      ok: false,
      error: 'too-large',
    });
    expect(
      parseTeamFile(JSON.stringify({ format: TEAM_FILE_FORMAT, version: 2, team: spec() }))
    ).toEqual({
      ok: false,
      error: 'unsupported-version',
    });
    expect(parseTeamFile(JSON.stringify({ format: 'other', version: 1, team: spec() }))).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseTeamFile(fileText(spec(), { memories: [] }))).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseTeamFile(fileText({ ...spec(), sessions: {} }))).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});

describe('uniqueBotName / assignTeamNames', () => {
  it('冲突时追加数字后缀，跳过已占用并截断到名称上限', () => {
    expect(uniqueBotName('Max', [], [])).toBe('Max');
    expect(uniqueBotName('max', ['Max'], [])).toBe('max2');
    expect(uniqueBotName('Max', ['Max', 'max2'], [])).toBe('Max3');
    expect(uniqueBotName('tester', [], ['tester'])).toBe('tester2');
    expect(uniqueBotName('all', [], [])).toBe('all2');
    const long = 'a'.repeat(24);
    expect(uniqueBotName(long, [long], [])).toBe(`${'a'.repeat(23)}2`);
  });

  it('团队内部与已有成员、保留名冲突都改名并给出提示', () => {
    const team = parseTeamSpec(
      spec({ members: [member('pm', 'Lin'), member('fe', 'lin'), member('be', 'Tester')] })
    ) as TeamSpec;
    const result = assignTeamNames(team, [{ id: id(1), name: 'Be' }], ['tester']);
    expect(result.team.members.map((m) => m.name)).toEqual(['Lin', 'lin2', 'Tester2']);
    expect(result.renamed).toEqual([
      { key: 'fe', from: 'lin', to: 'lin2' },
      { key: 'be', from: 'Tester', to: 'Tester2' },
    ]);
  });
});

describe('selectTeamMembers', () => {
  it('去掉未选成员并清理委派引用，群主不可去掉', () => {
    const team = parseTeamSpec(spec()) as TeamSpec;
    const picked = selectTeamMembers(team, ['pm', 'be']);
    expect(picked?.members.map((m) => m.key)).toEqual(['pm', 'be']);
    expect(picked?.members[0].delegation.canDelegateTo).toEqual(['be']);
    expect(selectTeamMembers(team, ['fe', 'be'])).toBeNull();
    expect(selectTeamMembers(team, ['pm'])).toBeNull();
  });
});

describe('teamMemberDrafts', () => {
  it('把成员 key 映射成 bot id，不带模型、技能、MCP', () => {
    const team = parseTeamSpec(spec()) as TeamSpec;
    const drafts = teamMemberDrafts(team, { pm: id(1), fe: id(2), be: id(3) });
    expect(drafts[0].draft.delegation).toEqual({ canDelegateTo: [id(2), id(3)], acceptFrom: [] });
    expect(drafts[1].draft.delegation).toEqual({ canDelegateTo: [], acceptFrom: [id(1)] });
    expect(drafts[2].draft.delegation).toEqual({ canDelegateTo: 'any', acceptFrom: 'any' });
    expect(drafts[0].draft).toMatchObject({
      skillIds: [],
      mcpServerIds: [],
      persona: 'You are Lin.',
    });
    expect('engine' in drafts[0].draft).toBe(false);
  });

  it('按成员 key 带上建队时选的技能与 MCP', () => {
    const team = parseTeamSpec(spec()) as TeamSpec;
    const drafts = teamMemberDrafts(
      team,
      { pm: id(1), fe: id(2), be: id(3) },
      { fe: { skillIds: ['s1'], mcpServerIds: ['m1'] } }
    );
    expect(drafts[1].draft).toMatchObject({ skillIds: ['s1'], mcpServerIds: ['m1'] });
    expect(drafts[0].draft).toMatchObject({ skillIds: [], mcpServerIds: [] });
  });
});

describe('buildTeamFile', () => {
  const bot = (n: number, name: string, extra: Partial<BotProfile> = {}): BotProfile => ({
    id: id(n),
    name,
    title: 'T',
    scope: 'S',
    avatar: { color: '#22c55e' },
    approvalMode: 'full',
    tools: 'all',
    skillIds: ['skill-a'],
    mcpServerIds: ['mcp-a'],
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: false },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...extra,
  });
  const chat: BotChat = {
    id: id(10),
    kind: 'group',
    title: 'Squad',
    members: [id(1), id(2)],
    bossBotId: id(1),
    workspace: { kind: 'project', projectId: id(99) },
    routing: { mode: 'smart', maxHops: 5, maxTurnsPerBot: 3 },
    pinned: true,
    sessions: { [id(1)]: { conversationId: 'c1', cursor: 3 } },
    createdAt: 1,
    updatedAt: 1,
    version: 4,
  };

  it('剥离模型、技能、MCP、项目、会话，委派引用换成 key，可再解析回来', () => {
    const bots = [
      bot(1, 'Lin', {
        engine: { providerId: 'secret-provider', modelId: 'claude-opus', thinkingLevel: 'high' },
        delegation: { canDelegateTo: [id(2), id(77)], acceptFrom: 'any' },
      }),
      bot(2, 'Max', { tools: 'readonly' }),
    ];
    const file = buildTeamFile(chat, bots, { [id(1)]: 'persona 1', [id(2)]: 'persona 2' }, 'now');
    const text = JSON.stringify(file);
    for (const leaked of [
      id(99),
      id(1),
      'secret-provider',
      'claude-opus',
      'skill-a',
      'mcp-a',
      'c1',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(file.team.workspace).toBe('project');
    expect(file.team.members[0]).toMatchObject({
      name: 'Lin',
      persona: 'persona 1',
      delegation: { canDelegateTo: ['m2'], acceptFrom: 'any' },
    });
    expect(file.team.members[1]).toMatchObject({ tools: 'readonly', memory: { enabled: false } });
    expect(parseTeamFile(text)).toEqual({ ok: true, team: file.team });
  });

  it('静音名单是群内设置，不随团队导出', () => {
    const file = buildTeamFile(
      { ...chat, routing: { ...chat.routing, muted: [id(2)] } },
      [bot(1, 'Lin'), bot(2, 'Max')],
      {},
      'now'
    );
    expect(file.team.routing).toEqual({ mode: 'smart', maxHops: 5, maxTurnsPerBot: 3 });
    expect(parseTeamFile(JSON.stringify(file)).ok).toBe(true);
  });
});
