import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBar } from './ApprovalBar';

const highlight = vi.hoisted(() => ({ codeToHtml: vi.fn() }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? ''),
    locale: 'zh',
  }),
}));
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

describe('ApprovalBar dcg 规则解释', () => {
  const guarded = (ruleId: string, reason = 'english reason') => ({
    ...request,
    summary: 'git push --force',
    protected: 'destructive',
    guard: { ruleId, reason },
  });

  it('命中对照表：展示会做什么、为什么危险和可复制的安全替代', () => {
    const html = render([guarded('core.git:push-force-long')]);
    expect(html).toContain('强制推送');
    expect(html).toContain('Why it is dangerous');
    expect(html).toContain('Safer alternative');
    expect(html).toContain('git push --force-with-lease');
    expect(html.match(/title="Copy"/g)?.length).toBe(2);
    expect(html).not.toContain('english reason');
  });

  it('对照表没有替代时不显示替代区块', () => {
    const html = render([guarded('core.filesystem:rm-rf-general')]);
    expect(html).toContain('Why it is dangerous');
    expect(html).not.toContain('Safer alternative');
  });

  it('查不到规则回退 dcg 英文原因', () => {
    const html = render([guarded('system.disk:nwipe', 'nwipe overwrites the disk')]);
    expect(html).toContain('nwipe overwrites the disk');
    expect(html).not.toContain('Why it is dangerous');
  });

  it('内置守卫区分 Temp 根安全底线与非底线内置守卫（如 enso.dcg:invalid-verdict）', () => {
    const invalidHtml = render([
      guarded('enso.dcg:invalid-verdict', 'Command guard returned an unexpected response'),
    ]);
    expect(invalidHtml).toContain('enso.dcg:invalid-verdict');
    expect(invalidHtml).toContain('Blocked by built-in guard');
    expect(invalidHtml).not.toContain('Safety floor rule');
  });

  it('带出风险等级、命中片段与可折叠的 dcg 说明；warn 档用提醒而非拦截文案', () => {
    const deny = render([
      {
        ...guarded('core.git:reset-hard'),
        guard: {
          ruleId: 'core.git:reset-hard',
          reason: 'r',
          decision: 'ask',
          severity: 'critical',
          matched: 'git reset --hard',
          explanation: 'discards ALL uncommitted changes',
        },
      },
    ]);
    expect(deny).toContain('Critical');
    expect(deny).toContain('git reset --hard</code>');
    expect(deny).toContain('discards ALL uncommitted changes');
    expect(deny).toContain('text-destructive');
    const { protected: _protected, ...plain } = guarded('core.git:stash-drop');
    const warn = render([{ ...plain, guard: { ...plain.guard, decision: 'warn' } }]);
    expect(warn).toContain('dcg notice: ');
    expect(warn).not.toContain('dcg: ');
  });

  it('内置守卫规则直接显示原因，dcg 规则保留 dcg 前缀', () => {
    const reason = 'Deletes in the shared system Temp folder root.';
    const enso = render([
      { ...request, guard: { ruleId: 'enso.windows:temp-root-delete', reason } },
    ]);
    expect(enso).toContain(reason);
    expect(enso).not.toContain('dcg: ');
    expect(enso).toContain('enso.windows:temp-root-delete');
    expect(enso).toContain('full-access mode');
    const dcg = render([{ ...request, guard: { ruleId: 'core.git:reset-hard', reason: 'x' } }]);
    expect(dcg).toContain('dcg: ');
    expect(dcg).toContain('core.git:reset-hard');
    expect(dcg).toContain('full-access mode');
  });

  it('不可豁免高危规则说明安全底线与不可豁免原因，warn 档不显示拦截底线说明', () => {
    const floor = render([guarded('core.filesystem:rm-rf-root-home')]);
    expect(floor).toContain('core.filesystem:rm-rf-root-home');
    expect(floor).toContain('cannot be exempted');
    expect(floor).toContain('full-access mode');

    const { protected: _protected, ...plain } = guarded('core.git:stash-drop');
    const warn = render([{ ...plain, guard: { ...plain.guard, decision: 'warn' } }]);
    expect(warn).not.toContain('full-access mode');
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

  it('记忆豁免需要用户二次确认才生效，单击提示不会直接豁免', async () => {
    const ruleState = vi
      .fn()
      .mockResolvedValue({ allowCount: 5, exempt: false, suggestExempt: true });
    const ruleExempt = vi
      .fn()
      .mockResolvedValue({ allowCount: 5, exempt: true, suggestExempt: false });
    Object.assign(window, {
      electronAPI: {
        dcg: { ruleState, ruleExempt, ruleAllowed: vi.fn().mockResolvedValue(null) },
      },
    });
    await mount([
      {
        ...request,
        summary: 'git reset --hard',
        protected: 'destructive',
        guard: { ruleId: 'core.git:reset-hard', reason: 'r' },
      },
    ]);
    const askBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Always allow this rule')
    );
    expect(askBtn).toBeDefined();
    await act(async () => askBtn?.click());
    expect(ruleExempt).not.toHaveBeenCalled();
    const confirmBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Confirm exemption')
    );
    expect(confirmBtn).toBeDefined();
    await act(async () => confirmBtn?.click());
    expect(ruleExempt).toHaveBeenCalledWith('core.git:reset-hard');
  });

  it('decision=ask 时不查询/展示记忆豁免，点 Allow 也不累计放行次数', async () => {
    const ruleState = vi
      .fn()
      .mockResolvedValue({ allowCount: 5, exempt: false, suggestExempt: true });
    const ruleAllowed = vi.fn().mockResolvedValue(null);
    Object.assign(window, {
      electronAPI: {
        dcg: { ruleState, ruleExempt: vi.fn(), ruleAllowed },
      },
    });
    await mount([
      {
        ...request,
        summary: 'git reset --hard',
        protected: 'destructive',
        guard: { ruleId: 'core.git:reset-hard', reason: 'r', decision: 'ask' },
      },
    ]);
    expect(ruleState).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Always allow this rule');
    await act(async () => vi.advanceTimersByTime(1000));
    await allow();
    expect(ruleAllowed).not.toHaveBeenCalled();
  });
});
