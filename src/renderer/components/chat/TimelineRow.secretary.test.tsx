import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : key,
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const user = (text: string): TimelineItem => ({ kind: 'user', key: 'u', text, images: [] });
const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

it('秘书收到的回传渲染成通知卡片，标签与不可信包裹都不露出', () => {
  const out = html(
    user(
      '<session-updates>\n- [goal-complete session:c1] app · 修登录 · 目标完成\n' +
        '<untrusted-content source="session:c1">登录已修好</untrusted-content>\n' +
        '- [proposal] 提案已执行\n</session-updates>'
    )
  );
  expect(out).toContain('app · 修登录 · 目标完成');
  expect(out).toContain('提案已执行');
  expect(out).not.toContain('session-updates');
  expect(out).not.toContain('untrusted-content');
  expect(out).not.toContain('登录已修好');
});

it('普通用户消息仍是气泡原文', () => {
  expect(html(user('帮我看看进展'))).toContain('帮我看看进展');
});

it('目标续跑收成一行，标签和英文指令默认不露', () => {
  const out = html(
    user(
      '<goal-continuation>\nSession goal: 修好登录跳转。然后补测试\n' +
        'Continue working toward it. If it is genuinely done, call goal_complete with evidence;\n' +
        '</goal-continuation>'
    )
  );
  expect(out).toContain('data-enso="goal-continuation"');
  expect(out).toContain('data-open="false"');
  expect(out).toContain('Continue goal: 修好登录跳转。');
  expect(out).not.toContain('<goal-continuation>');
  expect(out).not.toContain('call goal_complete');
});

it('夹在别的文字里的目标块和定时块也不露标签', () => {
  const out = html(
    user(
      '先看这个\n\n<secretary-schedule>\n- [schedule] 巡检\n</secretary-schedule>\n' +
        '<agent-notification>\nworker finished\nmore\n</agent-notification>'
    )
  );
  expect(out).toContain('先看这个');
  expect(out).toContain('巡检');
  expect(out).toContain('worker finished');
  expect(out).not.toContain('<secretary-schedule>');
  expect(out).not.toContain('<agent-notification>');
});

it('多行定时收成一行系统通知，默认不露出标签和完整提示词', () => {
  const out = html(
    user(
      '<secretary-schedule>\n- [schedule] 巡检：巡检进行中的派发会话\n逐个看是否卡住\n</secretary-schedule>'
    )
  );
  expect(out).toContain('data-enso="secretary-schedule-card"');
  expect(out).toContain('data-open="false"');
  expect(out).toContain('Scheduled: 巡检进行中的派发会话');
  expect(out).not.toContain('<secretary-schedule>');
  expect(out).not.toContain('逐个看是否卡住');
  // 和其他系统注入块同一套虚线框，不再是带阴影的实线卡片
  expect(out).toContain('border-dashed');
  expect(out).not.toContain('shadow');
});

it('解析不了的回传也不露出标签名', () => {
  const out = html(user('<session-updates>\n不是列表\n第二行\n</session-updates>'));
  expect(out).toContain('data-enso="session-updates-card"');
  expect(out).toContain('data-open="false"');
  expect(out).toContain('Session updates: 不是列表');
  expect(out).not.toContain('<session-updates>');
  expect(out).not.toContain('第二行');
});

it('本机触发器事件收成一行折叠卡片，不露出标签和不可信外壳', () => {
  const out = html(
    user(
      '<secretary-trigger>\n- [trigger id=trg-abc12345 name="微信售后群"] (参半群)\nInstruction: 汇总异常\n<untrusted-content source="trigger:trg-abc12345">客户反馈快递破损</untrusted-content>\n</secretary-trigger>'
    )
  );
  expect(out).toContain('data-enso="secretary-trigger-card"');
  expect(out).toContain('data-open="false"');
  expect(out).toContain('Trigger: 微信售后群 · 参半群');
  expect(out).not.toContain('<secretary-trigger>');
  expect(out).not.toContain('<untrusted-content');
});

const IMG = '/Users/u/Library/Application Support/enso-code/bot-chats/secretary-images/c/ab12.png';
const image = { type: 'image' as const, data: 'eA==', mimeType: 'image/png' };

it('秘书贴图的路径行：有缩略图就隐藏，没有就变成「图片 N」标签，不露完整路径', () => {
  const text = `照这个改\n\n[图片 1] ${IMG}\n[图片 2] ${IMG}`;
  const out = html({ ...user(text), images: [image] } as TimelineItem);
  expect(out).toContain('照这个改');
  expect(out).not.toContain('Image 1<');
  expect(out).toContain('Image 2');
  expect(out).toContain('title="ab12.png"');
  expect(out).not.toContain('[图片');
  expect(out.replace(/src="[^"]*"/g, '')).not.toContain('secretary-images');
});

it('未收下的图片渲染成一行提示，不露方括号原文', () => {
  const out = html(user('看\n\n[图片 1 未收下] 超过 10MB，没有保存'));
  expect(out).toContain('Image 1 not accepted: over 10 MB, not saved');
  expect(out).not.toContain('[图片');
});

it('正文中间同样格式的文字原样保留', () => {
  const out = html(user(`[图片 1] ${IMG}\n\n后面还有话`));
  expect(out).toContain(`[图片 1] ${IMG}`);
  expect(out).not.toContain('data-enso="inbound-images"');
});
