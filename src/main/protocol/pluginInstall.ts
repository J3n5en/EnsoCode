import {
  pluginInstallUrlFromLink,
  pluginInstallUrlsFromArgv,
} from '@shared/extensionPlugins/pluginProtocol';

/** macOS 走 open-url；Windows/Linux 走 argv。ready 之前先排队。 */
export function createPluginInstallInbox(platform: NodeJS.Platform) {
  const queued: string[] = [];
  let deliver: ((url: string) => void) | null = null;

  const push = (url: string | null) => {
    if (!url || queued.includes(url)) return;
    if (deliver) deliver(url);
    else queued.push(url);
  };

  return {
    noteLink(raw: string) {
      push(pluginInstallUrlFromLink(raw));
    },
    noteArgv(argv: readonly string[]) {
      if (platform === 'darwin') return;
      for (const url of pluginInstallUrlsFromArgv(argv)) push(url);
    },
    start(send: (url: string) => void) {
      deliver = send;
      const pending = queued.splice(0);
      for (const url of pending) send(url);
    },
  };
}
