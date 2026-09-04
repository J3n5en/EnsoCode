import type { PhoneToHost } from '@enso/pair';
import { useMemo, useState } from 'react';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { emptyNodeView } from '@/stores/remoteNodes/reducer';
import { NewRemoteSessionDialog } from './NewRemoteSessionDialog';
import { RemoteNodeChat } from './RemoteNodeChat';
import { RemoteNodeSidebar } from './RemoteNodeSidebar';

interface RemoteNodeViewProps {
  nodeId: string;
  sidebarWidth: number | undefined;
}

/** 切到远程节点后整块内容区：对方目录侧栏 + 对方会话聊天区 */
export function RemoteNodeView({ nodeId, sidebarWidth }: RemoteNodeViewProps) {
  const node = useRemoteNodesStore((s) => s.nodes.find((n) => n.nodeId === nodeId));
  const view = useRemoteNodesStore((s) => s.byNode[nodeId]) ?? EMPTY;
  const selectSession = useRemoteNodesStore((s) => s.selectSession);
  const send = useRemoteNodesStore((s) => s.send);
  const requestHistory = useRemoteNodesStore((s) => s.requestHistory);
  const spawn = useRemoteNodesStore((s) => s.spawn);
  const [composing, setComposing] = useState(false);

  const activeId = view.activeSessionId;
  const entry = useMemo(
    () => view.catalog.find((c) => c.id === activeId),
    [view.catalog, activeId]
  );
  // coworker tab 组：当前会话是子会话则归组到其父，否则以自身为父；无 coworker 时不显示
  const tabGroup = useMemo(() => {
    if (!entry) return undefined;
    const parent = entry.parentId ? view.catalog.find((c) => c.id === entry.parentId) : entry;
    if (!parent) return undefined;
    const children = view.catalog.filter((c) => c.parentId === parent.id);
    return children.length > 0 ? { parent, children } : undefined;
  }, [view.catalog, entry]);
  const session = activeId ? (view.sessions[activeId] ?? null) : null;
  const hasOlder = Boolean(
    session && session.messages.size > 0 && Math.min(...session.messages.keys()) > 0
  );

  if (!node) return null;

  const to = (command: PhoneToHost) => send(nodeId, command);

  return (
    <>
      <RemoteNodeSidebar
        width={sidebarWidth}
        node={node}
        catalog={view.catalog}
        pinnedOrder={view.pinnedOrder}
        projects={view.projects}
        activeId={activeId}
        canCreate={node.hostOnline && view.projects.length > 0}
        onSelect={(id) => selectSession(nodeId, id)}
        onNewConversation={() => setComposing(true)}
      />
      <RemoteNodeChat
        node={node}
        sessionId={activeId}
        entry={entry}
        tabGroup={tabGroup}
        view={session}
        syncing={view.sync.state === 'syncing'}
        providers={view.providers}
        hasOlder={hasOlder}
        onLoadOlder={() => activeId && requestHistory(nodeId, activeId)}
        onSelectTab={(id) => selectSession(nodeId, id)}
        onSend={(text, images) => {
          if (!activeId) return;
          to({
            type: session?.status === 'running' ? 'steer' : 'prompt',
            sessionId: activeId,
            text,
            ...(images.length ? { images } : {}),
          });
        }}
        onAbort={() => activeId && to({ type: 'abort', sessionId: activeId })}
        onApproval={(requestId, decision) =>
          activeId && to({ type: 'approval-respond', sessionId: activeId, requestId, decision })
        }
        onAsk={(requestId, answer) =>
          activeId && to({ type: 'ask-respond', sessionId: activeId, requestId, answer })
        }
        onSetModel={(providerId, modelId) =>
          activeId && to({ type: 'set-model', sessionId: activeId, providerId, modelId })
        }
        onSetReasoning={(enabled) =>
          activeId && to({ type: 'set-reasoning', sessionId: activeId, enabled })
        }
        onSetThinking={(level) =>
          activeId && to({ type: 'set-thinking', sessionId: activeId, level })
        }
      />
      <NewRemoteSessionDialog
        open={composing}
        onOpenChange={setComposing}
        projects={view.projects}
        providers={view.providers}
        onCreate={(req) => spawn(nodeId, req)}
      />
    </>
  );
}

const EMPTY = emptyNodeView();
