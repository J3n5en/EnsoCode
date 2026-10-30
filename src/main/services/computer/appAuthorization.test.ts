import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppAuthorizer,
  type AppPromptAnswer,
  appIdentityKey,
  normalizeAppIdentity,
  readAllowedApps,
} from './appAuthorization';

const textEdit = {
  bundleId: 'com.apple.TextEdit',
  name: 'TextEdit',
  path: '/System/Applications/TextEdit.app',
};

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'enso-apps-')), 'apps.json');
}

function authorizer(file: string, answers: AppPromptAnswer[]) {
  const prompts: string[] = [];
  const auth = new AppAuthorizer({
    file,
    prompt: async (app) => {
      prompts.push(app.name);
      return answers.shift() ?? 'deny';
    },
    now: () => 1000,
  });
  return { auth, prompts };
}

describe('normalizeAppIdentity', () => {
  it('接受规范 .app 绝对路径与反向域名 bundle id', () => {
    expect(normalizeAppIdentity(textEdit)).toEqual(textEdit);
  });

  it('拒绝相对路径、.. 片段、非 .app 路径和脏 bundle id', () => {
    expect(normalizeAppIdentity({ ...textEdit, path: 'Applications/TextEdit.app' })).toBeNull();
    expect(normalizeAppIdentity({ ...textEdit, path: '/Applications/../tmp/x.app' })).toBeNull();
    expect(normalizeAppIdentity({ ...textEdit, path: '/usr/bin/python3' })).toBeNull();
    expect(normalizeAppIdentity({ ...textEdit, bundleId: 'bad id;rm' })).toBeNull();
    expect(normalizeAppIdentity(null)).toBeNull();
    expect(normalizeAppIdentity('TextEdit')).toBeNull();
  });

  it('没有 bundle id 时允许空串，以路径作身份', () => {
    const bare = { bundleId: '', name: 'Tool', path: '/Applications/Tool.app' };
    expect(normalizeAppIdentity(bare)).toEqual(bare);
    expect(appIdentityKey(bare)).toBe('/Applications/Tool.app');
    expect(appIdentityKey(textEdit)).toBe('com.apple.TextEdit');
  });
});

describe('readAllowedApps', () => {
  it('文件不存在或损坏返回空表，脏条目丢弃', () => {
    const file = tempFile();
    expect(readAllowedApps(file)).toEqual([]);
    writeFileSync(file, '{oops');
    expect(readAllowedApps(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        apps: [{ ...textEdit, grantedAt: 5 }, { bundleId: 'x y', path: 'rel', name: 1 }, 'junk'],
      })
    );
    expect(readAllowedApps(file)).toEqual([{ ...textEdit, grantedAt: 5 }]);
  });
});

describe('AppAuthorizer', () => {
  it('始终允许：写入名单，之后不再询问（跨 session）', async () => {
    const file = tempFile();
    const { auth, prompts } = authorizer(file, ['always']);
    await auth.authorize('s1', textEdit);
    await auth.authorize('s2', textEdit);
    expect(prompts).toEqual(['TextEdit']);
    expect(readAllowedApps(file)).toEqual([{ ...textEdit, grantedAt: 1000, lastUsedAt: 1000 }]);
  });

  it('名单只落身份元数据，不带 pid 等运行期字段', async () => {
    const file = tempFile();
    const { auth } = authorizer(file, ['always']);
    await auth.authorize('s1', { ...textEdit, pid: 42 } as typeof textEdit);
    expect(JSON.parse(readFileSync(file, 'utf8')).apps).toEqual([
      { ...textEdit, grantedAt: 1000, lastUsedAt: 1000 },
    ]);
  });

  it('仅本次：同 session 不再问，别的 session 再问，不落盘', async () => {
    const file = tempFile();
    const { auth, prompts } = authorizer(file, ['once', 'once']);
    await auth.authorize('s1', textEdit);
    await auth.authorize('s1', textEdit);
    await auth.authorize('s2', textEdit);
    expect(prompts).toEqual(['TextEdit', 'TextEdit']);
    expect(readAllowedApps(file)).toEqual([]);
  });

  it('拒绝：本 session 记住拒绝，直接报 app-denied 不重复弹窗', async () => {
    const { auth, prompts } = authorizer(tempFile(), ['deny']);
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({ code: 'app-denied' });
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({ code: 'app-denied' });
    expect(prompts).toEqual(['TextEdit']);
    auth.forgetSession('s1');
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({ code: 'app-denied' });
    expect(prompts).toEqual(['TextEdit', 'TextEdit']);
  });

  it('同 app 并发申请只弹一次窗', async () => {
    const { auth, prompts } = authorizer(tempFile(), ['once']);
    await Promise.all([auth.authorize('s1', textEdit), auth.authorize('s1', textEdit)]);
    expect(prompts).toEqual(['TextEdit']);
  });

  it('同 bundle id 换了路径（被替换的 app）重新询问', async () => {
    const file = tempFile();
    const { auth, prompts } = authorizer(file, ['always', 'deny']);
    await auth.authorize('s1', textEdit);
    await expect(
      auth.authorize('s1', { ...textEdit, path: '/Users/x/Downloads/TextEdit.app' })
    ).rejects.toMatchObject({ code: 'app-denied' });
    expect(prompts).toHaveLength(2);
  });

  it('撤销后再次询问；名单可列出', async () => {
    const file = tempFile();
    const { auth, prompts } = authorizer(file, ['always', 'once']);
    await auth.authorize('s1', textEdit);
    expect(auth.list().map((app) => app.bundleId)).toEqual(['com.apple.TextEdit']);
    expect(auth.revoke('com.apple.TextEdit')).toBe(true);
    expect(auth.revoke('com.apple.TextEdit')).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).apps).toEqual([]);
    await auth.authorize('s2', textEdit);
    expect(prompts).toHaveLength(2);
  });

  it('撤销也清掉各 session 的「仅本次」授权', async () => {
    const { auth, prompts } = authorizer(tempFile(), ['once', 'deny']);
    await auth.authorize('s1', textEdit);
    auth.revoke('com.apple.TextEdit');
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({ code: 'app-denied' });
    expect(prompts).toHaveLength(2);
  });

  it('超时未答或 run 中止：报 app-prompt-dismissed，不记为拒绝，下次仍询问', async () => {
    const seen: AbortSignal[] = [];
    let calls = 0;
    const auth = new AppAuthorizer({
      file: tempFile(),
      promptTimeoutMs: 20,
      prompt: (_app, signal) => {
        seen.push(signal);
        calls += 1;
        if (calls > 1) return Promise.resolve('once');
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve('deny'), { once: true })
        );
      },
    });
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({
      code: 'app-prompt-dismissed',
    });
    expect(seen[0]?.aborted).toBe(true);
    await expect(auth.authorize('s1', textEdit)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('调用方中止时关闭提示', async () => {
    const controller = new AbortController();
    const auth = new AppAuthorizer({
      file: tempFile(),
      prompt: (_app, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve('dismissed'), { once: true })
        ),
    });
    const pending = auth.authorize('s1', textEdit, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'app-prompt-dismissed' });
  });

  it('提示框异常按拒绝处理', async () => {
    const auth = new AppAuthorizer({
      file: tempFile(),
      prompt: async () => {
        throw new Error('no ui');
      },
    });
    await expect(auth.authorize('s1', textEdit)).rejects.toMatchObject({ code: 'app-denied' });
  });
});
