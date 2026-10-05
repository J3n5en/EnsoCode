import { assignTeamNames, parseTeamSpec, teamMemberDrafts } from '@shared/bots/team';
import { parseTeamTemplate } from '@shared/bots/templateLibrary';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { parseBotChat, parseBotProfile } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { TEAM_TEMPLATES, teamTemplateData, teamTemplateSpec } from './teamTemplates';
import { BOT_TEMPLATES } from './templates';

const reserved = BUILTIN_AGENT_TYPES.map((type) => type.name);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('TEAM_TEMPLATES', () => {
  it('至少三个团队模板，id 唯一', () => {
    const ids = TEAM_TEMPLATES.map((template) => template.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of TEAM_TEMPLATES) {
    for (const locale of ['zh', 'en'] as const) {
      describe(`${template.id}/${locale}`, () => {
        const spec = teamTemplateSpec(template, locale);

        it('本地化后是合法的团队模板数据', () => {
          const data = teamTemplateData(template, locale);
          expect(parseTeamTemplate(data)).toEqual(data);
        });

        it('通过团队、成员档案与群校验', () => {
          expect(parseTeamSpec(spec)).toEqual(spec);
          const ids = Object.fromEntries(spec.members.map((m, i) => [m.key, id(i + 1)]));
          const profiles = teamMemberDrafts(spec, ids).map(({ id: botId, draft }) =>
            parseBotProfile({ ...draft, id: botId, createdAt: 1, updatedAt: 1, version: 1 })
          );
          for (const [index, profile] of profiles.entries()) {
            const member = spec.members[index];
            expect(profile).toMatchObject({
              name: member.name,
              tools: member.tools,
              approvalMode: member.approvalMode,
            });
            expect(profile?.engine).toBeUndefined();
            expect(profile?.skillIds).toEqual([]);
          }
          const chat = parseBotChat({
            id: id(100),
            kind: 'group',
            title: spec.title,
            members: Object.values(ids),
            bossBotId: ids[spec.bossKey],
            workspace: { kind: 'chat-home', projectId: 'p' },
            routing: spec.routing,
            createdAt: 1,
            updatedAt: 1,
          });
          expect(chat?.routing).toEqual(spec.routing);
        });

        it('名字合法、互不重复，也不与保留名和单成员模板冲突', () => {
          const singles = BOT_TEMPLATES.map((tpl, i) => ({
            id: String(i),
            name: tpl[locale].name,
          }));
          expect(assignTeamNames(spec, singles, reserved).renamed).toEqual([]);
        });

        it('群主只读、可委派给所有其他成员，其他成员都接受群主委派', () => {
          const boss = spec.members.find((m) => m.key === spec.bossKey);
          const others = spec.members.filter((m) => m.key !== spec.bossKey);
          expect(boss?.tools).toBe('readonly');
          expect(boss?.delegation.canDelegateTo).toEqual(others.map((m) => m.key));
          for (const member of others) {
            expect(member.delegation.acceptFrom).toContain(spec.bossKey);
            expect(member.persona.length).toBeGreaterThan(80);
            expect(member.scope.length).toBeGreaterThan(5);
          }
          expect(spec.routing.mode).toBe('smart');
          expect(new Set(spec.members.map((m) => m.title)).size).toBe(spec.members.length);
        });
      });
    }
  }
});
