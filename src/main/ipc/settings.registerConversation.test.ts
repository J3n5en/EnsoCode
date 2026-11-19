import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-register-conversation-'));
const mocks = vi.hoisted(() => {
  const desktopSend = vi.fn();
  const desktop = { id: 1, isDestroyed: () => false, send: desktopSend };
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    desktop,
    desktopSend,
    windows: [{ isDestroyed: () => false, webContents: desktop }],
    authority: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock('./bots', () => ({ syncBotModeServices: vi.fn(), syncBotDiscussMode: vi.fn() }));
vi.mock('../services/modelDirectory', () => ({ notifyModelDirectorySettingsChanged: () => {} }));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({ conversation: (id: string) => mocks.authority.get(id) }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../services/uiHost', async () =>
  (await import('../../../test/helpers/localUi')).mockUiHost(() => mocks.windows, {
    mainContents: () => mocks.desktop as never,
  })
);

afterAll(async () => {
  (await import('./settings')).flushSettings();
  rmSync(userData, { recursive: true, force: true });
});

const PROJECT = 'project-a';
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: PROJECT,
  title: '',
  createdAt: 1,
  lastActiveAt: 1,
  approvalMode: 'full',
  messages: [],
  ...extra,
});

async function setup() {
  const settings = await import('./settings');
  const { addRemoteSender, RemoteSender } = await import('../services/remoteRenderer/senders');
  settings.registerSettingsHandlers();
  const register = mocks.handlers.get(IPC_CHANNELS.CONVERSATIONS_REGISTER);
  if (!register) throw new Error('conversations:register handler missing');
  const frames: unknown[] = [];
  const phone = new RemoteSender('pair', crypto.randomUUID(), 'main', (frame) =>
    frames.push(frame)
  );
  addRemoteSender(phone);
  const patchesTo = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls.filter((call) => call[0] === IPC_CHANNELS.CONVERSATIONS_PATCH);
  return { settings, register, phone, frames, patchesTo };
}

describe('conversations:register', () => {
  beforeEach(async () => {
    mocks.authority.clear();
    mocks.desktopSend.mockClear();
    const settings = await import('./settings');
    settings.patchConversationsState((state) => {
      for (const id of Object.keys(state.conversations)) delete state.conversations[id];
      state.conversations.old = row('old', { title: '桌面已有' });
      state.order = ['old'];
    });
    mocks.desktopSend.mockClear();
  });

  it('PWA 新建的根会话写进主机会话表、落盘，并推补丁给桌面；已有会话不动', async () => {
    const { settings, register, phone, frames, patchesTo } = await setup();
    mocks.authority.set('fresh', { conversationId: 'fresh', projectId: PROJECT, kind: 'root' });

    await expect(register({ sender: phone }, row('fresh'))).resolves.toBe(true);

    const persisted = settings.readPersistedConversations();
    expect(persisted.fresh).toMatchObject({
      id: 'fresh',
      projectId: PROJECT,
      approvalMode: 'full',
    });
    expect(persisted.old).toMatchObject({ title: '桌面已有' });
    settings.flushSettings();
    const disk = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))[
      'enso-conversations'
    ].state;
    expect(Object.keys(disk.conversations).sort()).toEqual(['fresh', 'old']);
    expect(disk.order).toEqual(['fresh', 'old']);

    const [[, patch]] = patchesTo(mocks.desktopSend);
    expect(patch).toMatchObject({
      upserts: { fresh: { set: { id: 'fresh', projectId: PROJECT } } },
      removes: [],
    });
    // 发起方自己已有这条，不回推给它
    expect(frames).toEqual([]);
  });

  it('已登记的会话不被覆盖，重复登记幂等', async () => {
    const { settings, register, phone, patchesTo } = await setup();
    mocks.authority.set('old', { conversationId: 'old', projectId: PROJECT, kind: 'root' });

    await expect(register({ sender: phone }, row('old', { title: '手机旧值' }))).resolves.toBe(
      true
    );
    expect(settings.readPersistedConversations().old).toMatchObject({ title: '桌面已有' });
    expect(patchesTo(mocks.desktopSend)).toEqual([]);
  });

  it('没有根权威、项目对不上、子会话、非主界面一律拒收', async () => {
    const { settings, register, phone } = await setup();
    mocks.authority.set('other', { conversationId: 'other', projectId: 'project-b', kind: 'root' });
    mocks.authority.set('child', { conversationId: 'child', projectId: PROJECT, kind: 'child' });
    mocks.authority.set('ended', {
      conversationId: 'ended',
      projectId: PROJECT,
      kind: 'root',
      lifecycle: 'ended',
    });
    mocks.authority.set('ok', { conversationId: 'ok', projectId: PROJECT, kind: 'root' });

    await expect(register({ sender: phone }, row('ghost'))).resolves.toBe(false);
    await expect(register({ sender: phone }, row('other'))).resolves.toBe(false);
    await expect(register({ sender: phone }, row('child'))).resolves.toBe(false);
    await expect(register({ sender: phone }, row('ended'))).resolves.toBe(false);
    await expect(register({ sender: phone }, 'oops')).resolves.toBe(false);
    await expect(register({ sender: { id: 999 } }, row('ok'))).resolves.toBe(false);
    expect(Object.keys(settings.readPersistedConversations())).toEqual(['old']);
  });
});
