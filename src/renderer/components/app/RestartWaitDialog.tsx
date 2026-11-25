import { QUIT_REPLY_IDLE_MS, QUIT_REPLY_WAIT_CAP_MS } from '@shared/quitLimits';
import type { AppExitReason, RestartBlocker, RestartOverlayState } from '@shared/types/ipc';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2 } from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { heightVariants, heightVariantsReduced, usePrefersReducedMotion } from '@/lib/motion';
import { useSessionsStore } from '@/stores/sessions';
import { BannerBar } from './BannerBar';

const EXIT_NOTES: Record<AppExitReason, string> = {
  restart: 'EnsoCode will restart once the current command finishes.',
  update: 'EnsoCode will install the update once the current command finishes.',
  quit: 'EnsoCode will quit once the current command finishes.',
};

const EXIT_STRIPS: Record<AppExitReason, string> = {
  restart: 'Restarting once the current command finishes',
  update: 'Installing the update once the current command finishes',
  quit: 'Quitting once the current command finishes',
};

interface RestartOverlayView {
  state: RestartOverlayState | null;
  // 关弹层的淡出期间文案保持关前那一态，不闪成别的
  shown: RestartOverlayState;
  forcing: boolean;
  minimized: boolean;
}

/** 弹层与最小化条共用的视图状态；最小化只在渲染端，Main 的等待与重启不受影响 */
export const useRestartOverlayStore = create<RestartOverlayView>(() => ({
  state: null,
  shown: { phase: 'restarting' },
  forcing: false,
  minimized: false,
}));

function applyOverlay(next: RestartOverlayState | null, pushed: boolean): void {
  useRestartOverlayStore.setState((view) => ({
    state: next,
    shown: next ?? view.shown,
    forcing: pushed ? false : view.forcing,
    // 等待中重推保持最小化；进入正在重启 / 恢复或关掉时回到全屏
    minimized: view.minimized && next?.phase === 'waiting',
  }));
}

function forceQuit(): void {
  useRestartOverlayStore.setState({ forcing: true });
  window.electronAPI.app.forceRestart();
}

const setMinimized = (minimized: boolean) => useRestartOverlayStore.setState({ minimized });

const BLOCKER_LIMIT = 5;

function blockerTitle(
  conversations: Record<string, { title: string } | undefined>,
  sessionId: string
): { title: string; child: boolean } {
  const split = sessionId.indexOf('::');
  const child = split !== -1;
  const id = child ? sessionId.slice(0, split) : sessionId;
  const title = conversations[id]?.title.trim();
  return { title: title || sessionId.slice(0, 8), child };
}

function blockerReason(
  t: (key: string, params?: Record<string, string | number>) => string,
  blocker: RestartBlocker,
  child: boolean
): string {
  if (blocker.kind === 'tool') {
    const tool = blocker.tools?.join(', ') ?? '';
    return child ? t('A subagent is running {{tool}}', { tool }) : t('Running {{tool}}', { tool });
  }
  if (blocker.kind === 'background') {
    return child
      ? t('A subagent still has a background command running')
      : t('A background command is still running');
  }
  if (blocker.kind === 'reply') {
    return child ? t('A subagent is writing a reply') : t('Writing a reply');
  }
  if (blocker.kind === 'starting') {
    return child ? t('A subagent is opening the session') : t('Opening the session');
  }
  return child ? t('A subagent is finishing the turn') : t('Finishing the turn');
}

function BlockerList({ blockers }: { blockers?: RestartBlocker[] }) {
  const { t } = useI18n();
  const conversations = useSessionsStore((state) => state.conversations);
  if (!blockers?.length) return null;
  const shown = blockers.slice(0, BLOCKER_LIMIT);
  const rest = blockers.length - shown.length;
  return (
    <ul className="mt-2 space-y-0.5 text-left text-xs text-muted-foreground">
      {shown.map((blocker) => {
        const { title, child } = blockerTitle(conversations, blocker.sessionId);
        return (
          <li key={blocker.sessionId}>
            {title} — {blockerReason(t, blocker, child)}
          </li>
        );
      })}
      {rest > 0 ? <li>{t('{{count}} more sessions', { count: rest })}</li> : null}
    </ul>
  );
}

/**
 * 重启 / 安装更新 / 退出的弹层，Main 推送状态：点「重启」立刻是「正在重启」；有命令在跑改成等命令，
 * 按等完要做什么（exit）换说明，命令自然结束时 Main 先关弹层（重启切回「正在重启」）再往下走。
 * 「强制退出」不等命令，立刻照原路径退出（重开 / 安装 / 退出；Main 照常尽量落断点与恢复清单）。
 * 等命令时可最小化成更新横幅位置的小条（RestartWaitStrip），点小条恢复。
 * 新实例有会话要续跑时显示「正在恢复会话」，恢复完成或到上限由 Main 关掉。只在本机主窗口显示。
 */
export function RestartWaitDialog() {
  const { t } = useI18n();
  const { state, shown, forcing, minimized } = useRestartOverlayStore();
  useEffect(() => {
    if (window.electronAPI.remote) return;
    let pushed = false;
    const off = window.electronAPI.app.onRestartWaiting((next) => {
      pushed = true;
      applyOverlay(next, true);
    });
    // 启动时 Main 的推送可能早于订阅：挂载时补取一次，已收到推送就以推送为准
    void window.electronAPI.app.getRestartWaiting().then((initial) => {
      if (!pushed) applyOverlay(initial, false);
    });
    return off;
  }, []);
  const waiting = shown.phase === 'waiting';
  const reply = waiting && shown.reason === 'reply';
  return (
    <AlertDialog open={state !== null && !minimized}>
      <AlertDialogPopup className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            <Spinner className="size-4 text-muted-foreground" />
            {waiting
              ? t(
                  reply
                    ? 'Waiting for the current reply to finish'
                    : 'Waiting for the current command to finish'
                )
              : shown.phase === 'resuming'
                ? t('Restoring sessions…')
                : t('Restarting EnsoCode…')}
          </AlertDialogTitle>
          {waiting && (
            <>
              <AlertDialogDescription>
                {reply
                  ? t(
                      'A session is still writing its reply. EnsoCode waits up to {{minutes}} minutes; if it stops producing output for more than {{idle}} seconds, it is stopped first and continues automatically after the restart.',
                      { minutes: QUIT_REPLY_WAIT_CAP_MS / 60_000, idle: QUIT_REPLY_IDLE_MS / 1000 }
                    )
                  : t(EXIT_NOTES[shown.exit])}
                {shown.reason === 'background-not-detachable' && (
                  <>
                    {' '}
                    {t(
                      'A command moved to the background cannot keep running without EnsoCode (for example a remote or Windows command), so EnsoCode waits for it.'
                    )}
                  </>
                )}
              </AlertDialogDescription>
              <BlockerList blockers={shown.blockers} />
            </>
          )}
        </AlertDialogHeader>
        {waiting && (
          <AlertDialogFooter variant="bare">
            <Button variant="ghost" size="sm" onClick={() => setMinimized(true)}>
              {t('Minimize')}
            </Button>
            <Button variant="destructive" size="sm" disabled={forcing} onClick={forceQuit}>
              {t('Force quit')}
            </Button>
          </AlertDialogFooter>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** 最小化后的等待条：与更新横幅同位置同样式，点文字或展开按钮恢复弹层 */
export function RestartWaitStrip() {
  const { t } = useI18n();
  const reduceMotion = usePrefersReducedMotion();
  const { state, forcing, minimized } = useRestartOverlayStore();
  const show = Boolean(minimized) && state?.phase === 'waiting';
  return (
    <AnimatePresence initial={false}>
      {show && state && (
        <motion.div
          key="restart-wait-strip"
          variants={reduceMotion ? heightVariantsReduced : heightVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="overflow-hidden"
        >
          <BannerBar>
            <Spinner className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            <button
              type="button"
              onClick={() => setMinimized(false)}
              className="min-w-0 flex-1 truncate text-left"
            >
              {t(EXIT_STRIPS[state.exit])}
              {state.blockers?.length
                ? t(' · waiting for {{count}} sessions', { count: state.blockers.length })
                : ''}
            </button>
            <button
              type="button"
              disabled={forcing}
              onClick={forceQuit}
              className="shrink-0 rounded-md bg-destructive px-2.5 py-1 text-white transition-colors hover:bg-destructive/90 disabled:opacity-60"
            >
              {t('Force quit')}
            </button>
            <button
              type="button"
              onClick={() => setMinimized(false)}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              title={t('Expand')}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </BannerBar>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
