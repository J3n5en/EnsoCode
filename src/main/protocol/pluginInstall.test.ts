import { describe, expect, it, vi } from 'vitest';
import { createPluginInstallInbox } from './pluginInstall';

const LINK = `enso://install-plugin?url=${encodeURIComponent('https://github.com/acme/demo')}`;

describe('createPluginInstallInbox', () => {
  it('ready 前的链接在 start 时一次性交出，之后直接交付', () => {
    const inbox = createPluginInstallInbox('darwin');
    inbox.noteLink(LINK);
    inbox.noteLink('enso://pair?relay=x&pk=y');
    inbox.noteLink(LINK);
    const send = vi.fn();
    inbox.start(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('https://github.com/acme/demo');
    inbox.noteLink(LINK);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('macOS 不从 argv 取链接，Windows 取', () => {
    const mac = createPluginInstallInbox('darwin');
    mac.noteArgv([LINK]);
    const send = vi.fn();
    mac.start(send);
    expect(send).not.toHaveBeenCalled();

    const win = createPluginInstallInbox('win32');
    win.noteArgv([LINK, '--something']);
    win.start(send);
    expect(send).toHaveBeenCalledWith('https://github.com/acme/demo');
  });
});
