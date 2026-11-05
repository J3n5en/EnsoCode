import type { RemoteNodeStatus } from '@shared/types/nodes';
import { Check, ChevronsUpDown, Laptop, Monitor, Plus } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { PairNodeDialog } from './PairNodeDialog';

/** 节点在线状态点：绿 = 对方在线；黄 = 连上中继但对方不在；灰 = 未连上中继 */
export function NodeDot({ node, className }: { node: RemoteNodeStatus; className?: string }) {
  const { t } = useI18n();
  const tone = node.hostOnline
    ? 'bg-emerald-500'
    : node.connected
      ? 'bg-amber-500'
      : 'bg-muted-foreground/40';
  const title = node.hostOnline
    ? t('Online')
    : node.connected
      ? t('Remote desktop is offline')
      : t('Connecting…');
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', tone, className)} title={title} />;
}

/** 侧栏底部的节点切换：本机 / 已连节点 / 连接新节点 */
export function NodeSwitcher() {
  const { t } = useI18n();
  const nodes = useRemoteNodesStore((s) => s.nodes);
  const activeNodeId = useRemoteNodesStore((s) => s.activeNodeId);
  const switchNode = useRemoteNodesStore((s) => s.switchNode);
  const [open, setOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);

  const active = activeNodeId === 'local' ? null : nodes.find((n) => n.nodeId === activeNodeId);
  const label = active ? active.label : t('This computer');
  const Icon = active ? Monitor : Laptop;
  const subtitle = active
    ? active.hostname && active.hostname !== active.label
      ? active.hostname
      : active.hostOnline
        ? t('Online')
        : active.connected
          ? t('Remote desktop is offline')
          : t('Connecting…')
    : nodes.length > 0
      ? t('{{n}} remote', { n: nodes.length })
      : undefined;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-foreground/5 data-popup-open:bg-foreground/5"
          title={t('Switch node')}
        >
          <span className="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs ring-1 ring-border">
            <Icon className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-[0.9286rem] text-foreground leading-4">
              <span className="truncate">{label}</span>
              {active && <NodeDot node={active} />}
            </span>
            {subtitle && (
              <span className="truncate text-[0.7857rem] text-subtle-foreground leading-3.5">
                {subtitle}
              </span>
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          className="w-60 [&_[data-slot=popover-viewport]]:p-1"
        >
          <NodeOption
            selected={activeNodeId === 'local'}
            icon={<Laptop className="h-3.5 w-3.5 shrink-0" />}
            label={t('This computer')}
            onClick={() => {
              switchNode('local');
              setOpen(false);
            }}
          />
          {nodes.map((node) => (
            <NodeOption
              key={node.nodeId}
              selected={node.nodeId === activeNodeId}
              icon={<NodeDot node={node} className="mx-0.5" />}
              label={node.label}
              hint={node.hostname && node.hostname !== node.label ? node.hostname : undefined}
              onClick={() => {
                switchNode(node.nodeId);
                setOpen(false);
              }}
            />
          ))}
          <div className="my-1 border-t" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPairOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('Connect to a node…')}</span>
          </button>
        </PopoverPopup>
      </Popover>
      <PairNodeDialog open={pairOpen} onOpenChange={setPairOpen} />
    </>
  );
}

function NodeOption({
  selected,
  icon,
  label,
  hint,
  onClick,
}: {
  selected: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        selected
          ? 'bg-brand/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && <span className="ml-1.5 text-[10px] text-muted-foreground">{hint}</span>}
      </span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
    </button>
  );
}
