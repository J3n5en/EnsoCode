import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface NavRailItem {
  key: string;
  question: string;
  answer: string;
}

interface NavRailProps {
  items: NavRailItem[];
  activeKey: string | null;
  onJump: (key: string) => void;
}

/** Codex 风格的轮次快速导航条：每条 user 轮次一条小横线，hover 预览问答，点击跳转 */
export function NavRail({ items, activeKey, onJump }: NavRailProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (items.length < 2) return null;

  return (
    <div className="absolute top-1/2 left-2 z-10 -translate-y-1/2">
      <div className="relative flex max-h-[60vh] flex-col justify-center gap-[5px]">
        {items.map((item, index) => {
          const active = item.key === activeKey;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onJump(item.key)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(null)}
              className="group flex h-[7px] items-center"
            >
              <span
                className={cn(
                  'rounded-full transition-all',
                  active
                    ? 'h-[3px] w-7 bg-foreground'
                    : 'h-[2px] w-4 bg-muted-foreground/35 group-hover:w-6 group-hover:bg-muted-foreground/70'
                )}
              />
            </button>
          );
        })}

        {hoverIndex !== null && (
          <div
            className="pointer-events-none absolute left-10 w-72 -translate-y-1/2 rounded-xl border bg-popover p-3 shadow-lg"
            style={{ top: `${((hoverIndex + 0.5) / items.length) * 100}%` }}
          >
            <p className="line-clamp-2 text-xs font-semibold">{items[hoverIndex].question}</p>
            {items[hoverIndex].answer && (
              <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                {items[hoverIndex].answer}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
