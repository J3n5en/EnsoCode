import { ipcMain } from '@platform';
import { isDcgRuleId } from '@shared/dcgRuleMemory';
import type { DcgActionResult, DcgRuleExemption, DcgRuleState, DcgStatus } from '@shared/types/dcg';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  checkDcgUpdate,
  DCG_VERSION,
  dcgRoot,
  dcgStatus,
  installDcg,
  resolveInstalledDcg,
  uninstallDcg,
} from '../services/dcgBinary';
import {
  clearDcgRuleMemory,
  ensureDcgRuleMemoryReady,
  exemptDcgRule,
  listDcgExemptions,
  readDcgRuleState,
  recordDcgAllow,
  revokeDcgExemption,
} from '../services/dcgRuleMemory';
import { isMainRenderer } from '../services/renderers';

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const UNTRUSTED: DcgStatus = {
  supported: false,
  installed: false,
  installedVersion: null,
  version: DCG_VERSION,
};

const isTrusted = (id: number) => isMainRenderer(id);

let installing: Promise<DcgActionResult> | null = null;

/** 豁免记忆按实际生效的二进制版本分组：升级 dcg 后旧版本豁免自然失效、重新询问 */
const activeVersion = (): string => resolveInstalledDcg(dcgRoot())?.version ?? DCG_VERSION;

const ruleHandler =
  (action: typeof readDcgRuleState) =>
  async (event: { sender: { id: number } }, ruleId: unknown): Promise<DcgRuleState | null> => {
    if (!isTrusted(event.sender.id) || !isDcgRuleId(ruleId)) return null;
    try {
      return await action(dcgRoot(), ruleId, activeVersion());
    } catch {
      return null;
    }
  };

export function registerDcgHandlers(): void {
  void ensureDcgRuleMemoryReady(dcgRoot());

  ipcMain.handle(IPC_CHANNELS.DCG_STATUS, (event) =>
    isTrusted(event.sender.id) ? dcgStatus(dcgRoot()) : UNTRUSTED
  );

  // 只在用户点击「检查更新」时调用，不在启动或页面加载时自动请求
  ipcMain.handle(IPC_CHANNELS.DCG_CHECK_UPDATE, (event) =>
    isTrusted(event.sender.id)
      ? checkDcgUpdate()
      : { status: 'failed', current: DCG_VERSION, reason: 'network' }
  );

  ipcMain.handle(IPC_CHANNELS.DCG_RULE_STATE, ruleHandler(readDcgRuleState));
  ipcMain.handle(IPC_CHANNELS.DCG_RULE_ALLOWED, ruleHandler(recordDcgAllow));
  ipcMain.handle(IPC_CHANNELS.DCG_RULE_EXEMPT, ruleHandler(exemptDcgRule));
  ipcMain.handle(
    IPC_CHANNELS.DCG_RULE_REVOKE,
    async (event, ruleId: unknown): Promise<DcgRuleExemption[] | null> => {
      if (!isTrusted(event.sender.id) || !isDcgRuleId(ruleId)) return null;
      try {
        return await revokeDcgExemption(dcgRoot(), ruleId, activeVersion());
      } catch {
        return null;
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.DCG_EXEMPTIONS_LIST, async (event): Promise<DcgRuleExemption[]> => {
    if (!isTrusted(event.sender.id)) return [];
    try {
      return await listDcgExemptions(dcgRoot(), activeVersion());
    } catch {
      return [];
    }
  });
  ipcMain.handle(IPC_CHANNELS.DCG_EXEMPTIONS_CLEAR, async (event) => {
    if (!isTrusted(event.sender.id)) return false;
    try {
      await clearDcgRuleMemory(dcgRoot());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.DCG_INSTALL, (event): Promise<DcgActionResult> => {
    if (!isTrusted(event.sender.id)) return Promise.resolve({ ok: false, status: UNTRUSTED });
    installing ??= installDcg({ root: dcgRoot() })
      .then(() => ({ ok: true, status: dcgStatus(dcgRoot()) }))
      .catch((error: unknown) => ({
        ok: false,
        status: dcgStatus(dcgRoot()),
        error: toErrorMessage(error),
      }))
      .finally(() => {
        installing = null;
      });
    return installing;
  });

  ipcMain.handle(IPC_CHANNELS.DCG_UNINSTALL, async (event): Promise<DcgActionResult> => {
    if (!isTrusted(event.sender.id) || installing)
      return { ok: false, status: dcgStatus(dcgRoot()) };
    try {
      await uninstallDcg(dcgRoot());
      return { ok: true, status: dcgStatus(dcgRoot()) };
    } catch (error) {
      return { ok: false, status: dcgStatus(dcgRoot()), error: toErrorMessage(error) };
    }
  });
}
