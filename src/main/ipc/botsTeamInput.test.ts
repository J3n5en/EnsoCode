import { describe, expect, it } from 'vitest';
import { TEAM_FILE_FORMAT } from '../../shared/bots/team';
import { parseTeamCreateInput, parseTeamPreviewInput } from './botsTeamInput';

const member = (key: string, name: string) => ({
  key,
  name,
  title: 't',
  scope: 's',
  persona: 'p',
  avatar: { color: '#7c5cff' },
  tools: 'all',
  approvalMode: 'full',
  delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
  memory: { enabled: true },
});
const team = {
  title: 'T',
  bossKey: 'a',
  workspace: 'chat-home',
  routing: { mode: 'smart', maxHops: 4, maxTurnsPerBot: 2 },
  members: [member('a', 'A'), member('b', 'B')],
};
const projectId = '00000000-0000-4000-8000-000000000001';

describe('parseTeamPreviewInput', () => {
  it('模板走 team，导入走 text', () => {
    expect(parseTeamPreviewInput({ team })).toMatchObject({ ok: true, team: { title: 'T' } });
    const text = JSON.stringify({ format: TEAM_FILE_FORMAT, version: 1, team });
    expect(parseTeamPreviewInput({ text })).toMatchObject({ ok: true });
    expect(parseTeamPreviewInput({ text: '{' })).toEqual({ ok: false, error: 'invalid-json' });
  });

  it('拒绝多余字段与非字符串文本', () => {
    expect(parseTeamPreviewInput({ team, text: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(parseTeamPreviewInput({ text: 1 })).toEqual({ ok: false, error: 'invalid' });
    expect(parseTeamPreviewInput(null)).toEqual({ ok: false, error: 'invalid' });
    expect(parseTeamPreviewInput({ team: { ...team, extra: 1 } })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});

describe('parseTeamCreateInput', () => {
  it('只接受独立目录或 Code 项目 id，不接受路径和成员 home', () => {
    expect(parseTeamCreateInput({ team, workspace: { kind: 'chat-home' } })).toMatchObject({
      workspace: { kind: 'chat-home' },
    });
    expect(parseTeamCreateInput({ team, workspace: { kind: 'project', projectId } })).toMatchObject(
      { workspace: { kind: 'project', projectId } }
    );
    expect(parseTeamCreateInput({ team, workspace: { kind: 'member-home' } })).toBeNull();
    expect(
      parseTeamCreateInput({ team, workspace: { kind: 'project', projectId: '/tmp/x' } })
    ).toBeNull();
    expect(
      parseTeamCreateInput({ team, workspace: { kind: 'chat-home', path: '/tmp' } })
    ).toBeNull();
    expect(parseTeamCreateInput({ team, workspace: { kind: 'chat-home' }, extra: 1 })).toBeNull();
    expect(
      parseTeamCreateInput({ team: { ...team, members: [] }, workspace: { kind: 'chat-home' } })
    ).toBeNull();
  });

  it('assets 只接受本队成员 key 下的技能 / MCP 字符串列表', () => {
    const key = (team as { members: { key: string }[] }).members[0].key;
    const ws = { kind: 'chat-home' };
    expect(
      parseTeamCreateInput({
        team,
        workspace: ws,
        assets: { [key]: { skillIds: ['s1'], mcpServerIds: [] } },
      })
    ).toMatchObject({ assets: { [key]: { skillIds: ['s1'], mcpServerIds: [] } } });
    expect(
      parseTeamCreateInput({
        team,
        workspace: ws,
        assets: { nobody: { skillIds: [], mcpServerIds: [] } },
      })
    ).toBeNull();
    expect(
      parseTeamCreateInput({
        team,
        workspace: ws,
        assets: { [key]: { skillIds: [1], mcpServerIds: [] } },
      })
    ).toBeNull();
    expect(
      parseTeamCreateInput({
        team,
        workspace: ws,
        assets: { [key]: { skillIds: [], mcpServerIds: [], extra: [] } },
      })
    ).toBeNull();
  });
});
