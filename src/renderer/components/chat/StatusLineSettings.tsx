import type { StatusLinePresetId, StatusLineSegmentId } from '@shared/statusLine';
import {
  reorderStatusLineSegments,
  STATUS_LINE_PRESET_IDS,
  STATUS_LINE_PRESETS,
  STATUS_LINE_SEGMENT_IDS,
  statusLinePresetOf,
} from '@shared/statusLine';
import { GripVertical, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { SEGMENT_LABEL_KEYS, type SegmentValue, sanitizeStatusLineSegments } from './StatsLine';

interface StatusLineSettingsProps {
  /** 每段的 icon（全部 13 段恒有值，来自 StatsLine 的同一份计算） */
  icons: Record<StatusLineSegmentId, LucideIcon>;
  /** 每段当前格式化后的值，`undefined` = 该段暂无数据（完整 Record，不是 Partial） */
  values: Record<StatusLineSegmentId, SegmentValue | undefined>;
}

const PRESET_LABEL_KEYS: Record<StatusLinePresetId, string> = {
  minimal: 'Minimal',
  default: 'Default',
  full: 'Full',
};

/** 状态栏齿轮弹出的快捷设置：顶部三档预设切换 + 已启用段位可拖拽排序 + 未启用段位单独一栏。
 *  预设不进存储 —— 当前档位由 statusLinePresetOf（序列敏感）反推，手动 toggle 或拖拽排序
 *  都会让它落入「自定义」；「默认」按钮本身就等价于旧的 Reset to defaults，不重复留按钮。
 *  拖拽用原生 HTML5 DnD（⛔ 不引拖拽库）：只在已启用段位间排序 —— 关闭的段位本就不在
 *  `statusLineSegments` 数组里，不参与顺序，重新打开时按 store 语义 append 到末尾。 */
export function StatusLineSettings({ icons, values }: StatusLineSettingsProps) {
  const { t } = useI18n();
  // 渲染层第二道防线：persist 数据可能是非法 id/重复项，这里独立兜底，见 sanitizeStatusLineSegments
  const rawSegments = useSettingsStore((state) => state.statusLineSegments);
  const enabledSegments = useMemo(() => sanitizeStatusLineSegments(rawSegments), [rawSegments]);
  const toggleStatusLineSegment = useSettingsStore((state) => state.toggleStatusLineSegment);
  const setStatusLineSegments = useSettingsStore((state) => state.setStatusLineSegments);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);

  const activePreset = statusLinePresetOf(enabledSegments);
  const disabledSegments = STATUS_LINE_SEGMENT_IDS.filter((id) => !enabledSegments.includes(id));

  const resetDrag = () => {
    setDragIndex(null);
    setDropGap(null);
  };

  const commitDrop = () => {
    if (dragIndex !== null && dropGap !== null) {
      const to = dropGap > dragIndex ? dropGap - 1 : dropGap;
      const next = reorderStatusLineSegments(enabledSegments, dragIndex, to);
      if (next !== enabledSegments) setStatusLineSegments([...next]);
    }
    resetDrag();
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <div className="flex gap-1">
          {STATUS_LINE_PRESET_IDS.map((id) => (
            <Button
              key={id}
              variant={activePreset === id ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setStatusLineSegments([...STATUS_LINE_PRESETS[id]])}
            >
              {t(PRESET_LABEL_KEYS[id])}
            </Button>
          ))}
        </div>
        {activePreset === 'custom' && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{t('Custom')}</span>
        )}
      </div>

      <div
        className="max-h-80 overflow-y-auto p-2"
        onDragOver={(e) => {
          if (dragIndex !== null) e.preventDefault();
        }}
        onDrop={(e) => {
          if (dragIndex === null) return;
          e.preventDefault();
          commitDrop();
        }}
      >
        {enabledSegments.map((id, index) => {
          const Icon = icons[id];
          const value = values[id];
          return (
            <div key={id}>
              {dragIndex !== null && dropGap === index && (
                <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
              )}
              <div
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  setDropGap(before ? index : index + 1);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  commitDrop();
                }}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md px-2 py-1.5',
                  dragIndex === index && 'opacity-40'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', id);
                      setDragIndex(index);
                    }}
                    onDragEnd={resetDrag}
                    aria-label={t('Drag to reorder')}
                    className="shrink-0 cursor-grab text-muted-foreground/50 hover:text-foreground active:cursor-grabbing"
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm">{t(SEGMENT_LABEL_KEYS[id])}</span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {value?.full || t('No data yet')}
                    </span>
                  </div>
                </div>
                <Switch
                  checked
                  onCheckedChange={(checked) => toggleStatusLineSegment(id, checked)}
                />
              </div>
            </div>
          );
        })}
        {dragIndex !== null && dropGap === enabledSegments.length && (
          <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
        )}

        {disabledSegments.length > 0 && (
          <>
            <Separator className="my-2" />
            {disabledSegments.map((id) => {
              const Icon = icons[id];
              const value = values[id];
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {/* 未启用的段位不在 statusLineSegments 里、不参与排序，占位对齐把手宽度 */}
                    <span className="w-3.5 shrink-0" />
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm">{t(SEGMENT_LABEL_KEYS[id])}</span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {value?.full || t('No data yet')}
                      </span>
                    </div>
                  </div>
                  <Switch
                    checked={false}
                    onCheckedChange={(checked) => toggleStatusLineSegment(id, checked)}
                  />
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
