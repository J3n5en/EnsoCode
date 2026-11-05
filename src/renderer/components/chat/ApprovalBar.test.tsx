import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalBar } from './ApprovalBar';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const request = { requestId: 'r', tool: 'bash', kind: 'command' as const, summary: 'ls' };
const render = (approvals: unknown[], props?: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(ApprovalBar, {
      approvals: approvals as never,
      onRespond: () => {},
      ...props,
    })
  );

describe('ApprovalBar 托管判定退回人工', () => {
  it('卡片说明托管判定为什么退回人工', () => {
    expect(render([{ ...request, reviewFallback: 'timeout' }])).toContain(
      'Auto-managed review timed out. Please decide.'
    );
    expect(render([{ ...request, reviewFallback: 'invalid' }])).toContain(
      'Auto-managed review returned no valid decision. Please decide.'
    );
    expect(render([request])).not.toContain('Auto-managed');
  });
});

describe('ApprovalBar 复制详情', () => {
  it('有命令详情时右上角提供复制按钮', () => {
    expect(render([request])).toContain('title="Copy"');
  });

  it('没有详情时不显示复制按钮', () => {
    const { summary: _summary, ...withoutSummary } = request;
    expect(render([withoutSummary])).not.toContain('title="Copy"');
  });
});

describe('ApprovalBar 打回与代审', () => {
  it('命令卡可以打回换命令，也可以交给助手代审', () => {
    const html = render([request]);
    expect(html).toContain('>Adjust<');
    expect(html).toContain('title="Send back for a safer command"');
    expect(html).toContain('>Assistant review<');
    expect(html).toContain('title="Let the assistant decide"');
  });

  it('非命令审批只有代审，没有打回换命令', () => {
    const html = render([{ ...request, kind: 'file-edit', summary: 'a.ts' }]);
    expect(html).not.toContain('>Adjust<');
    expect(html).toContain('>Assistant review<');
  });

  it('能力审批不提供打回或代审', () => {
    const html = render([request], { handoff: false });
    expect(html).not.toContain('>Adjust<');
    expect(html).not.toContain('>Assistant review<');
  });
});
