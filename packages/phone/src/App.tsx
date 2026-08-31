import {
  type CatalogEntry,
  type PairedDevice,
  type ProjectEntry,
  type ProviderEntry,
  revokePairing,
} from '@enso/pair';
import { Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChatScreen } from './ChatScreen';
import { type ConnState, PairClient, type SessionView } from './client';
import { pickActive, removeDevice, renameDevice, upsertDevice } from './deviceList';
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
import {
  clearDeviceData,
  loadActiveDeviceId,
  loadDevices,
  loadLastSession,
  saveActiveDeviceId,
  saveDevices,
  saveLastSession,
} from './storage';

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
  const [devices, setDevices] = useState(loadDevices);
  const [activeDeviceId, setActiveDeviceId] = useState(loadActiveDeviceId);
  /** 活跃桌面：失配（已被删）回落第一台；无配对时为 null 进配对页 */
  const device = pickActive(devices, activeDeviceId);
  // 只在首次挂载时取一次：内部会抹掉 hash，重复调用取不到
  const [urlInvite] = useState(takeInviteFromUrl);
  /** 已配对状态下的「配对新电脑」流程（覆盖 PairScreen） */
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState<ConnState>('connecting');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => {
    const initial = pickActive(loadDevices(), loadActiveDeviceId());
    return takeSessionFromUrl() ?? (initial ? loadLastSession(initial.pairId) : null);
  });
  const [view, setView] = useState<SessionView | null>(null);
  /** 订阅会话同步中（subscribe 已发、snapshot 未回）：此时时间线可能是陈旧的 */
  const [syncing, setSyncing] = useState(false);
  /** 横幅刚收起时短暂闪现「已是最新」，随后淡出 */
  const [okFlash, setOkFlash] = useState(false);
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

  // 已配对状态下扫桌面二维码（地址栏带 #pk=）：进入添加流程，不再覆盖旧配对
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时判一次
  useEffect(() => {
    if (urlInvite && devices.length > 0) setAdding(true);
  }, []);

  // 只按凭据重建连接：重命名只换 label，不该断重连，故用字段级依赖
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上，device 按 pairId/token/relayUrl/contentKey 变化才重连
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
      onSync: (state) => setSyncing(state === 'syncing'),
      onGhostSession: (id) => {
        // 订阅的会话已在桌面被删：跳回列表态，由 firstId 兑底选最近一条
        if (id === activeIdRef.current) setActiveId(null);
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
  }, [device?.pairId, device?.token, device?.relayUrl, device?.contentKey]);

  /** 手机刚 spawn 的会话 id（一次性）：首次订阅不进 syncing——全新会话没有历史可陈旧，
   * 而 spawn 在途时 host 回的快照不含它，会让「同步中」横幅挂到切会话才消 */
  const freshIdsRef = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: pairId 变化时也要在新 client 上重订阅
  useEffect(() => {
    activeIdRef.current = activeId;
    // 用 has 而非读时删除：StrictMode 下 effect 双跑，第二跑不能把标记吞掉；切走时才消费
    const fresh = activeId !== null && freshIdsRef.current.has(activeId);
    clientRef.current?.subscribe(activeId, { fresh });
    for (const id of freshIdsRef.current) {
      if (id !== activeId) freshIdsRef.current.delete(id);
    }
    setView(activeId ? (clientRef.current?.getSession(activeId) ?? null) : null);
    if (device) saveLastSession(device.pairId, activeId);
  }, [activeId, device?.pairId]);

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

  // TG 式状态横幅：非 online 显示连接状态；online 且订阅同步中显示同步中；
  // 收起瞬间短暂闪现「已是最新」再淡出，不常驻占屏。
  const bannerLabel =
    state !== 'online' && state !== 'unauthorized'
      ? STATE_LABEL[state]
      : state === 'online' && syncing && activeId
        ? '同步中…'
        : null;
  const prevBannerRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevBannerRef.current;
    prevBannerRef.current = bannerLabel;
    if (prev && !bannerLabel) {
      setOkFlash(true);
      const timer = setTimeout(() => setOkFlash(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [bannerLabel]);
  const banner = bannerLabel
    ? { label: bannerLabel, tone: 'progress' as const }
    : okFlash
      ? { label: '已是最新', tone: 'ok' as const }
      : null;

  /** 切到另一台时清空上一台的目录/视图，等新桌面下发 */
  const resetHostState = (nextActiveId: string | null) => {
    setCatalog([]);
    setProjects([]);
    setProviders([]);
    setView(null);
    setSyncing(false);
    setActiveId(nextActiveId);
  };

  const switchDevice = (pairId: string) => {
    if (pairId === device?.pairId) return;
    saveActiveDeviceId(pairId);
    setActiveDeviceId(pairId);
    // 旧连接状态不属于新桌面：乐观置回连接中，避免闪现 unauthorized/host-offline 旧屏
    setState('connecting');
    resetHostState(loadLastSession(pairId));
    setDrawerOpen(false);
  };

  const addDevice = (d: PairedDevice) => {
    const next = upsertDevice(devices, d);
    setDevices(next);
    saveDevices(next);
    saveActiveDeviceId(d.pairId);
    setActiveDeviceId(d.pairId);
    resetHostState(loadLastSession(d.pairId));
    setAdding(false);
  };

  const unpairDevice = (pairId: string) => {
    const target = devices.find((d) => d.pairId === pairId);
    // 手机侧持 deviceToken，可一并清掉中继房间（桌面重连即被拒）；已被对端解绑时失败无妄
    if (target) void revokePairing(target.relayUrl, target.pairId, target.token).catch(() => {});
    clearDeviceData(pairId);
    const next = removeDevice(devices, pairId);
    setDevices(next);
    saveDevices(next);
    if (pairId === (device?.pairId ?? null)) {
      const fallback = pickActive(next, null);
      saveActiveDeviceId(fallback?.pairId ?? null);
      setActiveDeviceId(fallback?.pairId ?? null);
      if (fallback) setState('connecting');
      resetHostState(fallback ? loadLastSession(fallback.pairId) : null);
      if (!fallback) setDrawerOpen(false);
    }
  };

  const handleRename = (pairId: string, label: string) => {
    const next = renameDevice(devices, pairId, label);
    setDevices(next);
    saveDevices(next);
  };

  if (!device || adding) {
    return (
      <PairScreen
        autoInvite={urlInvite}
        onPaired={addDevice}
        onCancel={device ? () => setAdding(false) : undefined}
      />
    );
  }

  if (state === 'unauthorized') {
    const others = devices.length > 1;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone className="h-8 w-8 text-muted-foreground" />
        <h1 className="font-medium text-lg">配对已失效</h1>
        <p className="text-muted-foreground text-sm">
          「{device.label}」已解绑此设备，
          {others ? '可移除它并切到其他电脑。' : '请重新扫码配对。'}
        </p>
        <Button onClick={() => unpairDevice(device.pairId)}>
          {others ? '移除此配对' : '重新配对'}
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
        banner={banner}
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
        devices={devices}
        activeDevicePairId={device.pairId}
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
        onSwitchDevice={switchDevice}
        onAddDevice={() => {
          setDrawerOpen(false);
          setAdding(true);
        }}
        onRenameDevice={handleRename}
        onUnpairDevice={unpairDevice}
      />

      <NewSessionSheet
        open={composing}
        projects={projects}
        providers={providers}
        onClose={() => setComposing(false)}
        onCreate={(req) => {
          const sessionId = crypto.randomUUID();
          send({ type: 'spawn', sessionId, ...req });
          freshIdsRef.current.add(sessionId);
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
