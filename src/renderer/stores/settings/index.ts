import { sanitizeDefaultModel } from '@shared/defaultModel';
import type { Locale } from '@shared/i18n';
import { normalizeLocale } from '@shared/i18n';
import {
  DEFAULT_STATUS_LINE_SEGMENTS,
  normalizeStatusLineSegments,
  type StatusLineSegmentId,
} from '@shared/statusLine';
import type { SourceAuthorityProjection } from '@shared/types/agent';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyTerminalThemeToApp,
  clearTerminalThemeFromApp,
  isTerminalThemeDark,
} from '@/lib/ghosttyTheme';
import {
  type OauthCredentialSnapshot,
  oauthCredentialContext,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { migrateSettings, SETTINGS_VERSION } from './migrate';
import { electronStorage } from './storage';
import type {
  BackgroundSizeMode,
  BackgroundSourceType,
  DefaultModelRevalidation,
  FontWeight,
  SettingsState,
  Theme,
} from './types';

export * from './types';

// Apply terminal font settings to app CSS variables
function applyTerminalFont(fontFamily: string, fontSize: number): void {
  const root = document.documentElement;
  root.style.setProperty('--font-family-mono', fontFamily);
  root.style.setProperty('--font-size-base', `${fontSize}px`);
}

// Apply app theme (dark/light mode)
function applyAppTheme(theme: Theme, terminalTheme: string): void {
  let isDark: boolean;

  switch (theme) {
    case 'light':
      isDark = false;
      break;
    case 'dark':
      isDark = true;
      break;
    case 'system':
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      break;
    case 'sync-terminal':
      isDark = isTerminalThemeDark(terminalTheme);
      break;
  }

  document.documentElement.classList.toggle('dark', isDark);
}

// Apply settings side effects (theme / font / lang) — 初次加载与多窗口同步时调用
function applySettings(state: {
  theme: Theme;
  terminalTheme: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  language: Locale;
}): void {
  if (state.theme === 'sync-terminal') {
    applyTerminalThemeToApp(state.terminalTheme, true);
  } else {
    clearTerminalThemeFromApp();
    applyAppTheme(state.theme, state.terminalTheme);
  }
  applyTerminalFont(state.terminalFontFamily, state.terminalFontSize);
  document.documentElement.lang = normalizeLocale(state.language) === 'zh' ? 'zh-CN' : 'en';
}

function getDefaultLocale(): Locale {
  return normalizeLocale(navigator.language);
}

/** 数值设置项的防御：非法值落回缺省，越界值夹回范围 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const initialState = {
  theme: 'system' as Theme,
  language: getDefaultLocale(),
  terminalTheme: 'Dracula',
  terminalFontSize: 14,
  terminalFontFamily: 'ui-monospace, SF Mono, Menlo, Monaco, Consolas, monospace',
  terminalFontWeight: 'normal' as FontWeight,
  terminalFontWeightBold: '500' as FontWeight,
  favoriteTerminalThemes: [] as string[],
  statusLineSegments: [...DEFAULT_STATUS_LINE_SEGMENTS] as StatusLineSegmentId[],
  loadLocalSkills: true,
  autoUpdate: true,
  backgroundImageEnabled: false,
  backgroundSourceType: 'file' as BackgroundSourceType,
  backgroundImagePath: '',
  backgroundFolderPath: '',
  backgroundUrlPath: '',
  backgroundRandomEnabled: false,
  backgroundRandomInterval: 300,
  backgroundOpacity: 0.85,
  backgroundBlur: 0,
  backgroundBrightness: 1,
  backgroundSaturation: 1,
  backgroundComposerOpacity: 0.6,
  backgroundCodeOpacity: 0.65,
  backgroundSizeMode: 'cover' as BackgroundSizeMode,
  backgroundRefreshNonce: 0,
  providers: [] as import('@shared/types').ModelProvider[],
  defaultModel: null,
  skills: [] as import('@shared/types').SkillEntry[],
  mcpServers: [] as import('@shared/types').McpServerEntry[],
  instructions: [] as import('@shared/types').InstructionEntry[],
  presets: [] as import('@shared/types').Preset[],
  defaultPresetId: 'default',
  agentTypes: [] as import('@shared/types').AgentTypeEntry[],
  subagentModelsEnabled: false,
  subagentModels: [] as import('@shared/types').SubagentModelEntry[],
  disabledBuiltinAgentTypes: [] as string[],
  disabledBuiltinTools: [] as string[],
  onboarded: false,
  keybindings: {} as Record<string, string>,
  projects: [] as import('@shared/types').Project[],
};
interface DefaultModelRevalidationState {
  latest: DefaultModelRevalidation | null;
}

/** 默认失效说明是每个 Renderer 窗口的瞬时状态，不进入 settings.json。 */
export const useDefaultModelRevalidationStore = create<DefaultModelRevalidationState>(() => ({
  latest: null,
}));

function publishDefaultModelRevalidation(result: DefaultModelRevalidation): void {
  useDefaultModelRevalidationStore.setState({ latest: result });
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setTheme: (theme) => {
        const terminalTheme = get().terminalTheme;
        if (theme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        } else {
          clearTerminalThemeFromApp();
          applyAppTheme(theme, terminalTheme);
        }
        set({ theme });
      },

      setLanguage: (language) => {
        document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
        set({ language });
      },

      setTerminalTheme: (terminalTheme) => {
        if (get().theme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        }
        set({ terminalTheme });
      },

      setTerminalFontSize: (terminalFontSize) => {
        applyTerminalFont(get().terminalFontFamily, terminalFontSize);
        set({ terminalFontSize });
      },

      setTerminalFontFamily: (terminalFontFamily) => {
        applyTerminalFont(terminalFontFamily, get().terminalFontSize);
        set({ terminalFontFamily });
      },

      setTerminalFontWeight: (terminalFontWeight) => set({ terminalFontWeight }),
      setTerminalFontWeightBold: (terminalFontWeightBold) => set({ terminalFontWeightBold }),

      toggleFavoriteTerminalTheme: (theme) =>
        set((state) => ({
          favoriteTerminalThemes: state.favoriteTerminalThemes.includes(theme)
            ? state.favoriteTerminalThemes.filter((t) => t !== theme)
            : [...state.favoriteTerminalThemes, theme],
        })),

      setLoadLocalSkills: (loadLocalSkills) => set({ loadLocalSkills }),
      setAutoUpdate: (autoUpdate) => set({ autoUpdate }),

      setBackgroundImageEnabled: (backgroundImageEnabled) => set({ backgroundImageEnabled }),
      setBackgroundSourceType: (backgroundSourceType) => set({ backgroundSourceType }),
      setBackgroundImagePath: (backgroundImagePath) => set({ backgroundImagePath }),
      setBackgroundFolderPath: (backgroundFolderPath) => set({ backgroundFolderPath }),
      setBackgroundUrlPath: (backgroundUrlPath) => set({ backgroundUrlPath }),
      setBackgroundRandomEnabled: (backgroundRandomEnabled) => set({ backgroundRandomEnabled }),
      setBackgroundRandomInterval: (seconds) =>
        set({ backgroundRandomInterval: clampNumber(seconds, 5, 86400, 300) }),
      setBackgroundOpacity: (opacity) =>
        set({ backgroundOpacity: clampNumber(opacity, 0, 1, 0.85) }),
      setBackgroundBlur: (blur) => set({ backgroundBlur: clampNumber(blur, 0, 20, 0) }),
      setBackgroundBrightness: (brightness) =>
        set({ backgroundBrightness: clampNumber(brightness, 0, 2, 1) }),
      setBackgroundSaturation: (saturation) =>
        set({ backgroundSaturation: clampNumber(saturation, 0, 2, 1) }),
      setBackgroundComposerOpacity: (opacity) =>
        set({ backgroundComposerOpacity: clampNumber(opacity, 0, 1, 0.6) }),
      setBackgroundCodeOpacity: (opacity) =>
        set({ backgroundCodeOpacity: clampNumber(opacity, 0, 1, 0.65) }),
      setBackgroundSizeMode: (backgroundSizeMode) => set({ backgroundSizeMode }),
      bumpBackgroundRefresh: () =>
        set((state) => ({ backgroundRefreshNonce: (state.backgroundRefreshNonce ?? 0) + 1 })),

      setStatusLineSegments: (statusLineSegments) => set({ statusLineSegments }),
      toggleStatusLineSegment: (id, enabled) =>
        set((state) => ({
          statusLineSegments: enabled
            ? state.statusLineSegments.includes(id)
              ? state.statusLineSegments
              : [...state.statusLineSegments, id]
            : state.statusLineSegments.filter((segment) => segment !== id),
        })),

      // 按 baseUrl+apiKey 指纹去重；订阅条目按 oauthAccountKey——同一厂商的多个账号
      // key 各异，用基础 providerId 会把第二个账号当重复项吞掉
      addProviders: (providers) => {
        const fingerprint = (p: { baseUrl: string; apiKey: string; oauthAccountKey?: string }) =>
          p.oauthAccountKey
            ? `oauth::${p.oauthAccountKey}`
            : `${p.baseUrl.trim().replace(/\/+$/, '')}::${p.apiKey.trim()}`;
        const known = new Set(get().providers.map(fingerprint));
        const fresh = providers.filter((provider) => {
          const key = fingerprint(provider);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        if (fresh.length > 0) {
          set((state) => ({ providers: [...state.providers, ...fresh] }));
        }
        return fresh.length;
      },

      updateProvider: (id, updates) => {
        set((state) => ({
          providers: state.providers.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        }));
        get().revalidateDefaultModel(useOauthCredentialStore.getState().snapshot);
      },

      removeProvider: (id) => {
        set((state) => ({ providers: state.providers.filter((p) => p.id !== id) }));
        get().revalidateDefaultModel(useOauthCredentialStore.getState().snapshot);
      },

      setDefaultModel: (defaultModel) => {
        useDefaultModelRevalidationStore.setState({ latest: null });
        set({ defaultModel });
      },

      revalidateDefaultModel: (snapshot: OauthCredentialSnapshot) => {
        const defaultModel = get().defaultModel;
        if (snapshot.revision !== useOauthCredentialStore.getState().snapshot.revision) {
          const stale: DefaultModelRevalidation = {
            status: 'stale',
            defaultModel,
            writeback: false,
            notice: null,
          };
          publishDefaultModelRevalidation(stale);
          return stale;
        }

        const sanitized = sanitizeDefaultModel({
          defaultModel,
          providers: get().providers,
          credentials: oauthCredentialContext(snapshot),
        });
        if (sanitized.status === 'unchanged') {
          const unchanged: DefaultModelRevalidation = {
            ...sanitized,
            writeback: false,
          };
          publishDefaultModelRevalidation(unchanged);
          return unchanged;
        }
        if (sanitized.status === 'deferred-oauth-unavailable') {
          const deferred: DefaultModelRevalidation = {
            ...sanitized,
            status: 'deferred',
            writeback: false,
          };
          publishDefaultModelRevalidation(deferred);
          return deferred;
        }

        const result: DefaultModelRevalidation = {
          ...sanitized,
          writeback: true,
        };
        publishDefaultModelRevalidation(result);
        set({ defaultModel: result.defaultModel });
        return result;
      },

      // 技能以名称为标识去重，同时拦住同路径的重复登记
      addSkills: (skills) => {
        const nameKey = (name: string) => name.trim().toLowerCase();
        const knownNames = new Set(get().skills.map((skill) => nameKey(skill.name)));
        const knownPaths = new Set(get().skills.map((skill) => skill.path));
        const fresh = skills.filter((skill) => {
          const key = nameKey(skill.name);
          if (knownNames.has(key) || knownPaths.has(skill.path)) return false;
          knownNames.add(key);
          knownPaths.add(skill.path);
          return true;
        });
        if (fresh.length > 0) {
          set((state) => ({ skills: [...state.skills, ...fresh] }));
        }
        return fresh.length;
      },

      updateSkill: (id, updates) =>
        set((state) => ({
          skills: state.skills.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),

      removeSkill: (id) => set((state) => ({ skills: state.skills.filter((s) => s.id !== id) })),

      // 按启动命令或 URL 去重
      addMcpServers: (servers) => {
        const fingerprint = (server: import('@shared/types').McpServerEntry) =>
          server.url
            ? `url::${server.url.replace(/\/+$/, '')}`
            : `cmd::${server.command} ${(server.args ?? []).join(' ')}`.trim();
        const known = new Set(get().mcpServers.map(fingerprint));
        const fresh = servers.filter((server) => {
          const key = fingerprint(server);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        if (fresh.length > 0) {
          set((state) => ({ mcpServers: [...state.mcpServers, ...fresh] }));
        }
        return fresh.length;
      },

      updateMcpServer: (id, updates) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),

      removeMcpServer: (id) =>
        set((state) => ({ mcpServers: state.mcpServers.filter((s) => s.id !== id) })),

      // 按源文件路径去重；无文件的内联条目按名称+来源去重
      addInstructions: (instructions) => {
        const key = (item: import('@shared/types').InstructionEntry) =>
          item.sourcePath ?? `${item.source}::${item.name}`;
        const known = new Set(get().instructions.map(key));
        const fresh = instructions.filter((item) => {
          const value = key(item);
          if (known.has(value)) return false;
          known.add(value);
          return true;
        });
        if (fresh.length > 0) {
          // 单主源：已有启用条目时新导入的全部关闭；否则只留第一条启用
          set((state) => {
            const hasEnabled = state.instructions.some((i) => i.enabled);
            const normalized = fresh.map((item, index) => ({
              ...item,
              enabled: !hasEnabled && index === 0,
            }));
            return { instructions: [...state.instructions, ...normalized] };
          });
        }
        return fresh.length;
      },

      // 指令文件单主源：启用一条时其余自动关闭（同一时间只有一份注入会话）
      updateInstruction: (id, updates) =>
        set((state) => ({
          instructions: state.instructions.map((i) =>
            i.id === id
              ? { ...i, ...updates }
              : updates.enabled === true
                ? { ...i, enabled: false }
                : i
          ),
        })),

      removeInstruction: (id) => {
        // 只删本地副本，源文件不动
        void window.electronAPI.instructions.delete(id);
        set((state) => ({ instructions: state.instructions.filter((i) => i.id !== id) }));
      },

      addPreset: (preset) => {
        const created = { ...preset, id: crypto.randomUUID() };
        set((state) => ({ presets: [...state.presets, created] }));
        return created;
      },

      updatePreset: (id, updates) =>
        set((state) => ({
          presets: state.presets.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),

      removePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((p) => p.id !== id),
          // 默认预设被删除时回落内置全局预设
          ...(state.defaultPresetId === id ? { defaultPresetId: 'default' } : {}),
        })),

      setDefaultPresetId: (defaultPresetId) => set({ defaultPresetId }),

      setSubagentModelsEnabled: (subagentModelsEnabled) => set({ subagentModelsEnabled }),

      addSubagentModel: (entry) => {
        const created = { ...entry, id: crypto.randomUUID() };
        set((state) => ({ subagentModels: [...state.subagentModels, created] }));
        return created;
      },

      updateSubagentModel: (id, updates) =>
        set((state) => ({
          subagentModels: state.subagentModels.map((entry) =>
            entry.id === id ? { ...entry, ...updates } : entry
          ),
        })),

      removeSubagentModel: (id) =>
        set((state) => ({
          subagentModels: state.subagentModels.filter((entry) => entry.id !== id),
        })),

      addAgentType: (entry) => {
        const created = { ...entry, id: crypto.randomUUID() };
        set((state) => ({ agentTypes: [...state.agentTypes, created] }));
        return created;
      },

      updateAgentType: (id, updates) =>
        set((state) => ({
          agentTypes: state.agentTypes.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })),

      removeAgentType: (id) =>
        set((state) => ({ agentTypes: state.agentTypes.filter((t) => t.id !== id) })),

      toggleBuiltinAgentType: (name, enabled) =>
        set((state) => ({
          disabledBuiltinAgentTypes: enabled
            ? state.disabledBuiltinAgentTypes.filter((n) => n !== name)
            : [...new Set([...state.disabledBuiltinAgentTypes, name])],
        })),

      toggleBuiltinTool: (id, enabled) =>
        set((state) => ({
          disabledBuiltinTools: enabled
            ? state.disabledBuiltinTools.filter((n) => n !== id)
            : [...new Set([...state.disabledBuiltinTools, id])],
        })),

      setOnboarded: (onboarded) => set({ onboarded }),

      setKeybinding: (action, binding) =>
        set((state) => ({ keybindings: { ...state.keybindings, [action]: binding } })),
      resetKeybinding: (action) =>
        set((state) => {
          const { [action]: _removed, ...rest } = state.keybindings;
          return { keybindings: rest };
        }),

      // Project execution authority is created/removed only through the dedicated Main registry.
      addProject: async (path, remote) => {
        const projection = await window.electronAPI.sourceAuthority.read();
        const existing = projection.projects.find((project) => {
          if (project.state !== 'active' || project.canonicalPath !== path) return false;
          // 本地/远程不互认:ssh 项目还要同 host
          return remote
            ? project.sshConnectionId === remote.sshConnectionId
            : project.kind !== 'ssh';
        });
        const result = existing
          ? { accepted: true as const, value: existing }
          : await window.electronAPI.sourceAuthority.createProject({
              requestId: crypto.randomUUID(),
              path,
              ...(remote ? { kind: 'ssh' as const, sshConnectionId: remote.sshConnectionId } : {}),
            });
        if (!result.accepted) {
          throw new Error(
            ('error' in result && typeof result.error === 'string' && result.error) ||
              'Failed to add project.'
          );
        }
        const project = {
          id: result.value.projectId,
          name:
            result.value.canonicalPath.split('/').filter(Boolean).pop() ??
            result.value.canonicalPath,
          path: result.value.canonicalPath,
          ...(result.value.kind === 'ssh'
            ? {
                kind: 'ssh' as const,
                sshHost: result.value.sshHost,
                sshConnectionId: result.value.sshConnectionId,
                sshConnectionName: result.value.sshConnectionName,
              }
            : {}),
        };
        set((state) => ({
          projects: [...state.projects.filter((candidate) => candidate.id !== project.id), project],
        }));
        return project;
      },

      removeProject: async (id) => {
        const projection = await window.electronAPI.sourceAuthority.read();
        const project = projection.projects.find(
          (candidate) => candidate.projectId === id && candidate.state === 'active'
        );
        if (!project) {
          set((state) => ({ projects: state.projects.filter((candidate) => candidate.id !== id) }));
          return true;
        }
        const result = await window.electronAPI.sourceAuthority.removeProject({
          requestId: crypto.randomUUID(),
          projectId: id,
          version: project.version,
        });
        if (!result.accepted) return false;
        set((state) => ({ projects: state.projects.filter((candidate) => candidate.id !== id) }));
        return true;
      },
    }),
    {
      name: 'enso-settings',
      storage: createJSONStorage(() => electronStorage),
      version: SETTINGS_VERSION,
      migrate: (persisted, version) => migrateSettings(persisted, version) as SettingsState,
      onRehydrateStorage: () => (state) => {
        const s = state ?? useSettingsStore.getState();
        applySettings(s);
        // 持久化数据可能被外部污染；非法值会让设置弹层渲染 undefined 图标而白屏
        const segments = normalizeStatusLineSegments(s.statusLineSegments);
        if (
          segments.length !== s.statusLineSegments?.length ||
          segments.some((id, i) => s.statusLineSegments[i] !== id)
        ) {
          useSettingsStore.setState({ statusLineSegments: segments });
        }
        // 老用户（升级前已有配置）视为已完成引导，避免被打扰
        if (
          !s.onboarded &&
          (s.providers.length > 0 ||
            s.skills.length > 0 ||
            s.mcpServers.length > 0 ||
            s.instructions.length > 0)
        ) {
          useSettingsStore.setState({ onboarded: true });
        }
        // OAuth bootstrap 可能先于 persist 水合完成；水合后必须用当时最新快照再校验一次。
        useSettingsStore
          .getState()
          .revalidateDefaultModel(useOauthCredentialStore.getState().snapshot);
        void refreshProjectAuthorityProjection();
      },
    }
  )
);

function applyProjectAuthorityProjection(projection: SourceAuthorityProjection): void {
  const next = projection.projects
    .filter((project) => project.state === 'active')
    .map((project) => ({
      id: project.projectId,
      name: project.canonicalPath.split('/').filter(Boolean).pop() ?? project.canonicalPath,
      path: project.canonicalPath,
      ...(project.kind === 'ssh'
        ? {
            kind: 'ssh' as const,
            sshHost: project.sshHost,
            sshConnectionId: project.sshConnectionId,
            sshConnectionName: project.sshConnectionName,
          }
        : {}),
    }));
  // 投影未变时必须不写 state：persist 的每次 setState 都会落盘并广播 SETTINGS_CHANGED，
  // 而收到广播的窗口 rehydrate 后又会重投影。无条件写会让两个窗口互相广播成死循环
  // （单窗口不复现，因为广播 exclude-sender）。
  if (sameProjectProjection(useSettingsStore.getState().projects, next)) return;
  useSettingsStore.setState({ projects: next });
}

function sameProjectProjection(
  current: SettingsState['projects'],
  next: SettingsState['projects']
): boolean {
  if (current.length !== next.length) return false;
  return current.every((project, index) => {
    const candidate = next[index];
    return (
      project.id === candidate.id &&
      project.name === candidate.name &&
      project.path === candidate.path &&
      project.kind === candidate.kind &&
      project.sshHost === candidate.sshHost &&
      project.sshConnectionId === candidate.sshConnectionId &&
      project.sshConnectionName === candidate.sshConnectionName
    );
  });
}

async function refreshProjectAuthorityProjection(): Promise<void> {
  applyProjectAuthorityProjection(await window.electronAPI.sourceAuthority.read());
}

window.electronAPI.sourceAuthority.onChanged(applyProjectAuthorityProjection);
void refreshProjectAuthorityProjection();

// 跟随系统明暗变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const state = useSettingsStore.getState();
  if (state.theme === 'system') {
    applyAppTheme('system', state.terminalTheme);
  }
});

// Generic settings is display persistence only; executable project identity is always re-projected by Main.
window.electronAPI.settings.onChanged(() => {
  void Promise.resolve(useSettingsStore.persist.rehydrate()).then(
    refreshProjectAuthorityProjection
  );
});
