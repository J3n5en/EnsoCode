export type ActiveNode = 'local' | string;

export interface NodeLayerHost<V> {
  create(nodeId: string): V;
  /** null = 本机 workbench；实现负责只露出这一层并把焦点给它 */
  show(view: V | null): void;
  destroy(view: V): void;
}

/**
 * 主窗口里的远程节点界面层：本机 workbench 垫在最底，每个节点至多一层。
 * 切走只隐藏不卸载，再切回是同一个 renderer；节点删除或窗口关闭才销毁。
 */
export class NodeLayers<V> {
  private current: ActiveNode = 'local';
  private readonly views = new Map<string, V>();

  constructor(
    private readonly host: NodeLayerHost<V>,
    private readonly onChange: (active: ActiveNode) => void
  ) {}

  get active(): ActiveNode {
    return this.current;
  }

  view(nodeId: string): V | undefined {
    return this.views.get(nodeId);
  }

  all(): V[] {
    return [...this.views.values()];
  }

  switchTo(target: ActiveNode): void {
    let view: V | null = null;
    if (target !== 'local') {
      view = this.views.get(target) ?? null;
      if (!view) {
        view = this.host.create(target);
        this.views.set(target, view);
      }
    }
    this.host.show(view);
    if (this.current === target) return;
    this.current = target;
    this.onChange(target);
  }

  drop(nodeId: string): void {
    if (this.current === nodeId) this.switchTo('local');
    const view = this.views.get(nodeId);
    if (!view) return;
    this.views.delete(nodeId);
    this.host.destroy(view);
  }

  /** 窗口已关闭：不再 show，只销毁并回到本机 */
  reset(): void {
    const views = this.all();
    this.views.clear();
    for (const view of views) this.host.destroy(view);
    if (this.current === 'local') return;
    this.current = 'local';
    this.onChange('local');
  }
}
