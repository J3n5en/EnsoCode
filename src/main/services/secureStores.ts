import { getMcpOAuthStore } from './mcpOAuthStore';
import { nodesReady } from './nodeStore';
import { devicesReady } from './pairStore';
import { pushStoreReady } from './pushNotifier';
import { getSshConnectionStore } from './sshConnectionStore';

/** 凭据存储异步解密进内存；读写它们的 IPC 与服务须在此之后启动 */
export async function readySecureStores(): Promise<void> {
  await Promise.all([
    devicesReady(),
    nodesReady(),
    pushStoreReady(),
    getMcpOAuthStore().ready(),
    getSshConnectionStore().ready(),
  ]);
}
