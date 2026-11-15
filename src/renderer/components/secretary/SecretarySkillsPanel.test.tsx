import type { SecretarySkillView } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  skills: [] as SecretarySkillView[],
  settingsSkills: [] as { id: string; name: string }[],
  profile: { skillIds: ['s-review'] as string[], disabledSkillNames: [] as string[] },
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
    locale: 'zh',
  }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({ secretary: { profile: h.profile } }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ skills: h.settingsSkills }),
}));
// 正文渲染由 Markdown 自己的用例覆盖，这里只看面板把哪段正文交出去了
vi.mock('@/components/chat/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <pre data-enso="markdown">{text}</pre>,
}));

const { SecretarySkillsPanel } = await import('./SecretarySkillsPanel');

const ownSkill = (name: string, enabled = true): SecretarySkillView => ({
  id: name,
  name,
  description: `${name} 的一句话说明`,
  source: 'own',
  enabled,
  body: `# ${name}\n\n正文`,
});

const globalSkill = (id: string, enabled: boolean): SecretarySkillView => ({
  id,
  name: id.replace(/^s-/, ''),
  description: `${id} 的说明`,
  source: 'global',
  enabled,
});

let root: Root;
let container: HTMLElement;
let api: {
  listSkills: ReturnType<typeof vi.fn>;
  setSkillEnabled: ReturnType<typeof vi.fn>;
  removeSkill: ReturnType<typeof vi.fn>;
  readSkill: ReturnType<typeof vi.fn>;
};

const rows = () => [...container.querySelectorAll('[data-enso="secretary-skill-row"]')];
const rowOf = (name: string) =>
  rows().find((row) => row.textContent?.includes(name)) as HTMLElement | undefined;
/** 行里必须有这个节点：拿不到就当场失败，别让断言在 undefined 上打转 */
const part = (name: string, selector: string): HTMLElement => {
  const node = rowOf(name)?.querySelector(selector);
  if (!node) throw new Error(`missing ${selector} in ${name}`);
  return node as unknown as HTMLElement;
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.skills = [ownSkill('deploy-check'), ownSkill('quiet', false), globalSkill('s-review', true)];
  h.settingsSkills = [{ id: 's-review', name: 'review' }];
  h.profile = { skillIds: ['s-review'], disabledSkillNames: ['quiet'] };
  api = {
    listSkills: vi.fn(async () => ({ ok: true, skills: h.skills })),
    setSkillEnabled: vi.fn(async () => ({ ok: true })),
    removeSkill: vi.fn(async () => ({ ok: true, name: 'deploy-check' })),
    readSkill: vi.fn(async () => ({ ok: true, body: '# review\n\n审代码' })),
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = { secretary: api };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root.render(<SecretarySkillsPanel />);
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('SecretarySkillsPanel', () => {
  it('按来源分两组：秘书专属与全局共享，每条带说明与启用状态', () => {
    const groups = [...container.querySelectorAll('[data-enso="secretary-skill-group"]')];
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual(['own', 'global']);
    expect(groups[0].textContent).toContain('Own skills');
    expect(groups[1].textContent).toContain('Shared global skills');
    expect(rows().map((row) => row.getAttribute('data-source'))).toEqual(['own', 'own', 'global']);
    expect(rowOf('deploy-check')?.textContent).toContain('deploy-check 的一句话说明');
    expect(rowOf('deploy-check')?.getAttribute('data-enabled')).toBe('true');
    expect(rowOf('quiet')?.getAttribute('data-enabled')).toBe('false');
    expect(rowOf('quiet')?.textContent).toContain('Disabled');
    expect(rowOf('s-review')?.getAttribute('data-enabled')).toBe('true');
  });

  it('停用与启用都交给 Main，按来源区分', async () => {
    await act(async () => {
      part('deploy-check', '[data-enso="secretary-skill-toggle"]').click();
    });
    await flush();
    expect(api.setSkillEnabled).toHaveBeenCalledWith({
      id: 'deploy-check',
      source: 'own',
      enabled: false,
    });
    await act(async () => {
      part('s-review', '[data-enso="secretary-skill-toggle"]').click();
    });
    await flush();
    expect(api.setSkillEnabled).toHaveBeenLastCalledWith({
      id: 's-review',
      source: 'global',
      enabled: false,
    });
    // 改完重读同一份列表，设置页那边变了这里也跟着变
    expect(api.listSkills).toHaveBeenCalledTimes(3);
  });

  it('删除要二次确认，全局 skill 没有删除入口', async () => {
    expect(rowOf('s-review')?.querySelector('[data-enso="secretary-skill-delete"]')).toBeNull();
    act(() => part('deploy-check', '[data-enso="secretary-skill-delete"]').click());
    expect(api.removeSkill).not.toHaveBeenCalled();
    expect(
      rowOf('deploy-check')?.querySelector('[data-enso="secretary-skill-confirm"]')
    ).not.toBeNull();
    await act(async () => {
      part('deploy-check', '[data-enso="secretary-skill-confirm-delete"]').click();
    });
    await flush();
    expect(api.removeSkill).toHaveBeenCalledWith('deploy-check');
  });

  it('取消二次确认不会删', () => {
    act(() => part('deploy-check', '[data-enso="secretary-skill-delete"]').click());
    act(() => part('deploy-check', '[data-enso="secretary-skill-confirm-cancel"]').click());
    expect(
      rowOf('deploy-check')?.querySelector('[data-enso="secretary-skill-confirm"]')
    ).toBeNull();
    expect(api.removeSkill).not.toHaveBeenCalled();
  });

  it('点开看正文：自有的随列表给，全局的按需读，正文标成只给用户看', async () => {
    await act(async () => {
      part('deploy-check', '[data-enso="secretary-skill-expand"]').click();
    });
    await flush();
    const ownBody = rowOf('deploy-check')?.querySelector('[data-enso="secretary-skill-body"]');
    expect(ownBody?.textContent).toContain('Shown for you only');
    expect(ownBody?.querySelector('[data-enso="markdown"]')?.textContent).toContain(
      '# deploy-check'
    );
    expect(api.readSkill).not.toHaveBeenCalled();

    await act(async () => {
      part('s-review', '[data-enso="secretary-skill-expand"]').click();
    });
    await flush();
    expect(api.readSkill).toHaveBeenCalledWith({ id: 's-review', source: 'global' });
    expect(rowOf('s-review')?.querySelector('[data-enso="markdown"]')?.textContent).toContain(
      '审代码'
    );
  });

  it('没有任何 skill 时给一行说明', async () => {
    h.skills = [];
    await act(async () => {
      root.render(<SecretarySkillsPanel key="empty" />);
    });
    await flush();
    expect(container.querySelector('[data-enso="secretary-skills"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-skills-empty"]')?.textContent).toContain(
      'The secretary has no skills yet. Ask it to propose one.'
    );
  });
});
