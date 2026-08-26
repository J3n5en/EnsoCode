import type { Locale } from '@shared/i18n';
import { normalizeLocale } from '@shared/i18n';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyTerminalThemeToApp,
  clearTerminalThemeFromApp,
  isTerminalThemeDark,
} from '@/lib/ghosttyTheme';
import { electronStorage } from './storage';
import type { FontWeight, SettingsState, Theme } from './types';

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

const initialState = {
  theme: 'system' as Theme,
  language: getDefaultLocale(),
  terminalTheme: 'Dracula',
  terminalFontSize: 14,
  terminalFontFamily: 'ui-monospace, SF Mono, Menlo, Monaco, Consolas, monospace',
  terminalFontWeight: 'normal' as FontWeight,
  terminalFontWeightBold: '500' as FontWeight,
  favoriteTerminalThemes: [] as string[],
  loadLocalSkills: true,
  autoUpdate: true,
  providers: [] as import('@shared/types').ModelProvider[],
  skills: [] as import('@shared/types').SkillEntry[],
  mcpServers: [] as import('@shared/types').McpServerEntry[],
  instructions: [] as import('@shared/types').InstructionEntry[],
  presets: [] as import('@shared/types').Preset[],
  agentTypes: [] as import('@shared/types').AgentTypeEntry[],
  disabledBuiltinAgentTypes: [] as string[],
  disabledBuiltinTools: [] as string[],
  onboarded: false,
  keybindings: {} as Record<string, string>,
  projects: [] as import('@shared/types').Project[],
};

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

      // 按 baseUrl+apiKey 指纹去重，返回实际新增数量
      addProviders: (providers) => {
        const fingerprint = (p: { baseUrl: string; apiKey: string }) =>
          `${p.baseUrl.trim().replace(/\/+$/, '')}::${p.apiKey.trim()}`;
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

      updateProvider: (id, updates) =>
        set((state) => ({
          providers: state.providers.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),

      removeProvider: (id) =>
        set((state) => ({ providers: state.providers.filter((p) => p.id !== id) })),

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

      removePreset: (id) => set((state) => ({ presets: state.presets.filter((p) => p.id !== id) })),

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

      // 按目录路径去重；已存在时返回已有项
      addProject: (path) => {
        const existing = get().projects.find((project) => project.path === path);
        if (existing) return existing;
        const project = {
          id: crypto.randomUUID(),
          name: path.split('/').filter(Boolean).pop() ?? path,
          path,
        };
        set((state) => ({ projects: [...state.projects, project] }));
        return project;
      },

      removeProject: (id) => {
        set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
      },
    }),
    {
      name: 'enso-settings',
      storage: createJSONStorage(() => electronStorage),
      onRehydrateStorage: () => (state) => {
        const s = state ?? useSettingsStore.getState();
        applySettings(s);
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
      },
    }
  )
);

// 跟随系统明暗变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const state = useSettingsStore.getState();
  if (state.theme === 'system') {
    applyAppTheme('system', state.terminalTheme);
  }
});

// 多窗口同步：其他窗口写入设置后重新 rehydrate 本窗口 store 并应用副作用
window.electronAPI.settings.onChanged(() => {
  void useSettingsStore.persist.rehydrate();
});
