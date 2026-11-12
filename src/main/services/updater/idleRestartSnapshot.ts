import {
  countCatalogIdleBlocks,
  countPersistedQueuedMessages,
  mergeIdleRestartBlocks,
  persistedConversations,
} from '@shared/updater/idleRestart';
import { agentSessionIndex } from '../../ipc/sessionIndex';
import { readSettings } from '../../ipc/settings';
import { getPairCatalog } from '../pairHost';
import { headlessIdleBlocks, isPairHeadless } from '../pairSessionHost';
import { anyRendererFocused } from '../renderers';
import type { IdleRestartObservation } from './idleRestartGate';

export function currentIdleRestartObservation(
  enabled: boolean,
  downloaded: boolean
): IdleRestartObservation {
  const catalog = countCatalogIdleBlocks(getPairCatalog());
  const headless = isPairHeadless()
    ? headlessIdleBlocks()
    : { queuedCount: 0, pendingAskCount: 0, pendingApprovalCount: 0 };
  const persistedQueued = countPersistedQueuedMessages(persistedConversations(readSettings()));
  const blocks = mergeIdleRestartBlocks(
    { queuedCount: persistedQueued, pendingAskCount: 0, pendingApprovalCount: 0 },
    catalog,
    headless
  );
  return {
    enabled,
    downloaded,
    agentBusy: agentSessionIndex.anyWorkspaceBusy(),
    windowFocused: anyRendererFocused(),
    ...blocks,
  };
}
