import type { CatalogEntry, ProjectEntry, ProviderEntry } from '@enso/pair';
import { Plus, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChatScreen } from './ChatScreen';
import { type ConnState, PairClient, type SessionView } from './client';
import { NewSessionSheet } from './NewSessionSheet';
import { PairScreen } from './PairScreen';
import { clearPairing, loadPairing, savePairing } from './storage';

const STATE_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '已连接',
  'host-offline': '桌面端离线',
  unauthorized: '配对已失效',
  offline: '重连中…',
};

/** 与桌面 StatusDot 同款状态点 */
function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse bg-info',
        status === 'failed' && 'bg-destructive',
        status !== 'running' && status !== 'failed' && 'bg-muted-foreground/40'
      )}
    />
  );
}

export function App() {
  const [device, setDevice] = useState(loadPairing);
  const [state, setState] = useState<ConnState>('connecting');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
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
  }, [activeId]);

  const visible = useMemo(
    () => catalog.filter((c) => !c.parentId && (!projectFilter || c.projectId === projectFilter)),
    [catalog, projectFilter]
  );

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

  if (activeId) {
    const entry = catalog.find((c) => c.id === activeId);
    return (
      <ChatScreen
        sessionId={activeId}
        title={entry?.title || '会话'}
        projectName={entry?.projectName ?? ''}
        view={view}
        connState={state}
        stateLabel={STATE_LABEL[state]}
        onBack={() => setActiveId(null)}
        onSend={(text, images) => {
          const running = view?.status === 'running';
          clientRef.current?.send({
            type: running ? 'steer' : 'prompt',
            sessionId: activeId,
            text,
            ...(images.length ? { images } : {}),
          });
        }}
        onAbort={() => clientRef.current?.send({ type: 'abort', sessionId: activeId })}
        onApproval={(requestId, decision) =>
          clientRef.current?.send({
            type: 'approval-respond',
            sessionId: activeId,
            requestId,
            decision,
          })
        }
        onAsk={(requestId, answer) =>
          clientRef.current?.send({ type: 'ask-respond', sessionId: activeId, requestId, answer })
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3 pt-safe">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="font-medium text-base">会话</h1>
          <span
            className={cn(
              'text-xs',
              state === 'online' ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {STATE_LABEL[state]}
          </span>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          disabled={state !== 'online'}
          onClick={() => setComposing(true)}
        >
          <Plus className="mr-1 h-4 w-4" />
          新建
        </Button>
      </header>

      {projects.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b px-4 py-2">
          <Chip active={!projectFilter} onClick={() => setProjectFilter(null)}>
            全部
          </Chip>
          {projects.map((p) => (
            <Chip key={p.id} active={projectFilter === p.id} onClick={() => setProjectFilter(p.id)}>
              {p.name}
            </Chip>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="px-6 py-16 text-center text-muted-foreground text-sm">
          {state === 'online' ? '暂无会话，点「新建」开始。' : '等待桌面端连接…'}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setActiveId(c.id)}
                className="flex w-full items-center gap-2.5 border-b px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate text-sm">{c.title || '未命名会话'}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {c.projectName}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewSessionSheet
        open={composing}
        projects={projects}
        providers={providers}
        onClose={() => setComposing(false)}
        onCreate={(req) => {
          const sessionId = crypto.randomUUID();
          clientRef.current?.send({ type: 'spawn', sessionId, ...req });
          setComposing(false);
          setActiveId(sessionId);
        }}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-accent'
      )}
    >
      {children}
    </button>
  );
}
