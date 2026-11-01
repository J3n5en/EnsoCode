import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import { loadPluginRenderer, type PluginRendererDeps } from '../../../renderer/plugins/loader';
import {
  pluginBlock,
  pluginComposerSlots,
  pluginMessageActions,
  pluginToolCard,
  resetPluginSlots,
} from '../../../renderer/plugins/registry';
import type { GateDeps } from './gate';
import { ExtensionPluginService } from './service';

const EXAMPLES = resolve(import.meta.dirname, '../../../../examples/plugins');

class InProcessChild extends EventEmitter {
  pid = 1;
  private handler: (m: unknown) => void = () => {};
  constructor() {
    super();
    runPluginHost({
      send: (m) => queueMicrotask(() => this.emit('message', m)),
      onMessage: (h) => (this.handler = h),
    });
    queueMicrotask(() => this.emit('spawn'));
  }
  postMessage(m: unknown) {
    queueMicrotask(() => {
      this.handler(m);
      if (typeof m === 'object' && m !== null && (m as { t?: string }).t === 'shutdown')
        this.emit('exit', 0);
    });
  }
  kill() {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

let service: ExtensionPluginService;
let composer: ReturnType<typeof vi.fn<GateDeps['composer']>>;
let fetchMock: ReturnType<typeof vi.fn<GateDeps['fetch']>>;
let mcpTools: ReturnType<typeof vi.fn<GateDeps['mcpTools']>>;
let mcpCall: ReturnType<typeof vi.fn<GateDeps['mcpCall']>>;

beforeEach(() => {
  resetPluginSlots();
  composer = vi.fn<GateDeps['composer']>(async (_target, op) =>
    op === 'readDraft' ? { text: 'hi', hasReferences: false, generation: 'c1', rev: 'r1' } : null
  );
  fetchMock = vi.fn<GateDeps['fetch']>();
  mcpTools = vi.fn<GateDeps['mcpTools']>(async () => []);
  mcpCall = vi.fn<GateDeps['mcpCall']>(async () => ({ content: '', isError: false }));
  service = new ExtensionPluginService({
    root: temp('enso-examples-'),
    hostVersion: '0.2.12',
    hostPath: '/unused',
    env: {},
    fork: () => new InProcessChild() as never,
    gate: {
      fetch: fetchMock,
      notify: () => true,
      composer,
      mcpTools,
      mcpCall,
      now: () => Date.now(),
    },
  });
});
afterEach(() => {
  service.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function installExample(name: string): Promise<string> {
  const staged = await service.stage({ kind: 'dir', path: join(EXAMPLES, name) });
  if (!staged.ok) throw new Error(staged.error);
  expect(staged.preview.warnings).toEqual([]);
  const committed = await service.commit(staged.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  expect(service.setEnabled(staged.preview.id, true).ok).toBe(true);
  return staged.preview.id;
}

const ui = (pluginId: string, method: string, payload: Record<string, unknown>) =>
  service.callUi({
    pluginId,
    method: method as 'renderer.call',
    payload,
    sessionId: 'c1',
    projectRoot: null,
    origin: 1,
  });

async function loadUi(
  dir: string,
  pluginId: string,
  extra: Partial<PluginRendererDeps> = {},
  options: { draft?: boolean } = {}
) {
  return loadPluginRenderer(
    pluginId,
    'ui.js',
    {
      importModule: (_id, rel) => import(pathToFileURL(join(EXAMPLES, dir, rel)).href),
      react: await import('react'),
      sessionId: () => 'c1',
      call: async () => null,
      draft: () => ({ ok: false, code: 'NO_COMPOSER', error: 'no composer' }),
      ...extra,
    },
    options
  );
}

describe('示例插件', () => {
  it('word-stats：工具读项目文件并统计，渲染模块登记卡片与代码块', async () => {
    const id = await installExample('word-stats');
    expect(service.skillPathsForSpawn()[0]).toMatch(/skills[/\\]bar-chart$/);
    const project = temp('enso-project-');
    writeFileSync(join(project, 'a.md'), 'apple banana apple\ncherry apple banana\n');
    const result = await service.callTool({
      toolName: 'plugin_enso-example-wordstats__count_words',
      args: { path: 'a.md', top: 2 },
      sessionId: 'c1',
      projectRoot: project,
    });
    expect(result.content).toBe('a.md: 6 words, 3 lines, 39 characters\napple: 3\nbanana: 2');
    await loadUi('word-stats', id);
    expect(pluginToolCard(id, 'count_words')).toBeDefined();
    expect(pluginBlock(id, 'bars')).toBeDefined();
  });

  it('snippets：# 补全与选中、时间戳与引用都写回发起窗口的草稿', async () => {
    const id = await installExample('snippets');
    const candidates = (await ui(id, 'trigger.candidates', {
      name: 'snippet',
      query: 'rev',
    })) as { id: string }[];
    expect(candidates.map((c) => c.id)).toEqual(['review']);
    const picked = (await ui(id, 'trigger.pick', {
      name: 'snippet',
      item: { id: 'review' },
    })) as { text: string };
    expect(picked.text).toContain('审查');

    await ui(id, 'renderer.call', { method: 'insertTimestamp', args: null });
    expect(composer).toHaveBeenLastCalledWith(
      { sessionId: 'c1', origin: 1 },
      'insertText',
      expect.objectContaining({
        text: expect.stringMatching(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] $/),
      })
    );

    await ui(id, 'renderer.call', { method: 'quote', args: { text: 'a\nb' } });
    expect(composer).toHaveBeenLastCalledWith({ sessionId: 'c1', origin: 1 }, 'replaceDraft', {
      text: 'hi\n\n> a\n> b\n\n',
      expect: { generation: 'c1', rev: 'r1' },
    });

    await loadUi('snippets', id);
    expect(pluginComposerSlots('right')).toHaveLength(1);
    expect(pluginMessageActions('right')).toHaveLength(1);
  });

  it('notes：侧栏页面经 renderer.call 增删查，插入走草稿', async () => {
    const id = await installExample('notes');
    expect(service.list()[0]?.views).toEqual([
      { id: 'notes', title: 'Notes', entry: 'notes.html' },
    ]);
    expect(service.assetPath(id, 'notes.html')).toBeTruthy();
    const added = (await ui(id, 'renderer.call', {
      method: 'add',
      args: { text: ' hello ' },
    })) as { id: string; text: string }[];
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe('hello');
    await ui(id, 'renderer.call', { method: 'insert', args: { id: added[0]?.id } });
    expect(composer).toHaveBeenLastCalledWith({ sessionId: 'c1', origin: 1 }, 'insertText', {
      text: 'hello',
    });
    expect(await ui(id, 'renderer.call', { method: 'remove', args: { id: added[0]?.id } })).toEqual(
      []
    );
  });

  it('github-repo：只经白名单域名取数据', async () => {
    await installExample('github-repo');
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/releases/latest')
        ? new Response(JSON.stringify({ tag_name: 'v1.2.0', published_at: '2026-01-02T00:00:00Z' }))
        : new Response(
            JSON.stringify({
              full_name: 'a/b',
              description: 'demo',
              stargazers_count: 42,
              forks_count: 3,
              open_issues_count: 1,
              default_branch: 'main',
              license: { spdx_id: 'MIT' },
              html_url: 'https://github.com/a/b',
            })
          )
    );
    const result = await service.callTool({
      toolName: 'plugin_enso-example-github__repo_info',
      args: { repo: 'a/b' },
      sessionId: 'c1',
      projectRoot: null,
    });
    expect(result.content).toContain('stars 42');
    expect(result.content).toContain('latest release v1.2.0 (2026-01-02)');
    expect(fetchMock.mock.calls.map(([url]) => new URL(url as string).host)).toEqual([
      'api.github.com',
      'api.github.com',
    ]);
  });

  it('digest：进度、产出文件和 session_start', async () => {
    const id = await installExample('digest');
    const progress: string[] = [];
    const result = await service.callTool({
      toolName: 'plugin_enso-example-digest__summarize',
      args: { text: 'hello digest' },
      sessionId: 'c1',
      projectRoot: null,
      onProgress: (text) => progress.push(text),
    });
    expect(progress).toEqual(['正在摘要']);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ name: 'digest.txt', pluginId: id });
    await service.dispatchEvent({
      sessionId: 'c1',
      projectRoot: null,
      event: 'session_start',
      data: { reason: 'startup' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const again = await service.callTool({
      toolName: 'plugin_enso-example-digest__summarize',
      args: { text: 'again' },
      sessionId: 'c1',
      projectRoot: null,
    });
    expect(again.content).toContain('会话开始 1 次');
    expect(service.list().find((item) => item.id === id)).toMatchObject({
      resident: true,
      events: [{ event: 'session_start', mode: 'observe' }],
      schedules: [{ id: 'sweep', intervalSeconds: 3600 }],
    });
  });

  describe('prompt-enhance（移植自 dsh-bce）', () => {
    const enhance = (id: string, prompt: string, projectRoot: string | null = '/repo') =>
      service.callUi({
        pluginId: id,
        method: 'renderer.call',
        payload: { method: 'enhance', args: { prompt } },
        sessionId: 'c1',
        projectRoot,
        origin: 1,
      });

    it('先增量索引再改写；服务按配置 > 名字含 bce 选择', async () => {
      const id = await installExample('prompt-enhance');
      mcpTools.mockResolvedValue([
        { server: 'other', name: 'enhance_prompt', description: '' },
        { server: 'my-bce', name: 'enhance_prompt', description: '' },
        { server: 'my-bce', name: 'search_context', description: '' },
      ]);
      mcpCall.mockImplementation(async (_t, _s, tool) =>
        tool === 'enhance_prompt'
          ? { content: '  better prompt  ', isError: false }
          : { content: 'indexed', isError: false }
      );
      await expect(enhance(id, ' fix the bug ')).resolves.toEqual({
        ok: true,
        text: 'better prompt',
      });
      expect(mcpCall.mock.calls.map(([, server, tool, args]) => [server, tool, args])).toEqual([
        ['my-bce', 'search_context', { project_root_path: '/repo', query: 'fix the bug' }],
        [
          'my-bce',
          'enhance_prompt',
          { project_root_path: '/repo', prompt: 'fix the bug', conversation_history: '' },
        ],
      ]);

      service.setConfig(id, { server: 'other' });
      mcpCall.mockClear();
      await expect(enhance(id, 'x')).resolves.toEqual({
        ok: true,
        text: 'better prompt',
        warning: 'no_index',
      });
      expect(mcpCall.mock.calls.map(([, server, tool]) => [server, tool])).toEqual([
        ['other', 'enhance_prompt'],
      ]);
    });

    it('没有项目、没有 MCP、索引失败时给出可读的错误码', async () => {
      const id = await installExample('prompt-enhance');
      await expect(enhance(id, 'x', null)).resolves.toMatchObject({
        ok: false,
        code: 'no_workspace',
      });
      await expect(enhance(id, 'x')).resolves.toMatchObject({ ok: false, code: 'mcp_missing' });
      mcpTools.mockResolvedValue([
        { server: 'bce', name: 'enhance_prompt', description: '' },
        { server: 'bce', name: 'search_context', description: '' },
      ]);
      mcpCall.mockResolvedValue({ content: 'Error: path is not a git repository', isError: true });
      await expect(enhance(id, 'x')).resolves.toMatchObject({ ok: false, code: 'not_git' });
      mcpCall.mockRejectedValue(Object.assign(new Error('MCP 调用超时'), { code: 'TIMEOUT' }));
      await expect(enhance(id, 'x')).resolves.toMatchObject({ ok: false, code: 'index_timeout' });
    });

    it('界面：按读取时的版本替换草稿，草稿被改过就不覆盖', async () => {
      const { enhanceDraft } = await import(
        pathToFileURL(join(EXAMPLES, 'prompt-enhance', 'ui.js')).href
      );
      const replaceDraft = vi.fn(async () => ({ rev: 'r2' }));
      const enso = {
        composer: {
          readDraft: async () => ({
            text: 'fix it',
            generation: 'c1',
            rev: 'r1',
            hasReferences: false,
          }),
          replaceDraft,
        },
        dispatch: vi.fn(async () => ({ ok: true, text: 'better' })),
      };
      await expect(enhanceDraft(enso, 'c1')).resolves.toMatchObject({
        ok: true,
        original: 'fix it',
        enhanced: 'better',
      });
      expect(enso.dispatch).toHaveBeenCalledWith('plugin.call', {
        method: 'enhance',
        args: { prompt: 'fix it' },
      });
      expect(replaceDraft).toHaveBeenCalledWith({
        text: 'better',
        expect: { generation: 'c1', rev: 'r1' },
      });
      replaceDraft.mockRejectedValueOnce(
        Object.assign(new Error('changed'), { code: 'DRAFT_CHANGED' })
      );
      await expect(enhanceDraft(enso, 'c1')).resolves.toEqual({
        ok: false,
        message: '增强期间草稿被改过，没有替换',
      });
    });
  });
});
