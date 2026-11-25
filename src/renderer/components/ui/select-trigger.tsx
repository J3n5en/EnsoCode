import { ChevronsUpDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SelectTriggerSize = 'sm' | 'default' | 'lg';

/** 下拉触发器外观；其他「点开选一项」的控件（如表单里的模型选择器）复用它，保持同一套样式 */
export function selectTriggerClassName(size: SelectTriggerSize = 'default'): string {
  return cn(
    "relative inline-flex min-h-9 w-full min-w-36 select-none items-center justify-between gap-2 rounded-lg border border-input bg-background bg-clip-padding px-[calc(--spacing(3)-1px)] text-left text-base shadow-xs outline-none ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-ring focus-visible:ring-[3px] aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-8 sm:text-sm dark:bg-input/32 dark:not-in-data-[slot=group]:bg-clip-border dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/8%)] [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-visible,[aria-invalid],[data-pressed]]:shadow-none",
    size === 'sm' && 'min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7',
    size === 'lg' && 'min-h-10 sm:min-h-9'
  );
}

/** 下拉右侧的 ⇕ 图标 */
export function SelectChevron() {
  return <ChevronsUpDownIcon className="-me-1 size-4.5 opacity-80 sm:size-4" />;
}
