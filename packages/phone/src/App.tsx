import type { CatalogEntry, ProjectEntry, ProviderEntry } from '@enso/pair';
import { useEffect, useMemo, useRef, useState } from 'react';
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

  // 订阅切换要读最新 activeId（避免 effect 闭包捕获旧值）
  const activeIdRef = useRef<string | null>(null);
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
      <div className="screen">
        <h1>配对已失效</h1>
        <p className="hint">桌面端已解绑此设备，请重新扫码配对。</p>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            clearPairing();
            setDevice(null);
          }}
        >
          重新配对
        </button>
      </div>
    );
  }

  if (activeId) {
    const entry = catalog.find((c) => c.id === activeId);
    return (
      <ChatScreen
        title={entry?.title ?? '会话'}
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
    <div className="screen list-screen">
      <header className="topbar">
        <div>
          <h1>会话</h1>
          <span className={`state ${state}`}>{STATE_LABEL[state]}</span>
        </div>
        <button
          type="button"
          className="btn primary sm"
          disabled={state !== 'online'}
          onClick={() => setComposing(true)}
        >
          + 新建
        </button>
      </header>

      {projects.length > 1 && (
        <div className="chips">
          <button
            type="button"
            className={`chip ${!projectFilter ? 'on' : ''}`}
            onClick={() => setProjectFilter(null)}
          >
            全部
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip ${projectFilter === p.id ? 'on' : ''}`}
              onClick={() => setProjectFilter(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="empty">
          {state === 'online' ? '暂无会话，点「新建」开始。' : '等待桌面端连接…'}
        </p>
      ) : (
        <ul className="sessions">
          {visible.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setActiveId(c.id)}>
                <span className={`dot ${c.status}`} />
                <span className="title">{c.title || '未命名会话'}</span>
                <span className="project">{c.projectName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {composing && (
        <NewSessionSheet
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
      )}
    </div>
  );
}
