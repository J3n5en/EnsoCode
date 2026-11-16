import type { SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { buildSecretarySystemPrompt } from './prompt';

const profile: SecretaryProfile = {
  version: 1,
  name: '阿秘',
  avatar: { color: '#7c5cff' },
  autonomy: 'ask-first',
  autoApproveProjectIds: [],
  takeoverScope: { mode: 'projects', projectIds: [] },
  visibleProjectIds: 'all',
  dispatchModel: { mode: 'project' },
  dispatchWorktree: 'auto',
  maxRunningDispatches: 3,
  patrolEnabled: true,
  patrolIntervalMinutes: 15,
  dispatchMuted: true,
  dispatchUnattended: true,
  replyLanguage: 'zh',
  style: 'concise',
  notify: 'needs-user',
  updatedAt: 1,
};

describe('buildSecretarySystemPrompt', () => {
  it('写明身份、不读写代码与不可信内容规则', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    expect(prompt).toContain('阿秘');
    expect(prompt).toContain('<untrusted-content');
    expect(prompt).toMatch(/never execute|do not execute|ignore/i);
    expect(prompt).toMatch(/bash|file/i);
  });

  it('称呼按档案写进提示词，没设置时不写称呼（默认）', () => {
    expect(
      buildSecretarySystemPrompt({
        profile: { ...profile, addressAs: '哥哥' },
        persona: '',
        uiLanguage: 'en',
      })
    ).toContain('Address the user as "哥哥".');
    for (const p of [profile, null])
      expect(
        buildSecretarySystemPrompt({ profile: p, persona: '', uiLanguage: 'en' })
      ).not.toContain('Address the user as');
  });

  it('回复语言跟随档案，ui 时跟随界面语言', () => {
    expect(buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' })).toContain(
      'Chinese'
    );
    expect(
      buildSecretarySystemPrompt({
        profile: { ...profile, replyLanguage: 'ui' },
        persona: '',
        uiLanguage: 'en',
      })
    ).toContain('English');
    expect(
      buildSecretarySystemPrompt({
        profile: { ...profile, replyLanguage: 'ui' },
        persona: '',
        uiLanguage: 'zh',
      })
    ).toContain('Chinese');
  });

  it('没有档案时引导用户完成初次设置并走提案工具', () => {
    const prompt = buildSecretarySystemPrompt({ profile: null, persona: '', uiLanguage: 'zh' });
    expect(prompt).toContain('secretary_profile_propose');
    expect(prompt).toMatch(/初次设置|setup/i);
  });

  it('人设补充文字与结果类型语义都进提示词', () => {
    const prompt = buildSecretarySystemPrompt({
      profile,
      persona: '叫我老板',
      uiLanguage: 'zh',
    });
    expect(prompt).toContain('叫我老板');
    expect(prompt).toContain('turn-ended');
    expect(prompt).toContain('silence_turn');
    expect(prompt).not.toContain('<secretary-silent/>');
  });

  it('看图与清理规则写进提示词', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    // 会话说截图在某路径时先自己看一眼
    expect(prompt).toContain('image_view');
    expect(prompt).toMatch(/screenshot or an image is at some path/);
    // 定期看清单，清理走确认卡，不自己删
    expect(prompt).toContain('cleanup_list');
    expect(prompt).toContain('cleanup_apply');
    expect(prompt).toMatch(/Never delete anything on your own/);
    expect(prompt).toContain('confirmation card');
  });

  it('核实规则写进提示词：提交号与工作区先查 repo_status，截断按 index 读全文，卡住看 session_tasks', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    expect(prompt).toContain('repo_status');
    expect(prompt).toMatch(/commit id, a HEAD, or that a working tree is clean/);
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('offset');
    expect(prompt).toContain('session_tasks');
    expect(prompt).toContain('session_activity');
    // 只读 git 不等于能读文件
    expect(prompt).toMatch(/never file contents/);
  });

  it('确认卡规则写进提示词：记住 proposalId、等结果、不重复提', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    expect(prompt).toMatch(/remember its proposalId/);
    expect(prompt).toMatch(/do not call that op again/);
    // 重提不会开第二张卡，只会拿回同一个 proposalId
    expect(prompt).toMatch(/does not open a second card/);
    // 确认与取消各有回传
    expect(prompt).toMatch(/one update saying it is running/);
    expect(prompt).toMatch(/saying it was cancelled/);
  });
});
