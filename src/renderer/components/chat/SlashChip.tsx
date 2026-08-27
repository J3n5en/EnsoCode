import { SlashSquare, Sparkles, Target, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type SlashKind = 'skill' | 'goal' | 'command';

export function slashKind(name: string): SlashKind {
  if (name.startsWith('/skill:')) return 'skill';
  if (name === '/goal') return 'goal';
  return 'command';
}

export function slashLabel(name: string): string {
  if (name.startsWith('/skill:')) return name.slice('/skill:'.length);
  return name.replace(/^\//, '');
}

/** 句首 /cmd 拆成胶囊名 + 其余正文 */
export function splitSlashCommand(text: string): { slash: string | null; rest: string } {
  const skill = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (skill) return { slash: `/skill:${skill[1]}`, rest: skill[2] ?? '' };
  const command = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (command) return { slash: `/${command[1]}`, rest: command[2] ?? '' };
  return { slash: null, rest: text };
}

const ICONS: Record<SlashKind, LucideIcon> = {
  skill: Sparkles,
  goal: Target,
  command: SlashSquare,
};

/** 浅底用实色字，避免 *-foreground 近白叠在 /15 底上看不清 */
const COLORS: Record<SlashKind, string> = {
  skill: 'bg-info/15 text-info',
  goal: 'bg-warning/25 text-warning-foreground dark:bg-warning/15 dark:text-warning',
  command: 'bg-foreground/10 text-foreground',
};

export function slashChipClass(kind: SlashKind, interactive = false): string {
  return cn(
    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-xs font-medium',
    COLORS[kind],
    interactive && kind === 'skill' && 'hover:bg-info/25',
    interactive && kind === 'goal' && 'hover:bg-warning/35 dark:hover:bg-warning/25',
    interactive && kind === 'command' && 'hover:bg-foreground/15'
  );
}

export function SlashChip({
  name,
  className,
  interactive = false,
  trailing,
}: {
  name: string;
  className?: string;
  interactive?: boolean;
  trailing?: ReactNode;
}) {
  const kind = slashKind(name);
  const Icon = ICONS[kind];
  return (
    <span className={cn(slashChipClass(kind, interactive), className)}>
      <Icon className="h-3 w-3" />
      {slashLabel(name)}
      {trailing}
    </span>
  );
}
