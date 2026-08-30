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
import {
  isPushSupported,
  isStandalone,
  type PushFailureReason,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './push';
import { SessionConfigSheet } from './SessionConfigSheet';
import { SessionDrawer } from './SessionDrawer';
import { clearPairing, loadPairing, savePairing } from './storage';

/**
 * 扫码直达：桌面二维码是 https 链接，系统相机可直接打开本页并带上 #relay=…&pk=…。
 * 取出后立即抹掉 hash，避免公钥留在地址栏/历史里，也避免刷新时重复配对。
 */
function takeInviteFromUrl(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.includes('pk=')) return null;
  const link = window.location.href;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return link;
}

const STATE_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '已连接',
  'host-offline': '桌面端离线',
  unauthorized: '配对已失效',
  offline: '重连中…',
};

const LAST_SESSION_KEY = 'enso-phone-last-session';
const PUSH_ENABLED_KEY = 'enso-phone-push';

/** 通知点击冷启动时带的 ?session=：取出即抹掉，优先于上次会话 */
function takeSessionFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');
  if (!sessionId) return null;
  params.delete('session');
  const query = params.toString();
  history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
  return sessionId;
}

/** 推送可用性：iOS 必须先添加到主屏幕才有 pushManager */
function pushAvailability(): 'ok' | 'needs-install' | 'unsupported' {
  if (isPushSupported()) return 'ok';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIos && !isStandalone() ? 'needs-install' : 'unsupported';
}

export function App() {
  const [device, setDevice] = useState(loadPairing);
  // 只在首次挂载时取一次：内部会抹掉 hash，重复调用取不到
  const [urlInvite] = useState(takeInviteFromUrl);
  const [state, setState] = useState<ConnState>('connecting');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    () => takeSessionFromUrl() ?? localStorage.getItem(LAST_SESSION_KEY)
  );
  const [view, setView] = useState<SessionView | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(
    () => localStorage.getItem(PUSH_ENABLED_KEY) === 'on'
  );
  /** 已收到桌面下发的 push-config；旧版桌面不会发，开关据此提示升级 */
  const [pushConfigReady, setPushConfigReady] = useState(false);
  /** 订阅进行中：开关乐观显示已开但禁用，避免数秒无反馈 */
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<PushFailureReason | null>(null);
  const clientRef = useRef<PairClient | null>(null);
  const activeIdRef = useRef<string | null>(null);
  /** VAPID 公钥（桌面下发）；用 ref 避免重建连接 effect */
  const vapidKeyRef = useRef<string | null>(null);

  // SW 常驻注册（通知点击路由依赖它）+ 监听点击通知的切会话消息
  useEffect(() => {
    void registerServiceWorker();
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string };
      if (data?.type === 'open-session' && data.sessionId) setActiveId(data.sessionId);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!device) return;
    // 换绑另一台桌面时清掉上一台的 VAPID 公钥，等新桌面重新下发
    vapidKeyRef.current = null;
    setPushConfigReady(false);
    const client = new PairClient(device, {
      onState: setState,
      onCatalog: setCatalog,
      onProjects: setProjects,
      onProviders: setProviders,
      onSession: (id, next) => {
        setView((prev) => (id === activeIdRef.current ? next : prev));
      },
      onPushConfig: (key) => {
        vapidKeyRef.current = key;
        setPushConfigReady(true);
        // 已开启则每次连上都重新登记：订阅幂等，且能修复桌面侧订阅丢失
        if (localStorage.getItem(PUSH_ENABLED_KEY) === 'on') {
          void subscribePush(key).then((result) => {
            if (result.ok)
              client.send({ type: 'push-subscribe', subscription: result.subscription });
          });
        }
      },
    });
    clientRef.current = client;
    client.connect();
    // 切后台时系统会掐死或冻结 socket 且不触发 close：回前台/网络恢复立即探活。
    // 退后台瞬间赶在冻结前上报不可见：桌面据此把关键事件转系统推送
    //（半开 socket 不会 close，光靠 peer-left 桌面要很久才知道手机不在看）
    const nudge = () => {
      if (document.visibilityState === 'visible') {
        client.nudge();
        client.send({ type: 'presence', visible: true });
      } else {
        client.send({ type: 'presence', visible: false });
      }
    };
    document.addEventListener('visibilitychange', nudge);
    window.addEventListener('online', nudge);
    return () => {
      document.removeEventListener('visibilitychange', nudge);
      window.removeEventListener('online', nudge);
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
  // coworker tab 组：当前会话是子会话则归组到其父，否则以自身为父；无 coworker 时不显示
  const tabGroup = useMemo(() => {
    if (!entry) return undefined;
    const parent = entry.parentId ? catalog.find((c) => c.id === entry.parentId) : entry;
    if (!parent) return undefined;
    const children = catalog.filter((c) => c.parentId === parent.id);
    return children.length > 0 ? { parent, children } : undefined;
  }, [catalog, entry]);
  // 子会话（coworker）跟随父会话模型，与桌面一致不提供切换
  const configurable = entry && !entry.parentId;
  const modelLabel = configurable
    ? (providers.find((p) => p.id === entry.providerId)?.models.find((m) => m.id === entry.modelId)
        ?.label ??
      entry.modelId ??
      '选择模型')
    : undefined;

  if (!device) {
    return (
      <PairScreen
        autoInvite={urlInvite}
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

  const togglePush = async (next: boolean) => {
    setPushError(null);
    if (!next) {
      localStorage.setItem(PUSH_ENABLED_KEY, 'off');
      setPushEnabled(false);
      send({ type: 'push-unsubscribe' });
      void unsubscribePush();
      return;
    }
    const key = vapidKeyRef.current;
    if (!key) return; // 还没收到 push-config（未连上桌面），开关保持关闭
    // 乐观翻开 + busy：权限弹框与 FCM 注册要几秒，开关不动会被误认为没开
    setPushEnabled(true);
    setPushBusy(true);
    const result = await subscribePush(key);
    setPushBusy(false);
    if (!result.ok) {
      setPushEnabled(false);
      setPushError(result.reason);
      return;
    }
    send({ type: 'push-subscribe', subscription: result.subscription });
    localStorage.setItem(PUSH_ENABLED_KEY, 'on');
  };

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
        modelLabel={state === 'online' ? modelLabel : undefined}
        onOpenConfig={() => setConfigOpen(true)}
        tabGroup={tabGroup}
        onSelectTab={setActiveId}
        hasOlder={Boolean(
          activeId && view && view.messages.size > 0 && Math.min(...view.messages.keys()) > 0
        )}
        onLoadOlder={() => activeId && clientRef.current?.requestHistory(activeId)}
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
        pushEnabled={pushEnabled}
        pushBusy={pushBusy}
        pushError={pushError}
        pushAvailability={pushAvailability()}
        pushConfigReady={pushConfigReady}
        onTogglePush={(next) => void togglePush(next)}
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

      {configurable && activeId && (
        <SessionConfigSheet
          open={configOpen}
          providers={providers}
          config={{
            providerId: entry.providerId,
            modelId: entry.modelId,
            reasoningEnabled: entry.reasoningEnabled,
            thinkingLevel: entry.thinkingLevel,
          }}
          onClose={() => setConfigOpen(false)}
          onSetModel={(providerId, modelId) =>
            send({ type: 'set-model', sessionId: activeId, providerId, modelId })
          }
          onSetReasoning={(enabled) =>
            send({ type: 'set-reasoning', sessionId: activeId, enabled })
          }
          onSetThinking={(level) => send({ type: 'set-thinking', sessionId: activeId, level })}
        />
      )}
    </>
  );
}
