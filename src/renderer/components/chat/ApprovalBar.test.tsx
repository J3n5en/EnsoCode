import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalBar } from './ApprovalBar';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const request = { requestId: 'r', tool: 'bash', kind: 'command' as const, summary: 'ls' };
const render = (approvals: unknown[]) =>
  renderToStaticMarkup(
    createElement(ApprovalBar, { approvals: approvals as never, onRespond: () => {} })
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
