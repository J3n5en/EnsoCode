import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginRenderer, type PluginRendererDeps } from './loader';
import { pluginMessageActions, resetPluginSlots } from './registry';

beforeEach(() => resetPluginSlots());

type Enso = {
  slots: { register: (registration: object) => unknown };
  dispatch: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
  composer?: {
    readDraft: () => Promise<unknown>;
    insertText: (input: { text: string }) => Promise<unknown>;
    replaceDraft: (input: { text: string; expect?: unknown }) => Promise<unknown>;
  };
};

const deps = (
  onLoad: (enso: unknown) => unknown,
  call: PluginRendererDeps['call'] = vi.fn(async () => 'v'),
  draft: PluginRendererDeps['draft'] = vi.fn(() => ({ ok: true as const, value: 'd' }))
): PluginRendererDeps => ({
  importModule: async () => ({ onLoad }),
  react: {},
  sessionId: () => 's1',
  call,
  draft,
});

describe('loadPluginRenderer', () => {
  it('登记挂点，卸载后全部收回', async () => {
    const handle = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        (enso as Enso).slots.register({
          slot: 'message.action',
          position: 'left',
          component: () => null,
        });
      })
    );
    expect(pluginMessageActions('left')).toHaveLength(1);
    handle.dispose();
    expect(pluginMessageActions('left')).toHaveLength(0);
  });

  it('onLoad 抛错时收回已登记的挂点', async () => {
    await expect(
      loadPluginRenderer(
        'a.b',
        'ui.js',
        deps((enso) => {
          (enso as Enso).slots.register({
            slot: 'message.action',
            position: 'left',
            component: () => null,
          });
          throw new Error('boom');
        })
      )
    ).rejects.toThrow('boom');
    expect(pluginMessageActions('left')).toHaveLength(0);
  });

  it('plugin.call 转到宿主调用并带上当前会话', async () => {
    const call = vi.fn(async () => 'pong');
    await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps(async (enso) => {
        await (enso as Enso).dispatch('plugin.call', { method: 'ping', args: { a: 1 } });
      }, call)
    );
    expect(call).toHaveBeenCalledWith('a.b', 'ping', { a: 1 }, 's1');
  });

  it('没有 onLoad 时失败', async () => {
    const broken: PluginRendererDeps = {
      importModule: async () => ({}),
      react: {},
      sessionId: () => null,
      call: vi.fn(),
      draft: vi.fn(),
    };
    await expect(loadPluginRenderer('a.b', 'ui.js', broken)).rejects.toThrow(/onLoad/);
  });

  it('有 composer.draft 权限时提供草稿接口，按当前会话直接读写输入框', async () => {
    const draft = vi.fn(() => ({ ok: true as const, value: { rev: 'r2' } }));
    let enso: Enso | undefined;
    await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps(
        (e) => {
          enso = e as Enso;
        },
        undefined,
        draft
      ),
      { draft: true }
    );
    await expect(
      enso?.composer?.replaceDraft({ text: 'new', expect: { rev: 'r1' } })
    ).resolves.toEqual({
      rev: 'r2',
    });
    expect(draft).toHaveBeenCalledWith({
      sessionId: 's1',
      op: 'replaceDraft',
      payload: { text: 'new', expect: { rev: 'r1' } },
    });
  });

  it('草稿失败抛出带 code 的错误；没有权限时不提供草稿接口', async () => {
    const draft = vi.fn(() => ({ ok: false as const, code: 'DRAFT_CHANGED', error: 'changed' }));
    let enso: Enso | undefined;
    await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps(
        (e) => {
          enso = e as Enso;
        },
        undefined,
        draft
      ),
      { draft: true }
    );
    await expect(enso?.composer?.insertText({ text: 'x' })).rejects.toMatchObject({
      code: 'DRAFT_CHANGED',
    });

    let plain: Enso | undefined;
    await loadPluginRenderer(
      'c.d',
      'ui.js',
      deps((e) => {
        plain = e as Enso;
      })
    );
    expect(plain?.composer).toBeUndefined();
  });

  it('没有会话时草稿接口报 NO_SESSION', async () => {
    let enso: Enso | undefined;
    await loadPluginRenderer(
      'a.b',
      'ui.js',
      {
        ...deps((e) => {
          enso = e as Enso;
        }),
        sessionId: () => null,
      },
      { draft: true }
    );
    await expect(enso?.composer?.readDraft()).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  it('旧一代卸载不会清掉新一代挂点', async () => {
    const first = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        (enso as Enso).slots.register({
          slot: 'message.action',
          position: 'left',
          component: () => null,
        });
      })
    );
    const second = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        (enso as Enso).slots.register({
          slot: 'message.action',
          position: 'right',
          component: () => null,
        });
      })
    );
    first.dispose();
    expect(pluginMessageActions('left')).toHaveLength(0);
    expect(pluginMessageActions('right')).toHaveLength(1);
    second.dispose();
    expect(pluginMessageActions('right')).toHaveLength(0);
  });

  // 真实场景：宿主在 effect 清理里卸载插件（切到 Bot/远程节点），插件清理函数抛错会冒到 React，
  // 没有错误边界兜底时整页白屏；且其后登记的挂点与 clearPluginSlots 都被跳过。
  it('插件清理函数抛错时仍收回全部挂点，且不抛给调用方', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let register: Enso['slots']['register'] | undefined;
    const handle = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        register = (enso as Enso).slots.register;
        return () => {
          throw new Error('cleanup boom');
        };
      })
    );
    // onLoad 返回后再登记的挂点排在清理函数之后
    register?.({ slot: 'message.action', position: 'left', component: () => null });
    expect(() => handle.dispose()).not.toThrow();
    expect(pluginMessageActions('left')).toHaveLength(0);
    warn.mockRestore();
  });

  it('卸载之后再登记会被忽略', async () => {
    let register: Enso['slots']['register'] | undefined;
    const handle = await loadPluginRenderer(
      'a.b',
      'ui.js',
      deps((enso) => {
        register = (enso as Enso).slots.register;
      })
    );
    handle.dispose();
    register?.({ slot: 'message.action', position: 'left', component: () => null });
    expect(pluginMessageActions('left')).toHaveLength(0);
  });
});
