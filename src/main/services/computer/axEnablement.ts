/** 不打开就看不到网页内容 AX 树的 Chromium 浏览器；它们不认 AXManualAccessibility */
const CHROMIUM_BROWSERS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.dev',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Beta',
  'com.microsoft.edgemac.Dev',
  'com.brave.Browser',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  'company.thebrowser.Browser',
]);

export type AxEnablementAttribute = 'AXManualAccessibility' | 'AXEnhancedUserInterface';

/**
 * Electron 用 AXManualAccessibility；Chromium 浏览器只能用 AXEnhancedUserInterface。
 * 原生 AppKit 也接受后者，但它会改变窗口动画与布局行为，不对它们打开。
 */
export function axEnablementAttribute(input: {
  manualSettable: boolean;
  bundleId?: string;
}): AxEnablementAttribute | undefined {
  if (input.manualSettable) return 'AXManualAccessibility';
  if (input.bundleId && CHROMIUM_BROWSERS.has(input.bundleId)) return 'AXEnhancedUserInterface';
  return undefined;
}

export interface AxEnablementDeps {
  /** 打开目标的 AX 树；返回本次实际由我们从关改成开的属性 */
  enable(pid: number): Promise<{ changed: string[] }>;
  restore(pid: number, attrs: string[]): Promise<void>;
}

/** 有生命周期的 AX 打开声明：按 pid 打开一次，空闲后把我们改过的属性改回去。 */
export class AxEnablementRegistry {
  private readonly entries = new Map<
    number,
    { ready: Promise<string[]>; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly idleMs: number;

  constructor(
    private readonly deps: AxEnablementDeps,
    options: { idleMs?: number } = {}
  ) {
    this.idleMs = options.idleMs ?? 60_000;
  }

  /** 返回 true 表示本次刚把 AX 树打开（目标需要时间构建树） */
  async ensure(pid: number): Promise<boolean> {
    let entry = this.entries.get(pid);
    let fresh = false;
    if (!entry) {
      fresh = true;
      const ready = this.deps.enable(pid).then(
        (result) => result.changed,
        () => [] as string[]
      );
      entry = { ready };
      this.entries.set(pid, entry);
    }
    this.touch(pid);
    const changed = await entry.ready;
    return fresh && changed.length > 0;
  }

  private touch(pid: number): void {
    const entry = this.entries.get(pid);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.release(pid), this.idleMs);
    entry.timer.unref?.();
  }

  release(pid: number): void {
    const entry = this.entries.get(pid);
    if (!entry) return;
    this.entries.delete(pid);
    if (entry.timer) clearTimeout(entry.timer);
    void entry.ready.then((changed) => {
      if (changed.length === 0) return;
      return this.deps.restore(pid, changed).catch(() => {});
    });
  }

  releaseAll(): void {
    for (const pid of [...this.entries.keys()]) this.release(pid);
  }
}
