import { parseMemberTemplate } from '@shared/bots/templateLibrary';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { checkBotName } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATES, memberTemplateData, templateDraft } from './templates';

describe('BOT_TEMPLATES', () => {
  const reserved = BUILTIN_AGENT_TYPES.map((type) => type.name);

  it('包含五个岗位模板，id 唯一', () => {
    expect(BOT_TEMPLATES.map((tpl) => tpl.id)).toEqual(['pm', 'fullstack', 'ops', 'qa', 'design']);
  });

  it('两种语言的默认名字都是合法且互不重复的成员名', () => {
    for (const locale of ['zh', 'en'] as const) {
      const drafts = BOT_TEMPLATES.map((tpl) => templateDraft(tpl, locale));
      for (const [index, draft] of drafts.entries()) {
        const others = drafts
          .slice(0, index)
          .map((d, i) => ({ id: String(i), name: d.name ?? '' }));
        expect(checkBotName(draft.name ?? '', others, reserved)).toMatchObject({ ok: true });
        expect(draft.persona?.length).toBeGreaterThan(20);
        expect(draft.avatar?.color).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });

  it('项目经理只读，运维命令一律需审批', () => {
    const pm = templateDraft(BOT_TEMPLATES[0], 'zh');
    const ops = templateDraft(BOT_TEMPLATES[2], 'zh');
    expect(pm.tools).toBe('readonly');
    expect(ops.approvalMode).toBe('supervised');
  });

  it('本地化后是合法的成员模板数据', () => {
    for (const locale of ['zh', 'en'] as const)
      for (const tpl of BOT_TEMPLATES) {
        const data = memberTemplateData(tpl, locale);
        expect(parseMemberTemplate(data)).toEqual(data);
      }
  });
});
