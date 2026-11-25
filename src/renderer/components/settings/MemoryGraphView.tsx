import type { MemoryBriefDto, MemoryGraphDto } from '@shared/memory/graphDto';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsPreview } from './kit';
import { buildLegend, graphStylesheet, toElements } from './memoryGraphStyle';

/**
 * 知识图谱：cytoscape + fcose 力导向布局。
 * 交互（拖拽节点、滚轮缩放、框选）由 cytoscape 提供；这里只负责数据同步、
 * 选中高亮和主题色。
 */

let registered = false;
function ensureLayout(): void {
  if (registered) return;
  cytoscape.use(fcose);
  registered = true;
}

const LAYOUT = {
  name: 'fcose',
  animate: false,
  randomize: false,
  // 提及数多的节点更"重"，自然沉到中心
  nodeRepulsion: 8000,
  idealEdgeLength: 90,
  nodeSeparation: 90,
  padding: 24,
  fit: true,
} as unknown as cytoscape.LayoutOptions;

export function MemoryGraphView({
  graph,
  selectedId,
  onSelect,
  memories,
  loading,
  onInterpret,
  interpreting,
}: {
  graph: MemoryGraphDto;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  memories: MemoryBriefDto[];
  loading: boolean;
  onInterpret: (entityId: string) => void;
  interpreting: boolean;
}) {
  const { t } = useI18n();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const cyRef = React.useRef<cytoscape.Core | null>(null);
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const [typeFilter, setTypeFilter] = React.useState<string | null>(null);

  const dark = React.useMemo(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    []
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || graph.nodes.length === 0) return;
    ensureLayout();
    const cy = cytoscape({
      container: host,
      elements: toElements(graph.nodes, graph.edges, dark),
      style: graphStylesheet(dark),
      minZoom: 0.2,
      maxZoom: 2.5,
      wheelSensitivity: 0.2,
    });
    cy.layout(LAYOUT).run();
    cy.on('tap', 'node', (event) => onSelectRef.current(event.target.id() as string));
    // 点空白处取消选中
    cy.on('tap', (event) => {
      if (event.target === cy) onSelectRef.current(null);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph.nodes, graph.edges, dark]);

  // 选中时把非邻居淡出——这是图谱唯一真正有用的交互
  React.useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('dimmed').unselect();
      if (!selectedId) return;
      const node = cy.getElementById(selectedId);
      if (node.empty()) return;
      const keep = node.closedNeighborhood();
      cy.elements().difference(keep).addClass('dimmed');
      node.select();
    });
  }, [selectedId]);

  const legend = React.useMemo(() => buildLegend(graph.nodes, dark), [graph.nodes, dark]);
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  // 点图例只高亮该类型，不改变选中的实体
  React.useEffect(() => {
    const cy = cyRef.current;
    if (!cy || selectedId) return;
    cy.batch(() => {
      cy.elements().removeClass('dimmed');
      if (!typeFilter) return;
      cy.nodes()
        .filter((n) => n.data('entityType') !== typeFilter)
        .addClass('dimmed');
    });
  }, [typeFilter, selectedId]);

  if (graph.nodes.length === 0) {
    return (
      <p className="py-6 text-[13px] text-muted-foreground">
        {loading
          ? t('Loading…')
          : t('No entities yet. Turn on entity extraction and store a few memories first.')}
      </p>
    );
  }

  return (
    <div className="space-y-3 pt-3">
      <SettingsPreview className="relative overflow-hidden bg-muted/20">
        <div ref={hostRef} className="h-[440px] w-full" />
        <div className="absolute right-2 bottom-2 flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => cyRef.current?.fit(undefined, 24)}
            title={t('Fit to view')}
          >
            {t('Fit')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => cyRef.current?.layout(LAYOUT).run()}
            title={t('Re-run layout')}
          >
            {t('Relayout')}
          </Button>
        </div>
      </SettingsPreview>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          {t('Colour = entity type · size = how many memories mention it', {})}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {legend.map((entry) => (
            <button
              key={entry.entityType}
              type="button"
              onClick={() =>
                setTypeFilter(typeFilter === entry.entityType ? null : entry.entityType)
              }
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors',
                typeFilter === entry.entityType ? 'bg-accent' : 'bg-muted/60 hover:bg-accent/60'
              )}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-muted-foreground">{entry.entityType.toLowerCase()}</span>
              <span className="tabular-nums">{entry.count}</span>
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {t('{{shown}} of {{total}} entities', {
            shown: String(graph.nodes.length),
            total: String(graph.totalEntities),
          })}
        </p>
      </div>

      {selected && (
        <section className="space-y-2 border-border border-t pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{selected.name}</span>
                <Badge variant="secondary">{selected.entityType}</Badge>
              </p>
              <p className="text-muted-foreground text-xs">
                {t('{{count}} memories · {{space}}', {
                  count: String(selected.memoryCount),
                  space: selected.spaceLabel,
                })}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={interpreting}
              onClick={() => onInterpret(selected.id)}
            >
              {interpreting ? t('Interpreting…') : t('Interpret')}
            </Button>
          </div>
          <ul className="divide-y border-border border-y">
            {memories.length === 0 && (
              <li className="py-4 text-[13px] text-muted-foreground">{t('Loading…')}</li>
            )}
            {memories.map((m) => (
              <li key={m.id} className="space-y-0.5 py-2">
                <p className="flex items-center gap-2 text-sm">
                  {m.isCrystal && <span title={t('Crystal')}>★</span>}
                  <span className="truncate">{m.title}</span>
                  <Badge variant="secondary">{m.unitType}</Badge>
                </p>
                <p className="line-clamp-2 text-muted-foreground text-xs">{m.contentSummary}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
