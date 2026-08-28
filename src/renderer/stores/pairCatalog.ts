import type { PairCatalogPayload } from '@shared/types';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

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
  const projectName = new Map(settings.projects.map((p) => [p.id, p.name]));

  const catalog = sessions.order
    .map((id) => sessions.conversations[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({
      id: c.id,
      title: c.title,
      projectName: projectName.get(c.projectId) ?? '',
      projectId: c.projectId,
      status: c.spawning ? 'running' : c.status,
      ...(c.parentId ? { parentId: c.parentId } : {}),
    }));

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
    projects: settings.projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    providers,
    // 仅 main 侧用于 spawn 反查 cwd，不下发手机
    projectPaths: settings.projects.map((p) => ({ id: p.id, path: p.path })),
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
    if (state.projects !== prev.projects || state.providers !== prev.providers) schedulePush();
  });
}
