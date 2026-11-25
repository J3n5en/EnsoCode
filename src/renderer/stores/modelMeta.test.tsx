import type { ModelMeta, ModelMetaQuery, ModelMetaResult, ModelProvider } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/settings', async () => {
  const { create } = await import('zustand');
  return { useSettingsStore: create(() => ({ providers: [] as ModelProvider[] })) };
});

const { invalidateModelMeta, useModelMeta } = await import('./modelMeta');

const provider = (id: string, models: string[]): ModelProvider => ({
  id,
  name: id,
  api: 'openai-completions',
  apiKey: 'k',
  baseUrl: 'https://example.test',
  enabled: true,
  models: models.map((model) => ({ id: model })),
});
const alpha = provider('alpha', ['a-1', 'a-2']);
const beta = provider('beta', ['b-1']);

let root: Root;
let pending: Array<{ query: ModelMetaQuery; resolve: (result: ModelMetaResult) => void }>;
const renders: Record<string, number> = {};
const shown: Record<string, string> = {};

function Probe({ name, of }: { name: string; of: ModelProvider }) {
  const meta = useModelMeta(of);
  renders[name] = (renders[name] ?? 0) + 1;
  shown[name] = Object.keys(meta).sort().join(',');
  return null;
}

const answer = (index: number, ok = true) =>
  act(async () => {
    const { query, resolve } = pending[index];
    const models: ModelMeta[] = query.modelIds.map((modelId) => ({ modelId, source: 'unknown' }));
    resolve(ok ? { ok: true, models } : { ok: false, models: [], error: 'Invalid query' });
  });

const mount = (probes: Array<[string, ModelProvider]>) =>
  act(async () =>
    root.render(probes.map(([name, of]) => <Probe key={name} name={name} of={of} />))
  );

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  pending = [];
  vi.stubGlobal('window', {
    ...dom.window,
    electronAPI: {
      providers: {
        modelMeta: (query: ModelMetaQuery) =>
          new Promise<ModelMetaResult>((resolve) => pending.push({ query, resolve })),
        onOauthLoginEvent: () => () => {},
      },
    },
  });
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const key of Object.keys(renders)) delete renders[key];
  invalidateModelMeta();
  root = createRoot(document.getElementById('root') as unknown as HTMLElement);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useModelMeta', () => {
  it('同一服务商的多个选择器只向 Main 查一次，结果共享', async () => {
    await mount([
      ['p1', alpha],
      ['p2', alpha],
      ['p3', alpha],
    ]);
    expect(pending).toHaveLength(1);
    await answer(0);
    expect([shown.p1, shown.p2, shown.p3]).toEqual(['a-1,a-2', 'a-1,a-2', 'a-1,a-2']);
  });

  it('一个服务商的结果到达时，别的服务商的选择器不重渲染', async () => {
    await mount([
      ['onAlpha', alpha],
      ['onBeta', beta],
    ]);
    await answer(pending.findIndex((p) => p.query.modelIds[0] === 'b-1'));
    const before = renders.onBeta;
    await answer(pending.findIndex((p) => p.query.modelIds[0] === 'a-1'));
    expect(shown.onAlpha).toBe('a-1,a-2');
    expect(renders.onBeta).toBe(before);
  });

  it('离开再回来不重复查询，已有结果直接可用；缓存失效后才重查', async () => {
    await mount([['p1', alpha]]);
    await answer(0);
    await mount([]);
    await mount([['again', alpha]]);
    expect(pending).toHaveLength(1);
    expect(shown.again).toBe('a-1,a-2');

    await act(async () => invalidateModelMeta());
    expect(pending).toHaveLength(2);
  });

  it('查询被拒后重新进入会再试', async () => {
    await mount([['p1', alpha]]);
    await answer(0, false);
    await mount([]);
    await mount([['p1', alpha]]);
    expect(pending).toHaveLength(2);
  });
});
