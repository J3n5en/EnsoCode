import type { SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { buildSecretarySystemPrompt } from './prompt';

const profile: SecretaryProfile = {
  version: 1,
  name: '阿秘',
  avatar: { color: '#7c5cff' },
  takeoverScope: { mode: 'projects', projectIds: [] },
  visibleProjectIds: 'all',
  maxRunningDispatches: 3,
  patrolEnabled: true,
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

  it('记忆权限：私有空间、global 与可见项目可写，写共享空间有审计，纠正走 replaces', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    const memory = prompt.split('\n').find((line) => line.startsWith('Memory:')) ?? '';
    expect(memory).toContain("spaceId 'project'");
    expect(memory).toContain("spaceId 'global'");
    expect(memory).toContain('projectId');
    expect(memory).toMatch(/audited/);
    expect(memory).toMatch(/evolvesRelation 'replaces'/);
    expect(memory).toMatch(/untrusted/);
  });

  it('needsUser 每条是用户要亲自决定或动手的一件事，followUps 不需要用户，处理完用 result_mark_done 收口', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    const results = prompt.split('\n').find((line) => line.startsWith('Results:')) ?? '';
    expect(results).toContain('followUps');
    expect(results).toMatch(/Escalate only what the user personally/);
    expect(results).toContain('result_mark_done');
  });

  it('转问 needsUser 必须带 relatesTo，答复后宿主自动收口，不再手动 result_mark_done', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    const results = prompt.split('\n').find((line) => line.startsWith('Results:')) ?? '';
    expect(results).toContain('needs-user[N]');
    expect(results).toMatch(/always pass relatesTo/);
    expect(results).toMatch(/needsUserIndex/);
    expect(results).toMatch(/do not call result_mark_done for it/);
  });

  it('needsUser 先经秘书筛选：自己办完 mark done，只有用户本人必须做的才升级，30 分钟没处理自动给用户', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    const results = prompt.split('\n').find((line) => line.startsWith('Results:')) ?? '';
    expect(results).toMatch(/do not reach the user's needs-you list until you triage them/);
    expect(results).toMatch(/Escalate only what the user personally has to decide or do by hand/);
    expect(results).toMatch(/the card returns to with-secretary/);
    expect(results).not.toMatch(/count as handled by you/);
    expect(results).toContain('needs_user_escalate');
    expect(results).toMatch(/30 minutes/);
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

  it('清理不用确认开着时写明直接删除，关着时不提', () => {
    const on = buildSecretarySystemPrompt({
      profile: { ...profile, cleanupSkipConfirm: true },
      persona: '',
      uiLanguage: 'en',
    });
    expect(on).toContain('cleanup_apply');
    expect(on).toContain('deletes immediately without a confirmation card');
    expect(on).toContain('do not say a card is waiting');
    const off = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'en' });
    expect(off).not.toContain('deletes immediately without a confirmation card');
    expect(off).toContain('cleanup_apply only opens a confirmation card');
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
    // 转图直接作为图片块；派活带图放进首条 prompt，不先派再补发
    expect(prompt).toMatch(/without calling image_view/);
    expect(prompt).toMatch(/session_create or todo_item_dispatch attachments/);
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

  it('追加修复发回原会话：同一件事用 session_send，只在换分支、换基线或新任务时新建', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    expect(prompt).toMatch(
      /same task goes to the session that did it with session_send, not session_create/
    );
    expect(prompt).toMatch(/needs another branch or another base, or is a different task/);
    expect(prompt).toMatch(/already reported goal-complete, say .*continues the earlier work/);
    expect(prompt).toMatch(/another worktree and another branch/);
  });

  it('给已完成的会话追加任务时带上 goal，巡检才会盯着它', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    expect(prompt).toMatch(
      /already reported goal-complete, or one that never had a goal, pass goal/
    );
    expect(prompt).toMatch(/patrol only watches a session that still has a goal/);
  });

  it('手动标完成或目标受阻、暂停的会话追加任务时也能带 goal，正在跑或在等的不行', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    expect(prompt).toMatch(/marked done by hand, or whose goal is blocked or paused/);
    expect(prompt).toMatch(/refused while the current goal is still active or waiting/);
    expect(prompt).toMatch(/every follow-up you send starts tracking it again/);
  });

  it('派发直接执行不出卡，worktree 由秘书每次按任务决定，模型默认跟随项目', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    // 确认卡只剩会删东西、改设置、写技能工具和接管这几类
    const confirmations = prompt.split('\n\n').find((part) => part.startsWith('Confirmations:'));
    expect(confirmations).toBeDefined();
    expect(confirmations).not.toMatch(/session_create|todo_item_dispatch/);
    expect(prompt).toMatch(/session_create and todo_item_dispatch run right away/);
    // worktree 规则：改代码开，只读调查不开
    expect(prompt).toMatch(/worktree true when the session will change code/);
    expect(prompt).toMatch(/worktree false for read-only/);
    // todo_item_dispatch 支持 goal（缺省用待办文本），且首条消息不注入推送/合并约束
    expect(prompt).toMatch(/todo_item_dispatch.*goal/i);
    expect(prompt).not.toContain('The dispatch brief and the card show');
    expect(prompt).toContain('The card shows the base and branch that were actually used.');
    // 不再提已经删掉的设置
    expect(prompt).not.toMatch(/autonomy|dispatch model from your settings|dispatch default/);
    expect(prompt).not.toMatch(/the interval and the threshold are in your settings/);
    expect(prompt).toMatch(/follows the project's default model/);
  });

  it('初次设置不再问模型和自主度', () => {
    const prompt = buildSecretarySystemPrompt({ profile: null, persona: '', uiLanguage: 'zh' });
    const setup = prompt.split('\n\n').find((part) => part.startsWith('First setup'));
    expect(setup).toBeDefined();
    expect(setup).not.toMatch(/model|autonomy/);
  });

  it('项目可能既有别名又有目录名，两种叫法都要能对上', () => {
    const prompt = buildSecretarySystemPrompt({ profile, persona: '', uiLanguage: 'zh' });
    const projects = prompt.split('\n\n').find((part) => part.startsWith('Projects:'));
    expect(projects).toBeDefined();
    expect(projects).toMatch(/alias/);
    expect(projects).toMatch(/directory name/);
    expect(projects).toMatch(/directoryName/);
  });
});
