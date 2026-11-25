import type {
  WorkflowDesign,
  WorkflowDesignPhase,
  WorkflowDesignStep,
  WorkflowPresetArg,
} from '@shared/types/workflow';
import {
  insertPlaceholder,
  type PlaceholderToken,
  placeholderTokens,
  splitPromptPlaceholders,
} from '@shared/workflowDesign';
import { ArrowLeft, ArrowRight, Braces, Flag, Play, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { SettingsPreview } from './kit';
import {
  addStep,
  canAddStep,
  clampSelection,
  type DesignSelection,
  insertPhase,
  movePhase,
  removeSelected,
} from './workflowDesignOps';

/** Select 不适合空串值，用哨兵表示「默认类型」 */
const DEFAULT_TYPE = '__default__';

export const newDesignStep = (agentType = 'scout'): WorkflowDesignStep => ({
  label: '',
  agentType,
  prompt: '',
});

/** 提示词框 + 「插入参数」菜单：占位符插在光标处，插入后光标落在占位符之后 */
function PromptField({
  value,
  tokens,
  args,
  onChange,
}: {
  value: string;
  tokens: PlaceholderToken[];
  args: WorkflowPresetArg[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const textarea = () => wrapRef.current?.querySelector('textarea') ?? null;
  const insert = (token: string) => {
    const el = textarea();
    const end = value.length;
    const next = insertPlaceholder(
      value,
      el?.selectionStart ?? end,
      el?.selectionEnd ?? end,
      token
    );
    onChange(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const labelOf = (token: PlaceholderToken) =>
    token.kind === 'prev'
      ? t('Previous phase output')
      : args.find((arg) => arg.key.trim() === token.key)?.label.trim() || token.key;

  return (
    <div ref={wrapRef} className="space-y-1">
      <Textarea
        rows={5}
        className="text-xs"
        placeholder={t('Prompt')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Menu>
        <MenuTrigger
          disabled={tokens.length === 0}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Braces className="h-3.5 w-3.5" />
          {t('Insert argument')}
        </MenuTrigger>
        <MenuPopup align="start" zIndex={Z_INDEX.DROPDOWN_IN_MODAL} finalFocus={textarea}>
          {tokens.map((token) => (
            <MenuItem key={token.token} onClick={() => insert(token.token)}>
              {labelOf(token)}
              <span className="ml-auto pl-4 font-mono text-muted-foreground text-xs">
                {token.token}
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** 贝塞尔连线，水平出入 */
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max((x2 - x1) / 2, 8);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};

/**
 * 量 DOM 位置画连线：上一列每个节点汇到间隙里的汇合点，再扇出到下一列每个节点。
 * 除以缩放系数，对话框缩放入场动画期间量到的坐标也对。
 */
function usePipelineEdges(
  ref: React.RefObject<HTMLDivElement | null>,
  design: WorkflowDesign
): { d: string; arrow: boolean }[] {
  const [edges, setEdges] = React.useState<{ d: string; arrow: boolean }[]>([]);
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const base = root.getBoundingClientRect();
      const scale = root.offsetWidth ? base.width / root.offsetWidth : 1;
      const box = (selector: string) => {
        const rect = root.querySelector(selector)?.getBoundingClientRect();
        if (!rect) return null;
        return {
          left: (rect.left - base.left) / scale,
          right: (rect.right - base.left) / scale,
          y: (rect.top - base.top + rect.height / 2) / scale,
        };
      };
      const column = (index: number, edge: 'start' | 'end') =>
        index < 0 || index >= design.phases.length
          ? [`[data-node="${edge}"]`]
          : (design.phases[index]?.steps ?? []).map((_, si) => `[data-node="s-${index}-${si}"]`);
      const next: { d: string; arrow: boolean }[] = [];
      for (let gap = 0; gap <= design.phases.length; gap++) {
        const junction = box(`[data-gap="${gap}"]`);
        if (!junction) continue;
        for (const selector of column(gap - 1, 'start')) {
          const from = box(selector);
          if (from)
            next.push({ d: curve(from.right, from.y, junction.left, junction.y), arrow: false });
        }
        for (const selector of column(gap, 'end')) {
          const to = box(selector);
          if (to)
            next.push({ d: curve(junction.right, junction.y, to.left - 2, to.y), arrow: true });
        }
      }
      setEdges(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, design]);
  return edges;
}

function Terminal({
  node,
  icon,
  title,
  detail,
}: {
  node: 'start' | 'end';
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div
      data-node={node}
      className="flex w-24 shrink-0 flex-col items-center gap-0.5 rounded-full bg-background px-3 py-1.5 text-center shadow-xs ring-1 ring-border"
    >
      <span className="flex items-center gap-1 font-medium text-xs">
        {icon}
        {title}
      </span>
      <span className="w-full truncate text-[10px] text-muted-foreground">{detail}</span>
    </div>
  );
}

/** 节点里的提示词摘要：占位符渲染成参数名标签 */
function PromptPreview({ prompt, args }: { prompt: string; args: WorkflowPresetArg[] }) {
  const { t } = useI18n();
  const parts = splitPromptPlaceholders(prompt.trim());
  if (parts.length === 0) return <>{t('No prompt yet')}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 片段按位置渲染，无身份
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 片段按位置渲染，无身份
            key={i}
            className="rounded bg-primary/10 px-1 font-medium text-primary"
          >
            {part.kind === 'prev'
              ? t('Previous phase output')
              : args.find((arg) => arg.key.trim() === part.key)?.label.trim() || part.key}
          </span>
        )
      )}
    </>
  );
}

export function WorkflowDesigner({
  design,
  agentTypes,
  args,
  onChange,
}: {
  design: WorkflowDesign;
  agentTypes: string[];
  args: WorkflowPresetArg[];
  onChange: (design: WorkflowDesign) => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = React.useState<DesignSelection>({
    kind: 'step',
    phase: 0,
    step: 0,
  });
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const markerId = React.useId();
  const edges = usePipelineEdges(canvasRef, design);
  const phases = design.phases;
  const selected = clampSelection(design, selection);
  const selectedPhase = phases[selected.phase];
  const selectedStep = selected.kind === 'step' ? selectedPhase?.steps[selected.step] : undefined;
  const defaultType = agentTypes.includes('scout') ? 'scout' : '';
  const argKeys = args.map((arg) => arg.key.trim()).filter(Boolean);
  const canAdd = canAddStep(design);
  const removable = removeSelected(design, selected) !== null;

  const apply = (edit: { design: WorkflowDesign; selection: DesignSelection } | null) => {
    if (!edit) return;
    onChange(edit.design);
    setSelection(edit.selection);
  };
  const patchPhase = (next: Partial<WorkflowDesignPhase>) =>
    onChange({
      phases: phases.map((phase, i) => (i === selected.phase ? { ...phase, ...next } : phase)),
    });
  const patchStep = (next: Partial<WorkflowDesignStep>) =>
    selected.kind === 'step' &&
    patchPhase({
      steps: (selectedPhase?.steps ?? []).map((step, i) =>
        i === selected.step ? { ...step, ...next } : step
      ),
    });
  const typeItems = (current: string) => {
    const names = current && !agentTypes.includes(current) ? [...agentTypes, current] : agentTypes;
    return [
      { value: DEFAULT_TYPE, label: t('Default (worker)') },
      ...names.map((name) => ({ value: name, label: name })),
    ];
  };

  const gap = (index: number) => (
    <div className="flex w-10 shrink-0 items-center justify-center self-stretch">
      <button
        type="button"
        data-gap={index}
        disabled={!canAdd}
        aria-label={t('Insert phase here')}
        title={t('Insert phase here')}
        onClick={() =>
          apply(insertPhase(design, index, { title: '', steps: [newDesignStep(defaultType)] }))
        }
        className="relative z-30 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border transition-colors hover:text-primary hover:ring-primary disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );

  return (
    <div className="w-full space-y-2">
      <SettingsPreview className="overflow-x-auto bg-muted/30">
        <div
          ref={canvasRef}
          className="relative flex w-max min-w-full items-center justify-center px-3 py-5"
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible text-muted-foreground/50"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((edge) => (
              <path
                key={edge.d}
                d={edge.d}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                markerEnd={edge.arrow ? `url(#${markerId})` : undefined}
              />
            ))}
          </svg>
          <Terminal
            node="start"
            icon={<Play className="h-3 w-3" />}
            title={t('Start')}
            detail={argKeys.length > 0 ? argKeys.join(', ') : t('No arguments')}
          />
          {phases.map((phase, pi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 阶段无稳定 id，内容全受控
            <React.Fragment key={pi}>
              {gap(pi)}
              <div
                className={cn(
                  'flex w-44 shrink-0 flex-col gap-1.5 rounded-xl bg-background/60 p-2 ring-1 ring-border',
                  selected.kind === 'phase' && selected.phase === pi && 'ring-2 ring-primary'
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelection({ kind: 'phase', phase: pi })}
                  className={cn(
                    'flex min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] hover:text-foreground',
                    phase.title.trim() ? 'text-muted-foreground' : 'text-destructive'
                  )}
                >
                  <span className="shrink-0">{t('Phase {{n}}', { n: pi + 1 })}</span>
                  <span className="truncate font-medium text-foreground">
                    {phase.title.trim() || t('Untitled phase')}
                  </span>
                </button>
                {phase.steps.map((step, si) => {
                  const active =
                    selected.kind === 'step' && selected.phase === pi && selected.step === si;
                  const invalid = !step.label.trim() || !step.prompt.trim();
                  return (
                    <button
                      // biome-ignore lint/suspicious/noArrayIndexKey: 步骤无稳定 id，内容全受控
                      key={si}
                      type="button"
                      data-node={`s-${pi}-${si}`}
                      onClick={() => setSelection({ kind: 'step', phase: pi, step: si })}
                      className={cn(
                        'block w-full rounded-lg bg-background px-2.5 py-1.5 text-left shadow-xs ring-1 ring-border transition-colors hover:ring-primary/60',
                        active && 'ring-2 ring-primary',
                        invalid && !active && 'ring-destructive/50'
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-xs">
                          {step.label.trim() || t('Untitled step')}
                        </span>
                        <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {step.agentType || 'worker'}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground">
                        <PromptPreview prompt={step.prompt} args={args} />
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={!canAdd}
                  onClick={() => apply(addStep(design, pi, newDesignStep(defaultType)))}
                  className="flex items-center justify-center gap-1 rounded-lg py-1 text-[11px] text-muted-foreground ring-1 ring-border transition-colors hover:text-primary hover:ring-primary disabled:pointer-events-none disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {t('Parallel step')}
                </button>
              </div>
            </React.Fragment>
          ))}
          {gap(phases.length)}
          <Terminal
            node="end"
            icon={<Flag className="h-3 w-3" />}
            title={t('Result')}
            detail={t('Last phase output')}
          />
        </div>
      </SettingsPreview>

      <div className="space-y-2 border-border border-t pt-3">
        <div className="flex items-center gap-1">
          <span className="font-medium text-xs">
            {selected.kind === 'phase'
              ? t('Phase {{n}}', { n: selected.phase + 1 })
              : t('Phase {{n}} · Step {{m}}', { n: selected.phase + 1, m: selected.step + 1 })}
          </span>
          <span className="ml-auto flex items-center">
            {selected.kind === 'phase' && (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Move left')}
                  disabled={selected.phase === 0}
                  onClick={() => apply(movePhase(design, selected.phase, -1))}
                >
                  <ArrowLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Move right')}
                  disabled={selected.phase === phases.length - 1}
                  onClick={() => apply(movePhase(design, selected.phase, 1))}
                >
                  <ArrowRight />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('Delete')}
              disabled={!removable}
              onClick={() => apply(removeSelected(design, selected))}
            >
              <Trash2 />
            </Button>
          </span>
        </div>
        {selected.kind === 'phase' || !selectedStep ? (
          <Input
            size="sm"
            placeholder={t('Phase title')}
            value={selectedPhase?.title ?? ''}
            onChange={(e) => patchPhase({ title: e.target.value })}
          />
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <Input
                size="sm"
                className="min-w-0 flex-1"
                placeholder={t('Label')}
                value={selectedStep.label}
                onChange={(e) => patchStep({ label: e.target.value })}
              />
              <Select
                items={typeItems(selectedStep.agentType)}
                value={selectedStep.agentType || DEFAULT_TYPE}
                onValueChange={(value) =>
                  patchStep({ agentType: value === DEFAULT_TYPE ? '' : String(value ?? '') })
                }
              >
                <SelectTrigger size="sm" className="w-36 min-w-0 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {typeItems(selectedStep.agentType).map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <PromptField
              value={selectedStep.prompt}
              tokens={placeholderTokens(argKeys, selected.phase)}
              args={args}
              onChange={(prompt) => patchStep({ prompt })}
            />
          </>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(
          'Click a node to edit it. Steps in a column run in parallel; columns run from left to right.'
        )}
      </p>
    </div>
  );
}
