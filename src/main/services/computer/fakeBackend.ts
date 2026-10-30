import { AxRegistry } from '@shared/computer/axRegistry';
import type { AxTreeNode } from '@shared/computer/axTree';
import type { ComputerCapabilities, ComputerWindowInfo } from '@shared/computer/types';
import type { CaptureBytes, DesktopBackend, PointerOptions, TargetApp } from './backend';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export class FakeDesktopBackend implements DesktopBackend {
  readonly clicks: Array<{ target: string; x: number; y: number; delivery?: string }> = [];
  readonly launches: string[] = [];
  readonly panes: string[] = [];
  clipboard = '';
  /** 能力上报的后台投递；false 时 guest 缺省走前台接管 */
  backgroundInput = true;
  /** 每个 run 内各动作开始/结束的时间线，用于断言并行与串行 */
  readonly timeline: string[] = [];
  /** 动作耗时（毫秒），用于制造并发窗口 */
  inputDelayMs = 0;
  endRun?: () => Promise<void>;
  releasedAll = 0;
  /** false 时模拟拿不到 app 身份的后端（如 Windows） */
  appIdentities = true;
  /** desktop 级前台输入会落到的 app；null 表示无法判断 */
  desktopInputApp: TargetApp | null | undefined;
  private readonly registry = new AxRegistry<AxTreeNode>();
  windowsList: ComputerWindowInfo[] = [
    {
      id: 'w1',
      app: 'Safari',
      title: 'Settings',
      pid: 1,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      focused: true,
    },
  ];

  async capabilities(): Promise<ComputerCapabilities> {
    return {
      platform: 'test',
      capture: true,
      input: true,
      ax: true,
      backgroundInput: this.backgroundInput,
      clipboard: true,
      capturePermission: 'granted',
      inputPermission: 'granted',
      axPermission: 'granted',
    };
  }

  async displays() {
    return [{ id: 'd0', x: 0, y: 0, width: 200, height: 100 }];
  }

  async windows() {
    return this.windowsList;
  }

  async capture(target: string): Promise<CaptureBytes> {
    return {
      png: PNG,
      width: 100,
      height: 50,
      sourceWidth: 200,
      sourceHeight: 100,
      originX: 0,
      originY: 0,
      target,
    };
  }

  readonly inputs: Array<{ method: string; delivery?: string }> = [];
  readonly raised: string[] = [];
  raiseFails = false;

  async click(target: string, screenX: number, screenY: number, opts?: PointerOptions) {
    this.timeline.push(`click:${target}:start`);
    if (this.inputDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.inputDelayMs));
    this.clicks.push({ target, x: screenX, y: screenY, delivery: opts?.delivery });
    this.timeline.push(`click:${target}:end`);
  }

  releaseAll(): void {
    this.releasedAll += 1;
  }

  async appForDesktopInput(): Promise<TargetApp | null> {
    if (this.desktopInputApp !== undefined) return this.desktopInputApp;
    const focused = this.windowsList.find((item) => item.focused) ?? this.windowsList[0];
    return focused ? this.appForTarget(focused.id) : null;
  }

  async appForTarget(target: string): Promise<TargetApp | null> {
    if (!this.appIdentities) return null;
    const window = this.windowsList.find((item) => item.id === target);
    if (!window?.pid) return null;
    return {
      pid: window.pid,
      name: window.app,
      bundleId: `test.${window.app.toLowerCase()}`,
      path: `/Applications/${window.app}.app`,
    };
  }

  async appForRef(ref: string): Promise<TargetApp | null> {
    return this.appForTarget(this.registry.targetOf(ref));
  }

  async move(_target: string, _x: number, _y: number, opts?: PointerOptions) {
    this.inputs.push({ method: 'move', delivery: opts?.delivery });
  }
  async drag(_target: string, _points: unknown, opts?: PointerOptions) {
    this.inputs.push({ method: 'drag', delivery: opts?.delivery });
  }
  async scroll(
    _target: string,
    _x: number,
    _y: number,
    _dx: number,
    _dy: number,
    opts?: PointerOptions
  ) {
    this.inputs.push({ method: 'scroll', delivery: opts?.delivery });
  }
  async typeText(_target: string, _text: string, opts?: PointerOptions) {
    this.inputs.push({ method: 'type', delivery: opts?.delivery });
  }
  async keyChord(_target: string, _keys: string[], opts?: PointerOptions) {
    this.inputs.push({ method: 'press', delivery: opts?.delivery });
  }
  async raise(windowId: string) {
    this.raised.push(windowId);
    if (this.raiseFails) return;
    this.windowsList = this.windowsList.map((window) => ({
      ...window,
      focused: window.id === windowId,
    }));
  }

  async launchApp(name: string, opts?: { pane?: string }) {
    this.launches.push(name);
    if (opts?.pane) this.panes.push(opts.pane);
    if (this.windowsList.length === 0) {
      this.windowsList = [
        {
          id: 'launched',
          app: name,
          title: '',
          pid: 9,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          focused: true,
        },
      ];
    }
  }

  private snapshot(target: string): AxTreeNode[] {
    const generation = this.registry.beginSnapshot(target);
    const button: AxTreeNode = {
      ref: '',
      role: 'button',
      title: 'Save',
      actions: ['press'],
      bounds: { x: 10, y: 10, width: 40, height: 16 },
    };
    button.ref = this.registry.register(target, generation, button);
    const dark: AxTreeNode = {
      ref: '',
      role: 'AXButton',
      description: '深色',
      actions: ['press'],
      bounds: { x: 80, y: 10, width: 40, height: 16 },
    };
    dark.ref = this.registry.register(target, generation, dark);
    const light: AxTreeNode = {
      ref: '',
      role: 'AXRadioButton',
      title: '浅色',
      actions: ['press'],
      bounds: { x: 40, y: 10, width: 40, height: 16 },
    };
    light.ref = this.registry.register(target, generation, light);
    const windowNode: AxTreeNode = {
      ref: '',
      role: 'window',
      title: 'Settings',
      children: [button, dark, light],
    };
    windowNode.ref = this.registry.register(target, generation, windowNode);
    return [windowNode];
  }

  async axSnapshot(target: string) {
    return this.snapshot(target);
  }

  async axQuery(
    target: string,
    query: { role?: string; title?: string; value?: string; description?: string; limit?: number }
  ) {
    return flatten(this.snapshot(target))
      .filter((node) => axNodeMatchesQuery(node, query))
      .slice(0, query.limit ?? 20);
  }

  async axElementAt() {
    return flatten(this.snapshot('w1'))[1] ?? null;
  }

  async axFocused() {
    return flatten(this.snapshot('w1'))[1] ?? null;
  }

  async axNode(ref: string) {
    return this.registry.resolve(ref);
  }

  async axAttributes() {
    return [['role', 'button']] as Array<[string, string]>;
  }

  async axChildren(ref: string) {
    return this.registry.resolve(ref).children ?? [];
  }

  async axParent() {
    return null;
  }

  async axPerform(ref: string) {
    this.registry.resolve(ref);
  }

  async axSetValue(ref: string) {
    this.registry.resolve(ref);
  }

  async axFocus(ref: string) {
    this.registry.resolve(ref);
  }

  async axClick(ref: string) {
    this.registry.resolve(ref);
  }

  async clipboardRead() {
    return this.clipboard;
  }

  async clipboardWrite(text: string) {
    this.clipboard = text;
  }
}

function flatten(nodes: AxTreeNode[]): AxTreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

import { axNodeMatchesQuery } from './axWalkBudget';
