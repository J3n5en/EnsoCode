import { describe, expect, it } from 'vitest';
import { buildNotificationCopy } from './notificationCopy';

const zh = 'zh' as const;
const en = 'en' as const;

describe('buildNotificationCopy', () => {
  it('回合完成：标题带会话名与类型后缀，正文固定文案', () => {
    expect(buildNotificationCopy({ type: 'turn-completed' }, '修复登录', zh)).toEqual({
      title: '修复登录 · 回复完成',
      body: 'agent 已完成,等你查看。',
      pending: false,
    });
    expect(buildNotificationCopy({ type: 'turn-completed' }, 'Fix login', en)?.title).toBe(
      'Fix login · Turn completed'
    );
  });

  it('无会话名时标题只有类型后缀', () => {
    expect(buildNotificationCopy({ type: 'turn-completed' }, undefined, zh)?.title).toBe(
      '回复完成'
    );
  });

  it('提问：正文是问题原文，pending 为 true（计入角标）', () => {
    const copy = buildNotificationCopy(
      { type: 'ask-request', ask: { question: '用哪个端口？' } },
      '修复登录',
      zh
    );
    expect(copy).toEqual({
      title: '修复登录 · 等你回答',
      body: '用哪个端口？',
      pending: true,
    });
  });

  it('审批：正文带工具名与摘要，pending 为 true', () => {
    const copy = buildNotificationCopy(
      { type: 'approval-request', request: { tool: 'bash', summary: 'rm -rf dist' } },
      '修复登录',
      zh
    );
    expect(copy).toEqual({
      title: '修复登录 · 需要审批',
      body: 'bash · rm -rf dist',
      pending: true,
    });
  });

  it('失败：正文是错误原文，pending 为 false', () => {
    const copy = buildNotificationCopy(
      { type: 'turn-failed', error: 'provider 503' },
      '修复登录',
      zh
    );
    expect(copy).toEqual({
      title: '修复登录 · 会话失败',
      body: 'provider 503',
      pending: false,
    });
  });

  it('正文超长截断到 100 字', () => {
    const copy = buildNotificationCopy(
      { type: 'ask-request', ask: { question: `为什么${'长'.repeat(200)}` } },
      't',
      zh
    );
    expect(copy?.body).toHaveLength(100);
  });

  it('回合完成可带摘要：digest.assistantText 存在时正文用它', () => {
    const copy = buildNotificationCopy(
      { type: 'turn-completed', digest: { assistantText: '已修复登录态刷新' } },
      '修复登录',
      zh,
      { turnDoneSummary: true }
    );
    expect(copy?.body).toBe('已修复登录态刷新');
  });

  it('回合完成摘要为空时回退固定文案', () => {
    const copy = buildNotificationCopy(
      { type: 'turn-completed', digest: { assistantText: '' } },
      '修复登录',
      zh,
      { turnDoneSummary: true }
    );
    expect(copy?.body).toBe('agent 已完成,等你查看。');
  });

  it('未知事件类型返回 null', () => {
    expect(buildNotificationCopy({ type: 'message-upsert' }, 't', zh)).toBeNull();
  });

  it('桌面失败走 status:failed，与 turn-failed 同文案；无 error 或非 failed 返回 null', () => {
    expect(
      buildNotificationCopy({ type: 'status', status: 'failed', error: 'boom' }, '修复登录', zh)
    ).toEqual({
      title: '修复登录 · 会话失败',
      body: 'boom',
      pending: false,
    });
    expect(buildNotificationCopy({ type: 'status', status: 'failed' }, 't', zh)).toBeNull();
    expect(buildNotificationCopy({ type: 'status', status: 'idle' }, 't', zh)).toBeNull();
  });
});
