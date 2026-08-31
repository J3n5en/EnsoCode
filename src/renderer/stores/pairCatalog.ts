import { toPairProjectEntry } from '@enso/pair';
import type { PairCatalogPayload } from '@shared/types';
import { getXtermTheme } from '@/lib/ghosttyTheme';
import { useSessionsStore } from '@/stores/sessions';
import { setPairViewedSession } from '@/stores/sessions/unread';
import { useSettingsStore } from '@/stores/settings';
import { applyProjectOrder } from '@/stores/settings/projectOrder';
import {
  PINNED_ORDER_KEY,
  PROJECT_ORDER_KEY,
  readSidebarOrder,
  subscribeSidebarOrder,
} from '@/stores/settings/sidebarOrderStorage';

/**
 * 会话目录同步：会话标题、项目、provider 只存在于 renderer，
 * main 与 worker 都没有，故由此处 debounce 推给 main 供手机端展示。
 * providers 在这里剥掉 apiKey/baseUrl，密钥永不出 main。
 */

const DEBOUNCE_MS = 300;
let timer: ReturnType<typeof setTimeout> | null = null;
let bound = false;

function buildPayload(): PairCatalogPayload {
  const settings = useSettingsStore.getState();
  const sessions = useSessionsStore.getState();
  // 与桌面侧栏一致的项目手动顺序（拖拽偏好存 localStorage，不进 settings store）
  const orderedProjects = applyProjectOrder(settings.projects, readSidebarOrder(PROJECT_ORDER_KEY));
  const projectName = new Map(settings.projects.map((p) => [p.id, p.name]));

  type Conversation = NonNullable<(typeof sessions.conversations)[string]>;
  const toEntry = (c: Conversation) => ({
    id: c.id,
    title: c.parentId ? c.coworkerName || c.title : c.title,
    projectName: projectName.get(c.projectId) ?? '',
    projectId: c.projectId,
    status: c.spawning ? 'running' : c.status,
    updatedAt: c.messages.at(-1)?.timestamp ?? c.createdAt,
    ...(c.parentId ? { parentId: c.parentId } : {}),
    ...(c.pinned === true ? { pinned: true } : {}),
    ...(c.archived === true ? { archived: true } : {}),
    // 当前模型与推理档位：手机切换器回显；缺省字段不占帧体积
    ...(c.lastProviderId ? { providerId: c.lastProviderId } : {}),
    ...(c.lastModelId ? { modelId: c.lastModelId } : {}),
    ...(c.reasoningEnabled !== undefined ? { reasoningEnabled: c.reasoningEnabled } : {}),
    ...(c.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}),
    ...(c.unread === true ? { unread: true } : {}),
  });

  const topLevel = sessions.order
    .map((id) => sessions.conversations[id])
    .filter((c): c is Conversation => Boolean(c));
  // coworker 子会话不进 order（桌面用 tab 展示），但手机抽屉需要它们嵌套在父会话下；
  // 只补父会话仍在列表里的（dismissed 的已从 conversations 删除，自然不会出现）
  const inOrder = new Set(sessions.order);
  const children = Object.values(sessions.conversations).filter((c): c is Conversation =>
    Boolean(c?.parentId && inOrder.has(c.parentId))
  );

  const catalog = [...topLevel, ...children].map(toEntry);

  // 只下发可用 provider（启用 + 有 key），且剥掉密钥与 baseUrl
  const providers = settings.providers
    .filter((p) => p.enabled && p.apiKey)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models
        .filter((m) => m.enabled !== false)
        .map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })),
    }))
    .filter((p) => p.models.length > 0);

  return {
    catalog,
    // 置顶组的手动拖拽顺序：手机置顶栏按它排前，未收录的按活跃倒序
    pinnedOrder: readSidebarOrder(PINNED_ORDER_KEY),
    projects: orderedProjects.map(toPairProjectEntry),
    providers,
    // 仅 main 侧用于 spawn 反查 cwd，不下发手机
    projectPaths: settings.projects.map((p) => ({ id: p.id, path: p.path })),
    // 原样下发（含 sync-terminal：手机也按终端配色推导整套 UI，与桌面一致）；
    // system 交由手机跟随自己的系统深浅色，而非照搬桌面此刻的解析结果
    theme: settings.theme,
    // 只下发选中主题解析后的调色板（约几百字节），手机不必打包整份主题库
    terminal: getXtermTheme(settings.terminalTheme),
    terminalFontFamily: settings.terminalFontFamily,
  };
}

function schedulePush(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    window.electronAPI.pair.pushCatalog(buildPayload());
  }, DEBOUNCE_MS);
}

/** 应用启动时绑定一次：会话/项目/provider 变化即同步给 main */
export function bindPairCatalogSync(): void {
  if (bound) return;
  bound = true;
  schedulePush();
  useSessionsStore.subscribe((state, prev) => {
    if (state.conversations !== prev.conversations || state.order !== prev.order) schedulePush();
  });
  useSettingsStore.subscribe((state, prev) => {
    if (
      state.projects !== prev.projects ||
      state.providers !== prev.providers ||
      state.theme !== prev.theme ||
      state.terminalTheme !== prev.terminalTheme ||
      state.terminalFontFamily !== prev.terminalFontFamily
    ) {
      schedulePush();
    }
  });
  // 侧栏拖拽重排（项目/置顶）落盘后同步给手机
  subscribeSidebarOrder(schedulePush);
  // 手机订阅历史会话时恢复它，worker 才有投影可发（resume 对已启动会话自动忽略）
  window.electronAPI.pair.onResumeSession((sessionId) => {
    setPairViewedSession(sessionId);
    useSessionsStore.getState().markConversationRead(sessionId);
    void useSessionsStore.getState().resumeConversation(sessionId);
  });
  // 手机新建的会话登记进桌面列表；不登记的话它的 agent 事件会因「未知会话」被丢弃
  window.electronAPI.pair.onSessionCreated((session) => {
    useSessionsStore.getState().adoptPairSession(session);
  });
  // 手机改会话模型/推理档位：走桌面选择器同一 store 方法
  // （setModel 只记忆待用模型；reasoning/thinking 对已启动会话即时下发）
  window.electronAPI.pair.onSessionConfig((config) => {
    const store = useSessionsStore.getState();
    if (config.type === 'set-model') {
      store.setModel(config.sessionId, config.providerId, config.modelId);
    } else if (config.type === 'set-reasoning') {
      store.setReasoning(config.sessionId, config.enabled);
    } else {
      store.setThinking(config.sessionId, config.level);
    }
  });
}
