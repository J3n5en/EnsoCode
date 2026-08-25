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

/** 最多同时显示的条数；超出时以当前轮次为中心取滑动窗口，保持条子可点尺寸 */
const MAX_BARS = 40;

/** Codex 风格的轮次快速导航条：每条 user 轮次一条小横线，hover 预览问答，点击跳转 */
export function NavRail({ items, activeKey, onJump }: NavRailProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (items.length < 2) return null;

  // 轮次超过容量时，以 active 为中心截取窗口；首尾渐隐提示还有更多
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey)
  );
  const start = Math.min(
    Math.max(0, activeIndex - Math.floor(MAX_BARS / 2)),
    Math.max(0, items.length - MAX_BARS)
  );
  const visible = items.slice(start, start + MAX_BARS);
  const clippedTop = start > 0;
  const clippedBottom = start + MAX_BARS < items.length;

  /** Dock 式波浪：hover 处最长，按距离衰减回基础长度 */
  const widthOf = (index: number, active: boolean): number => {
    const base = active ? 24 : 12;
    if (hoverIndex === null) return base;
    const distance = Math.abs(index - hoverIndex);
    const boost = Math.max(0, 16 - distance * 6);
    return base + boost;
  };

  return (
    // 默认隐藏：鼠标进入左缘感应带才淡入；容器宽不足（对话区顶满）时整体不显示，
    // 阈值 = 列宽 42rem + 两侧留白，由父级 @container 提供查询上下文
    <div className="group/rail absolute top-0 left-0 z-10 hidden h-full w-14 @min-[52rem]:block">
      <div
        className="absolute top-1/2 left-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <div
          className="relative flex flex-col justify-center gap-[5px]"
          style={{
            maskImage:
              clippedTop || clippedBottom
                ? `linear-gradient(to bottom, ${clippedTop ? 'transparent, black 24px' : 'black'}, ${clippedBottom ? 'black calc(100% - 24px), transparent' : 'black'})`
                : undefined,
          }}
        >
          {visible.map((item, index) => {
            const active = item.key === activeKey;
            const hovered = index === hoverIndex;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onJump(item.key)}
                onMouseEnter={() => setHoverIndex(index)}
                className="flex h-[7px] items-center"
              >
                <span
                  className={cn(
                    'rounded-full transition-all duration-150',
                    active || hovered ? 'h-[3px] bg-foreground' : 'h-[2px] bg-muted-foreground/40'
                  )}
                  style={{ width: widthOf(index, active) }}
                />
              </button>
            );
          })}

          {hoverIndex !== null && visible[hoverIndex] && (
            <div
              className="pointer-events-none absolute left-10 w-72 -translate-y-1/2 rounded-xl border bg-popover p-3 shadow-lg"
              style={{ top: `${((hoverIndex + 0.5) / visible.length) * 100}%` }}
            >
              <p className="line-clamp-2 text-xs font-semibold">{visible[hoverIndex].question}</p>
              {visible[hoverIndex].answer && (
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                  {visible[hoverIndex].answer}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
