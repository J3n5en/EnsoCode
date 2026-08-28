import {
  type CatalogEntry,
  type ProjectEntry,
  type ProviderEntry,
  revokePairing,
} from '@enso/pair';
import { Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChatScreen } from './ChatScreen';
import { type ConnState, PairClient, type SessionView } from './client';
import { NewSessionSheet } from './NewSessionSheet';
import { PairScreen } from './PairScreen';
import { SessionDrawer } from './SessionDrawer';
import { clearPairing, loadPairing, savePairing } from './storage';

const STATE_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '已连接',
  'host-offline': '桌面端离线',
  unauthorized: '配对已失效',
  offline: '重连中…',
};

const LAST_SESSION_KEY = 'enso-phone-last-session';

export function App() {
  const [device, setDevice] = useState(loadPairing);
  const [state, setState] = useState<ConnState>('connecting');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(LAST_SESSION_KEY)
  );
  const [view, setView] = useState<SessionView | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const clientRef = useRef<PairClient | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!device) return;
    const client = new PairClient(device, {
      onState: setState,
      onCatalog: setCatalog,
      onProjects: setProjects,
      onProviders: setProviders,
      onSession: (id, next) => {
        setView((prev) => (id === activeIdRef.current ? next : prev));
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [device]);

  useEffect(() => {
    activeIdRef.current = activeId;
    clientRef.current?.subscribe(activeId);
    setView(activeId ? (clientRef.current?.getSession(activeId) ?? null) : null);
    if (activeId) localStorage.setItem(LAST_SESSION_KEY, activeId);
    else localStorage.removeItem(LAST_SESSION_KEY);
  }, [activeId]);

  // 首次连上且没有选中会话时，落到最近一条
  const firstId = catalog.find((c) => !c.parentId)?.id;
  useEffect(() => {
    if (!activeId && firstId) setActiveId(firstId);
  }, [activeId, firstId]);

  const entry = useMemo(() => catalog.find((c) => c.id === activeId), [catalog, activeId]);

  if (!device) {
    return (
      <PairScreen
        onPaired={(d) => {
          savePairing(d);
          setDevice(d);
        }}
      />
    );
  }

  if (state === 'unauthorized') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone className="h-8 w-8 text-muted-foreground" />
        <h1 className="font-medium text-lg">配对已失效</h1>
        <p className="text-muted-foreground text-sm">桌面端已解绑此设备，请重新扫码配对。</p>
        <Button
          onClick={() => {
            clearPairing();
            setDevice(null);
          }}
        >
          重新配对
        </Button>
      </div>
    );
  }

  const send = (command: Parameters<PairClient['send']>[0]) => clientRef.current?.send(command);

  return (
    <>
      <ChatScreen
        sessionId={activeId}
        title={entry?.title || (activeId ? '会话' : 'EnsoCode')}
        projectName={entry?.projectName ?? ''}
        view={view}
        connState={state}
        stateLabel={STATE_LABEL[state]}
        onOpenDrawer={() => setDrawerOpen(true)}
        onNewSession={() => setComposing(true)}
        canCreate={state === 'online' && projects.length > 0}
        onSend={(text, images) => {
          if (!activeId) return;
          send({
            type: view?.status === 'running' ? 'steer' : 'prompt',
            sessionId: activeId,
            text,
            ...(images.length ? { images } : {}),
          });
        }}
        onAbort={() => activeId && send({ type: 'abort', sessionId: activeId })}
        onApproval={(requestId, decision) =>
          activeId && send({ type: 'approval-respond', sessionId: activeId, requestId, decision })
        }
        onAsk={(requestId, answer) =>
          activeId && send({ type: 'ask-respond', sessionId: activeId, requestId, answer })
        }
      />

      <SessionDrawer
        open={drawerOpen}
        projects={projects}
        catalog={catalog}
        activeId={activeId}
        canCreate={state === 'online'}
        deviceName={device.deviceName}
        connected={state === 'online'}
        connectionLabel={STATE_LABEL[state]}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id) => {
          setActiveId(id);
          setDrawerOpen(false);
        }}
        onNewConversation={() => {
          setDrawerOpen(false);
          setComposing(true);
        }}
        onUnpair={() => {
          // 手机侧持 deviceToken，可一并清掉中继房间（桌面重连即被拒）
          void revokePairing(device.relayUrl, device.pairId, device.token).catch(() => {});
          clearPairing();
          localStorage.removeItem(LAST_SESSION_KEY);
          setDrawerOpen(false);
          setActiveId(null);
          setCatalog([]);
          setProjects([]);
          setProviders([]);
          setDevice(null);
        }}
      />

      <NewSessionSheet
        open={composing}
        projects={projects}
        providers={providers}
        onClose={() => setComposing(false)}
        onCreate={(req) => {
          const sessionId = crypto.randomUUID();
          send({ type: 'spawn', sessionId, ...req });
          setComposing(false);
          setActiveId(sessionId);
        }}
      />
    </>
  );
}
