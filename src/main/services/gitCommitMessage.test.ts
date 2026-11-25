import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_GIT_COMMIT_PROMPT } from '@shared/gitCommitMessage';
import type { SpawnModelConfig } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommitMessageDeps,
  createCommitMessageGenerator,
  GIT_COMMIT_PROMPT_FILE,
  readGitCommitPrompt,
  resetGitCommitPrompt,
  writeGitCommitPrompt,
} from './gitCommitMessage';

const config = { settingsProviderId: 'p', modelId: 'm' } as SpawnModelConfig;
const request = { conversationId: 'c', projectId: 'p', requestId: 'r1' };

function deps(overrides: Partial<CommitMessageDeps> = {}): CommitMessageDeps {
  return {
    settingsState: () => ({ gitCommitModel: { providerId: 'p', modelId: 'm' } }),
    resolveModel: vi.fn(async () => ({ ok: true as const, config })),
    readDiffs: vi.fn(async () => ({
      staged: 'diff --git staged',
      unstaged: 'diff --git unstaged',
    })),
    readPrompt: () => 'SYSTEM',
    complete: vi.fn(async () => '```\nfeat: add x\n```'),
    ...overrides,
  };
}

describe('createCommitMessageGenerator', () => {
  it('坏入参拒绝，且不读 git、不调模型', async () => {
    const d = deps();
    const generator = createCommitMessageGenerator(d);
    for (const bad of [null, {}, { ...request, requestId: 1 }, { ...request, projectId: '' }]) {
      expect(await generator.generate(bad)).toMatchObject({ ok: false, code: 'invalid-request' });
    }
    expect(generator.abort({ requestId: 5 })).toMatchObject({ ok: false });
    expect(d.readDiffs).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it('未配置供应商 / 模型时不读 git、不调模型', async () => {
    for (const [state, missing] of [
      [{}, 'provider'],
      [{ gitCommitModel: null }, 'provider'],
      [{ gitCommitModel: { providerId: 'p', modelId: '' } }, 'model'],
    ] as const) {
      const d = deps({ settingsState: () => state });
      expect(await createCommitMessageGenerator(d).generate(request)).toMatchObject({
        ok: false,
        code: 'not-configured',
        missing,
      });
      expect(d.resolveModel).not.toHaveBeenCalled();
      expect(d.complete).not.toHaveBeenCalled();
    }
  });

  it('敏感文件只给文件名，内容不发给模型', async () => {
    const d = deps({
      readDiffs: async () => ({
        staged: [
          'diff --git a/.env b/.env',
          '--- a/.env',
          '+++ b/.env',
          '@@ -1 +1 @@',
          '+API_KEY=sk-live-secret',
          'diff --git a/src/a.ts b/src/a.ts',
          '+export const a = 1;',
          '',
        ].join('\n'),
        unstaged: '',
      }),
    });
    await createCommitMessageGenerator(d).generate(request);
    const sent = vi.mocked(d.complete).mock.calls[0][0].userText;
    expect(sent).toContain('diff --git a/.env b/.env');
    expect(sent).not.toContain('sk-live-secret');
    expect(sent).toContain('+export const a = 1;');
  });

  it('模型解析失败按缺失类型回报，不调模型', async () => {
    const providerGone = deps({
      resolveModel: async () => ({ ok: false, error: 'Model provider is unavailable.' }),
    });
    expect(await createCommitMessageGenerator(providerGone).generate(request)).toMatchObject({
      code: 'not-configured',
      missing: 'provider',
    });
    const modelGone = deps({
      resolveModel: async () => ({ ok: false, error: 'Model is unavailable: model-missing' }),
    });
    expect(await createCommitMessageGenerator(modelGone).generate(request)).toMatchObject({
      code: 'not-configured',
      missing: 'model',
    });
    expect(providerGone.complete).not.toHaveBeenCalled();
    expect(modelGone.complete).not.toHaveBeenCalled();
  });

  it('staged 优先，system=提示词，user=diff，输出清洗后返回', async () => {
    const d = deps();
    const result = await createCommitMessageGenerator(d).generate(request);
    expect(result).toEqual({
      ok: true,
      message: 'feat: add x',
      source: 'staged',
      truncated: false,
    });
    expect(d.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'SYSTEM',
        userText: 'diff --git staged',
        candidates: [config],
      })
    );
  });

  it('staged 为空取 unstaged；都空报 no-changes 且不调模型', async () => {
    const unstaged = deps({ readDiffs: async () => ({ staged: '', unstaged: 'U' }) });
    expect(await createCommitMessageGenerator(unstaged).generate(request)).toMatchObject({
      ok: true,
      source: 'unstaged',
    });
    const empty = deps({ readDiffs: async () => ({ staged: '', unstaged: '' }) });
    expect(await createCommitMessageGenerator(empty).generate(request)).toMatchObject({
      ok: false,
      code: 'no-changes',
    });
    expect(empty.complete).not.toHaveBeenCalled();
  });

  it('超长 diff 截断后再发', async () => {
    const d = deps({ readDiffs: async () => ({ staged: 'x'.repeat(300_000), unstaged: '' }) });
    const result = await createCommitMessageGenerator(d).generate(request);
    expect(result).toMatchObject({ ok: true, truncated: true });
    const sent = vi.mocked(d.complete).mock.calls[0][0].userText;
    expect(sent.length).toBeLessThan(200_200);
    expect(sent).toContain('[diff truncated');
  });

  it('模型错误原样回报，空输出报 empty-output', async () => {
    const failing = deps({
      complete: async () => {
        throw new Error('401 invalid key');
      },
    });
    expect(await createCommitMessageGenerator(failing).generate(request)).toEqual({
      ok: false,
      code: 'model-error',
      error: '401 invalid key',
    });
    const blank = deps({ complete: async () => '```\n```' });
    expect(await createCommitMessageGenerator(blank).generate(request)).toMatchObject({
      code: 'empty-output',
    });
  });

  it('取消：signal 触发，结果为 aborted', async () => {
    const d = deps({
      complete: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ),
    });
    const generator = createCommitMessageGenerator(d);
    const pending = generator.generate(request);
    await vi.waitFor(() => expect(d.complete).toHaveBeenCalled());
    expect(generator.abort({ requestId: 'r1' })).toEqual({ ok: true });
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' });
    expect(generator.abort({ requestId: 'r1' })).toMatchObject({ ok: false });
  });

  it('读 diff 期间取消，不再调模型', async () => {
    let release: () => void = () => {};
    const d = deps({
      readDiffs: vi.fn(
        () =>
          new Promise<{ staged: string; unstaged: string }>((resolve) => {
            release = () => resolve({ staged: 'S', unstaged: '' });
          })
      ),
    });
    const generator = createCommitMessageGenerator(d);
    const pending = generator.generate(request);
    await vi.waitFor(() => expect(d.readDiffs).toHaveBeenCalled());
    generator.abort({ requestId: 'r1' });
    release();
    expect(await pending).toMatchObject({ code: 'aborted' });
    expect(d.complete).not.toHaveBeenCalled();
  });
});

describe('提示词文件', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'git-commit-prompt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('无文件 → 默认提示词，custom=false', () => {
    expect(readGitCommitPrompt(dir)).toEqual({ text: DEFAULT_GIT_COMMIT_PROMPT, custom: false });
  });

  it('写入独立文件，读回自定义；恢复默认即删除文件', () => {
    writeGitCommitPrompt(dir, 'my rules');
    expect(readFileSync(path.join(dir, GIT_COMMIT_PROMPT_FILE), 'utf8')).toBe('my rules');
    expect(readGitCommitPrompt(dir)).toEqual({ text: 'my rules', custom: true });
    resetGitCommitPrompt(dir);
    expect(readGitCommitPrompt(dir)).toEqual({ text: DEFAULT_GIT_COMMIT_PROMPT, custom: false });
    resetGitCommitPrompt(dir);
  });

  it('文件为空白 → 回退默认', () => {
    writeFileSync(path.join(dir, GIT_COMMIT_PROMPT_FILE), '  \n');
    expect(readGitCommitPrompt(dir).custom).toBe(false);
  });
});
