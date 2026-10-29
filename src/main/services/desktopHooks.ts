import type { RendererAgentEvent } from '@shared/types/agent';
import type { browserHost } from './browserHost';
import type { computerHost } from './computerHost';

export interface SessionDesktop {
  closeBrowser(sessionId: string, options?: { force?: boolean }): void;
  releaseBrowserActor(sessionId: string): void;
  forgetBrowserActor(sessionId: string): void;
  closeComputer(sessionId: string): void;
  closeAllComputers(): void;
  invokeBrowser: BrowserInvoke | null;
  invokeComputer: ComputerInvoke | null;
}

type BrowserInvoke = typeof browserHost.invoke;
type ComputerInvoke = typeof computerHost.invoke;

export interface BotDesktop {
  closeBrowser(key: string): Promise<void>;
  notifyChat(
    chatId: string,
    build: (lang: 'zh' | 'en') => { title: string; body: string }
  ): Promise<void>;
}

export interface NotifyDesktop {
  maybeNotify(event: RendererAgentEvent): void;
  maybeNotifyBot(
    event: RendererAgentEvent,
    bot: { enabled: boolean; chatId: string | null; name: string; conversationId: string }
  ): Promise<void>;
  setViewedSession(sessionId: string | null): void;
}

export interface FileDesktop {
  openPdf(file: string, title: string): void;
  openWorkspacePdf(file: string): Promise<void>;
  /** 工作区外文件定位前的原生确认框（显示完整真实路径）；无桌面宿主一律不确认 */
  confirmRevealExternal(senderId: number, file: string, locale: 'zh' | 'en'): Promise<boolean>;
}

export interface AppDesktop {
  updaterAvailable(): boolean;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  syncTrayToggleShortcut(keybindings: unknown): void;
}

const appDesktopNoop: AppDesktop = {
  updaterAvailable: () => false,
  async checkForUpdates() {
    throw new Error('Updater is not available on this host');
  },
  async downloadUpdate() {
    throw new Error('Updater is not available on this host');
  },
  syncTrayToggleShortcut() {},
};

const sessionDesktopNoop: SessionDesktop = {
  closeBrowser() {},
  releaseBrowserActor() {},
  forgetBrowserActor() {},
  closeComputer() {},
  closeAllComputers() {},
  invokeBrowser: null,
  invokeComputer: null,
};

const botDesktopNoop: BotDesktop = {
  async closeBrowser() {},
  async notifyChat() {},
};

const notifyDesktopNoop: NotifyDesktop = {
  maybeNotify() {},
  async maybeNotifyBot() {},
  setViewedSession() {},
};

const fileDesktopNoop: FileDesktop = {
  openPdf() {},
  async openWorkspacePdf() {
    throw new Error('unsupported-viewer');
  },
  async confirmRevealExternal() {
    return false;
  },
};

let sessionDesktopHooks = sessionDesktopNoop;
let botDesktopHooks = botDesktopNoop;
let notifyDesktopHooks = notifyDesktopNoop;
let fileDesktopHooks = fileDesktopNoop;
let appDesktopHooks = appDesktopNoop;

export function installDesktopHooks(hooks: {
  session?: SessionDesktop;
  bot?: BotDesktop;
  notify?: NotifyDesktop;
  file?: FileDesktop;
  app?: AppDesktop;
}): void {
  if (hooks.session) sessionDesktopHooks = hooks.session;
  if (hooks.bot) botDesktopHooks = hooks.bot;
  if (hooks.notify) notifyDesktopHooks = hooks.notify;
  if (hooks.file) fileDesktopHooks = hooks.file;
  if (hooks.app) appDesktopHooks = hooks.app;
}

export const sessionDesktop = (): SessionDesktop => sessionDesktopHooks;
export const botDesktop = (): BotDesktop => botDesktopHooks;
export const notifyDesktop = (): NotifyDesktop => notifyDesktopHooks;
export const fileDesktop = (): FileDesktop => fileDesktopHooks;
export const appDesktop = (): AppDesktop => appDesktopHooks;
