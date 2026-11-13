import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBar } from './ApprovalBar';

const highlight = vi.hoisted(() => ({ codeToHtml: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./snippetHighlighter', () => ({ codeToHtml: highlight.codeToHtml }));

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

describe('ApprovalBar 队首切换', () => {
  let root: Root;
  let container: HTMLElement;
  const onRespond = vi.fn();
  const mount = (approvals: unknown[]) =>
    act(async () =>
      root.render(createElement(ApprovalBar, { approvals: approvals as never, onRespond }))
    );
  const allow = () => {
    const button = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'Allow'
    );
    if (!button) throw new Error('Missing Allow');
    return act(async () => button.click());
  };
  const next = { ...request, requestId: 'r2', summary: 'rm -rf build' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onRespond.mockReset();
    highlight.codeToHtml.mockReset().mockReturnValue(new Promise(() => {}));
    container = window.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // 真实场景：pi 并行工具逐个等审批，批完一条下一条几十毫秒内出现在原位，双击"允许"的第二下落在它上面
  it('双击允许时第二下不会批准紧接着出现的下一条审批', async () => {
    await mount([request]);
    await act(async () => vi.advanceTimersByTime(1000));
    await allow();
    await mount([next]);
    await allow();
    expect(onRespond.mock.calls).toEqual([['r', 'allow']]);
  });

  it('下一条审批出现片刻后可以正常批准', async () => {
    await mount([request]);
    await act(async () => vi.advanceTimersByTime(1000));
    await allow();
    await mount([next]);
    await act(async () => vi.advanceTimersByTime(1000));
    await allow();
    expect(onRespond.mock.calls).toEqual([
      ['r', 'allow'],
      ['r2', 'allow'],
    ]);
  });

  it('换成下一条命令审批时不残留上一条命令的高亮内容', async () => {
    highlight.codeToHtml
      .mockResolvedValueOnce('<pre class="shiki">ls</pre>')
      .mockReturnValue(new Promise(() => {}));
    await mount([request]);
    expect(container.querySelector('.shiki')?.textContent).toBe('ls');
    await mount([next]);
    expect(container.querySelector('.shiki')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('rm -rf build');
  });
});
