import { describe, expect, it } from 'vitest';
import { parseTeamSpec } from './team';
import {
  addCustomTemplate,
  emptyTemplateLibrary,
  isTemplateId,
  type MemberTemplateData,
  memberDraftOfTemplate,
  parseMemberTemplate,
  parseTeamTemplate,
  parseTemplateLibrary,
  removeTemplate,
  resolveTemplates,
  saveTemplate,
  setTemplateHidden,
  type TeamTemplateData,
  teamSpecOfTemplate,
  teamTemplateFromSpec,
  teamTemplateIssue,
} from './templateLibrary';

const UUID = '11111111-2222-4333-8444-555555555555';
const member: MemberTemplateData = {
  name: 'Max',
  title: 'Engineer',
  scope: 'Writes code',
  summary: 'Reads and writes code',
  persona: 'You are Max.',
  color: '#0ea5e9',
  tools: 'all',
  approvalMode: 'auto-edits',
};
const teamMember = (key: string, name: string) => ({
  key,
  name,
  title: key,
  scope: 's',
  persona: 'p',
  color: '#7c5cff',
  tools: 'all' as const,
  approvalMode: 'auto-edits' as const,
  canDelegateTo: [] as string[],
  acceptFrom: [] as string[],
});
const team: TeamTemplateData = {
  title: 'Squad',
  summary: 'Two people',
  bossKey: 'pm',
  workspace: 'chat-home',
  members: [
    { ...teamMember('pm', 'Morgan'), tools: 'readonly', canDelegateTo: ['dev'] },
    { ...teamMember('dev', 'Max'), acceptFrom: ['pm'] },
  ],
};

describe('template ids', () => {
  it('accepts builtin slugs and custom:<uuid> only', () => {
    expect(isTemplateId('pm')).toBe(true);
    expect(isTemplateId(`custom:${UUID}`)).toBe(true);
    expect(isTemplateId('custom:abc')).toBe(false);
    expect(isTemplateId('PM')).toBe(false);
    expect(isTemplateId('../x')).toBe(false);
  });
});

describe('parseMemberTemplate', () => {
  it('keeps a valid template and normalizes the name', () => {
    expect(parseMemberTemplate({ ...member, name: ' Max ' })).toEqual(member);
  });

  it('rejects bad names, colors, tools, approval modes and oversize text', () => {
    expect(parseMemberTemplate({ ...member, name: 'a b' })).toBeNull();
    expect(parseMemberTemplate({ ...member, name: '' })).toBeNull();
    expect(parseMemberTemplate({ ...member, color: 'red' })).toBeNull();
    expect(parseMemberTemplate({ ...member, tools: 'some' })).toBeNull();
    expect(parseMemberTemplate({ ...member, approvalMode: 'yolo-x' })).toBeNull();
    expect(parseMemberTemplate({ ...member, persona: 'x'.repeat(20_001) })).toBeNull();
    expect(parseMemberTemplate(null)).toBeNull();
  });

  it('turns into a member draft', () => {
    expect(memberDraftOfTemplate(member)).toEqual({
      name: 'Max',
      title: 'Engineer',
      scope: 'Writes code',
      persona: 'You are Max.',
      avatar: { color: '#0ea5e9' },
      tools: 'all',
      approvalMode: 'auto-edits',
    });
  });
});

describe('team templates', () => {
  it('valid template round-trips through a strict team spec', () => {
    const spec = teamSpecOfTemplate(team);
    expect(parseTeamSpec(spec)).toEqual(spec);
    expect(spec.members[0].memory).toEqual({ enabled: true });
    expect(parseTeamTemplate(team)).toEqual(team);
    expect(teamTemplateFromSpec(spec, 'Two people')).toEqual(team);
  });

  it('reports structural issues', () => {
    expect(teamTemplateIssue(team)).toBeNull();
    expect(teamTemplateIssue({ ...team, title: ' ' })).toBe('title');
    expect(teamTemplateIssue({ ...team, members: [team.members[0]] })).toBe('members');
    expect(teamTemplateIssue({ ...team, bossKey: 'nobody' })).toBe('invalid');
    expect(
      teamTemplateIssue({ ...team, members: [team.members[0], { ...team.members[1], key: 'pm' }] })
    ).toBe('invalid');
    expect(
      teamTemplateIssue({
        ...team,
        members: [team.members[0], { ...team.members[1], acceptFrom: ['ghost'] }],
      })
    ).toBe('invalid');
    expect(
      teamTemplateIssue({
        ...team,
        members: [team.members[0], { ...team.members[1], name: 'a b' }],
      })
    ).toBe('name');
  });

  it('does not check duplicate member names', () => {
    const twins = { ...team, members: [team.members[0], { ...team.members[1], name: 'Morgan' }] };
    expect(parseTeamTemplate(twins)).toEqual(twins);
  });
});

describe('parseTemplateLibrary', () => {
  it('returns an empty library for garbage', () => {
    expect(parseTemplateLibrary(undefined)).toEqual(emptyTemplateLibrary());
    expect(parseTemplateLibrary('x')).toEqual(emptyTemplateLibrary());
    expect(parseTemplateLibrary({ members: 1, teams: [] })).toEqual(emptyTemplateLibrary());
  });

  it('drops bad entries without losing good ones', () => {
    const parsed = parseTemplateLibrary({
      schemaVersion: 1,
      members: {
        overrides: { pm: member, qa: { ...member, color: 'bad' }, '../x': member },
        hidden: ['ops', 'ops', 3, 'BAD ID'],
        custom: [
          { id: `custom:${UUID}`, ...member },
          { id: `custom:${UUID}`, ...member, name: 'Dup' },
          { id: 'pm', ...member },
          { id: 'custom:00000000-0000-4000-8000-000000000000', ...member, tools: 'x' },
        ],
      },
      teams: { overrides: { software: team }, hidden: [], custom: [{ id: 'x', ...team }] },
    });
    expect(parsed.members.overrides).toEqual({ pm: member });
    expect(parsed.members.hidden).toEqual(['ops']);
    expect(parsed.members.custom).toEqual([{ id: `custom:${UUID}`, ...member }]);
    expect(parsed.teams.overrides).toEqual({ software: team });
    expect(parsed.teams.custom).toEqual([]);
  });
});

describe('resolveTemplates and section edits', () => {
  const builtins = [
    { id: 'pm', data: member },
    { id: 'qa', data: { ...member, name: 'Quinn' } },
  ];

  it('merges builtins, overrides, hidden flags and custom entries in order', () => {
    let section = emptyTemplateLibrary().members;
    section = saveTemplate(section, 'qa', { ...member, name: 'Q2' }, ['pm', 'qa']);
    section = setTemplateHidden(section, 'pm', true);
    section = addCustomTemplate(section, { ...member, name: 'Mine' }, UUID);
    const list = resolveTemplates(builtins, section);
    expect(list.map((item) => [item.id, item.source, item.modified, item.hidden])).toEqual([
      ['pm', 'builtin', false, true],
      ['qa', 'builtin', true, false],
      [`custom:${UUID}`, 'custom', false, false],
    ]);
    expect(list.map((item) => item.data.name)).toEqual(['Max', 'Q2', 'Mine']);
  });

  it('ignores overrides and hidden ids of unknown builtins', () => {
    const section = {
      overrides: { gone: member },
      hidden: ['gone'],
      custom: [],
    };
    expect(resolveTemplates(builtins, section).map((item) => item.id)).toEqual(['pm', 'qa']);
  });

  it('restores a builtin by removing its override and deletes custom entries', () => {
    let section = saveTemplate(emptyTemplateLibrary().members, 'pm', member, ['pm']);
    section = addCustomTemplate(section, member, UUID);
    section = saveTemplate(section, `custom:${UUID}`, { ...member, name: 'Edited' }, ['pm']);
    expect(section.custom[0].name).toBe('Edited');
    section = removeTemplate(section, 'pm');
    section = removeTemplate(section, `custom:${UUID}`);
    expect(section).toEqual(emptyTemplateLibrary().members);
  });

  it('does not create entries for unknown ids', () => {
    const section = saveTemplate(emptyTemplateLibrary().members, 'nope', member, ['pm']);
    expect(section).toEqual(emptyTemplateLibrary().members);
  });

  it('shows a hidden builtin again', () => {
    const section = setTemplateHidden(
      setTemplateHidden(emptyTemplateLibrary().members, 'pm', true),
      'pm',
      false
    );
    expect(section.hidden).toEqual([]);
  });
});
