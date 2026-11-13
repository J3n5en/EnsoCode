import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
  settings: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('./settings', () => ({ readSettings: () => mocks.settings }));
vi.mock('../services/agentHost', () => ({
  agentDataDir: () => mocks.userData,
  customWorkflowPresetDir: () => mocks.userData,
  menuPluginSkillPaths: () => [],
  readSettingsState: () => undefined,
}));

import { registerAssetHandlers } from './assets';

// 审计 J5b：INSTRUCTIONS_READ 在 local=false 时直接读请求里的 sourcePath（写回源文件却要登记校验），
// 渲染层/远端传任意路径即可读出任意文件。现在只认 id，读取位置由 Main 按设置里登记的条目推导。
describe('INSTRUCTIONS_READ 只认已登记条目', () => {
  const id = '4aade2cb-d2a1-47c3-a4a2-848f28571a97';
  let tmp: string;
  let source: string;
  let secret: string;
  const read = (...args: unknown[]) =>
    mocks.handlers.get(IPC_CHANNELS.INSTRUCTIONS_READ)?.({}, ...args);
  const register = (entry: Record<string, unknown>) => {
    mocks.settings = { 'enso-settings': { state: { instructions: [entry] } } };
  };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-instructions-'));
    mocks.userData = path.join(tmp, 'userData');
    source = path.join(tmp, 'CLAUDE.md');
    secret = path.join(tmp, 'settings.json');
    writeFileSync(source, '# 指令');
    writeFileSync(secret, '{"apiKey":"sk-secret"}');
    mocks.settings = null;
    mocks.handlers.clear();
    registerAssetHandlers();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('未登记的 id 不读盘，请求带来的源文件路径不被采信', () => {
    expect(read(id, false, secret)).toMatchObject({ ok: false, content: '' });
  });

  it('已登记条目按登记的源文件读取，请求里换成别的路径也不被采信', () => {
    register({ id, sourcePath: source, local: false });
    expect(read(id, false, secret)).toEqual({ ok: true, content: '# 指令' });
  });

  it('已复制为本地副本的条目按 id 推导副本路径，不看请求里的 local 标记', () => {
    register({ id, sourcePath: source, local: true });
    mkdirSync(path.join(mocks.userData, 'instructions'), { recursive: true });
    writeFileSync(path.join(mocks.userData, 'instructions', `${id}.md`), '# 本地副本');
    expect(read(id, false, secret)).toEqual({ ok: true, content: '# 本地副本' });
  });

  it('非 uuid 的 id 不读盘（防路径穿越）', () => {
    register({ id: '../../settings', local: true });
    expect(read('../../settings', true)).toMatchObject({ ok: false, content: '' });
  });
});
