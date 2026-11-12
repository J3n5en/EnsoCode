import { decodeRemoteValue, type HostToRemote } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scanStorage: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock('../services/resourceMonitor', () => ({
  cancelStorageScan: vi.fn(),
  cleanStorage: vi.fn(),
  lastStorageSnapshot: vi.fn(() => null),
  sampleResources: vi.fn(),
  scanStorage: mocks.scanStorage,
}));

import { IPC_CHANNELS } from '@shared/types';
import { addRemoteSender, RemoteSender } from '../services/remoteRenderer/senders';
import { registerResourceHandlers } from './resources';

const pages: RemoteSender[] = [];

/** 一个已配对的远程浏览器页面；frames 是经配对通道送到它那边的帧 */
function remotePage(cid: string, kind: 'main' | 'settings') {
  const frames: HostToRemote[] = [];
  const sender = new RemoteSender('pair-1', cid, kind, (frame) => frames.push(frame));
  addRemoteSender(sender);
  pages.push(sender);
  return { sender, frames };
}

const cleanRequests = (frames: HostToRemote[]) =>
  frames.flatMap((frame) =>
    frame.type === 'rpc-event' && frame.ch === IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN_REQUEST
      ? decodeRemoteValue<{ requestId: string; request: unknown }[]>(frame.args)
      : []
  );

const invoke = (sender: RemoteSender, channel: string, ...args: unknown[]) =>
  Promise.resolve(mocks.handlers.get(channel)?.({ sender }, ...args));

describe('按会话清理', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.scanStorage.mockReset();
    registerResourceHandlers();
  });

  afterEach(() => {
    for (const page of pages.splice(0)) page.destroy();
  });

  // 背景：服务端没有本地主窗口（localMainContents 恒为 null），原实现直接抛 Main window is not open
  it('服务端没有本地主窗口：交给远端主界面 leader 执行并等它回报', async () => {
    const leader = remotePage('cid-leader', 'main');
    const follower = remotePage('cid-follower', 'main');
    const settings = remotePage('cid-settings', 'settings');
    const snapshot = { roots: [], categories: [] };
    mocks.scanStorage.mockResolvedValue(snapshot);

    const settled = invoke(settings.sender, IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN, {
      kind: 'one',
      id: 'conv-1',
    }).then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message })
    );
    const [delivered] = cleanRequests(leader.frames);

    expect(delivered?.request).toEqual({ kind: 'one', id: 'conv-1' });
    // 只交给 leader 一个页面，避免多个远端主界面重复删除
    expect(cleanRequests(follower.frames)).toHaveLength(0);
    await invoke(
      leader.sender,
      IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN_DONE,
      delivered?.requestId,
      2
    );
    await expect(settled).resolves.toEqual({ value: { removed: 2, snapshot } });
  });
});
