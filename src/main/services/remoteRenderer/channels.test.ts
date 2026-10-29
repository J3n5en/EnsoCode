import { IPC_CHANNELS } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { isRemoteChannelAllowed } from './channels';

describe('isRemoteChannelAllowed', () => {
  it('allows ordinary workspace channels', () => {
    for (const ch of [
      IPC_CHANNELS.AGENT_PROMPT,
      IPC_CHANNELS.SETTINGS_READ,
      IPC_CHANNELS.SETTINGS_WRITE_KEY,
      IPC_CHANNELS.FILES_READ,
      IPC_CHANNELS.TERMINAL_CREATE,
    ]) {
      expect(isRemoteChannelAllowed(ch, false)).toBe(true);
    }
  });

  it('denies host-native and host-desktop side effects', () => {
    for (const ch of [
      IPC_CHANNELS.WINDOW_OPEN_SETTINGS,
      IPC_CHANNELS.DIALOG_SELECT_DIRECTORY,
      IPC_CHANNELS.FILES_REVEAL,
      IPC_CHANNELS.FILES_REVEAL_EXTERNAL,
      IPC_CHANNELS.FILES_COPY_PATH,
      IPC_CHANNELS.PAIR_REVOKE,
      IPC_CHANNELS.PAIR_START,
      IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION,
      'computer:anything',
      'browser:navigate',
      'updater:check',
    ]) {
      expect(isRemoteChannelAllowed(ch, true)).toBe(false);
    }
  });

  it('lets only the leader push the pair catalog', () => {
    expect(isRemoteChannelAllowed(IPC_CHANNELS.PAIR_CATALOG, false)).toBe(false);
    expect(isRemoteChannelAllowed(IPC_CHANNELS.PAIR_CATALOG, true)).toBe(true);
  });

  it('opens host update/restart only when the host allows remote control', () => {
    for (const ch of [
      IPC_CHANNELS.UPDATER_GET_STATE,
      IPC_CHANNELS.UPDATER_CHECK,
      IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL,
      IPC_CHANNELS.UPDATER_RESTART,
    ]) {
      expect(isRemoteChannelAllowed(ch, true)).toBe(false);
      expect(isRemoteChannelAllowed(ch, false, true)).toBe(true);
    }
    expect(isRemoteChannelAllowed(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, true, true)).toBe(false);
  });
});
