import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BotMessageSquare, SquareTerminal } from 'lucide-react';
import { type KeyboardEvent, useId, useRef } from 'react';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, formatBinding } from '@/lib/keybindings';
import { springStandard } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useBotPendingCount } from '@/stores/bots';
import { type AppMode, useAppModeStore } from '@/stores/bots/mode';
import { useSettingsStore } from '@/stores/settings';
import { CountBadge } from './BotSidebar';

const OPTIONS: readonly { value: AppMode; label: string; Icon: typeof SquareTerminal }[] = [
  { value: 'code', label: 'Code', Icon: SquareTerminal },
  { value: 'bot', label: 'Bot', Icon: BotMessageSquare },
];

const ARROW_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

// transitions.dev 03-notification-badge：斜向滑入 + 数字弹出
const BADGE_SLIDE = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;
const BADGE_POP = { duration: 0.5, ease: [0.34, 1.36, 0.64, 1] } as const;
const BADGE_CLOSE = { duration: 0.18, ease: [0.4, 0, 0.2, 1] } as const;

/** 标题栏 Code | Bot 分段控件；Code 模式下 Bot 段显示待处理数 */
export function ModeSwitch({ className }: { className?: string }) {
  const { t } = useI18n();
  const mode = useAppModeStore((s) => s.mode);
  const setMode = useAppModeStore((s) => s.setMode);
  const pending = useBotPendingCount();
  const binding = effectiveKeybindings(useSettingsStore((s) => s.keybindings))['toggle-app-mode'];
  const hint = binding
    ? `${t('Switch between Code and Bot')} (${formatBinding(binding)})`
    : undefined;
  const reduceMotion = useReducedMotion() ?? false;
  const pillId = useId();
  const refs = useRef<Partial<Record<AppMode, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent) => {
    const step = ARROW_STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const index = OPTIONS.findIndex((option) => option.value === mode);
    const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length].value;
    setMode(next);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={t('Switch mode')}
      onKeyDown={onKeyDown}
      className={cn('flex h-7 shrink-0 rounded-lg bg-muted/60 p-0.5 text-xs', className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mode === value;
        const badge = value === 'bot' && mode === 'code' && pending > 0;
        return (
          <button
            key={value}
            ref={(el) => {
              refs.current[value] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={hint}
            onClick={() => setMode(value)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                aria-hidden
                className="absolute inset-0 rounded-md bg-background shadow-xs"
                transition={reduceMotion ? { duration: 0 } : springStandard}
              />
            )}
            <Icon className="relative h-3.5 w-3.5" />
            <span className="relative">{label}</span>
            <AnimatePresence>
              {badge && (
                <motion.span
                  className="-top-1.5 -right-1.5 pointer-events-none absolute"
                  initial={reduceMotion ? false : { x: -8, y: 12 }}
                  animate={{ x: 0, y: 0 }}
                  transition={BADGE_SLIDE}
                >
                  <motion.span
                    className="block"
                    initial={reduceMotion ? false : { scale: 0, opacity: 0, filter: 'blur(2px)' }}
                    animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                    exit={
                      reduceMotion
                        ? { opacity: 0, transition: { duration: 0 } }
                        : { scale: 0, opacity: 0, filter: 'blur(2px)', transition: BADGE_CLOSE }
                    }
                    transition={BADGE_POP}
                  >
                    <CountBadge count={pending} className="block" />
                  </motion.span>
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        );
      })}
    </div>
  );
}
