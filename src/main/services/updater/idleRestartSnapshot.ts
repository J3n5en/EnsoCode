import {
  countCatalogIdleBlocks,
  countPersistedQueuedMessages,
  mergeIdleRestartBlocks,
  persistedConversations,
  RECENT_INPUT_MS,
} from '@shared/updater/idleRestart';
import { agentSessionIndex } from '../../ipc/sessionIndex';
import { readSettings } from '../../ipc/settings';
import { anyUnsentDraft } from '../../ipc/unsentDrafts';
import { getPairCatalog } from '../pairHost';
import { headlessIdleBlocks, isPairHeadless } from '../pairSessionHost';
import { anyRendererFocused, userRecentlyActive } from '../renderers';
import type { IdleRestartObservation } from './idleRestartGate';

export function currentIdleRestartObservation(): IdleRestartObservation {
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
    agentBusy: agentSessionIndex.anyWorkspaceBusy(),
    windowFocused: anyRendererFocused(),
    userActive: userRecentlyActive(RECENT_INPUT_MS),
    unsentDraft: anyUnsentDraft(),
    ...blocks,
  };
}
