import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AxRegistry, axHandleEpoch } from '@shared/computer/axRegistry';
import type { AxTreeNode } from '@shared/computer/axTree';
import { BackgroundUnavailableError, ComputerError } from '@shared/computer/errors';
import { captureSourceRect, scaleCaptureSize } from '@shared/computer/frame';
import type { ComputerCapabilities, ComputerWindowInfo } from '@shared/computer/types';
import {
  clipboard,
  desktopCapturer,
  type NativeImage,
  type Rectangle,
  screen,
  shell,
} from 'electron';
import { withAxErrors } from './axErrors';
import { axPressFallbackMessage, isAxPressUnsupported } from './axJob';
import { AX_SNAPSHOT_DEFAULT_DEPTH } from './axWalkBudget';
import type { AxSnapshotOptions, CaptureBytes, DesktopBackend, PointerOptions } from './backend';
import { loadWin32Native, type Win32Native } from './win32Native';
import { findCapturerWindowSource, thumbnailCropForWindow } from './windowSource';
import { resolveWinLaunch, resolveWinSettingsPane } from './winLaunch';

const execFileAsync = promisify(execFile);

// 窗口矩形与 SendInput 都是物理像素；Electron 的 display 是 DIP，统一换成物理像素
const toPhysical = (rect: Rectangle): Rectangle => screen.dipToScreenRect(null, rect);
const primaryPhysical = () => toPhysical(screen.getPrimaryDisplay().bounds);

export class WindowsDesktopBackend implements DesktopBackend {
  private native: Win32Native | null | undefined;
  private readonly registry = new AxRegistry<string>(axHandleEpoch);

  private async nativeOrNull(): Promise<Win32Native | null> {
    if (this.native !== undefined) return this.native;
    this.native = await loadWin32Native();
    return this.native;
  }

  private async requireNative(): Promise<Win32Native> {
    const native = await this.nativeOrNull();
    if (!native) {
      throw new ComputerError('unsupported', 'Native desktop bridge is unavailable');
    }
    return native;
  }

  async capabilities(): Promise<ComputerCapabilities> {
    const native = await this.nativeOrNull();
    return {
      platform: 'win32',
      capture: true,
      input: Boolean(native),
      ax: Boolean(native),
      backgroundInput: false,
      clipboard: true,
      capturePermission: 'granted',
      inputPermission: native ? 'granted' : 'unsupported',
      axPermission: native ? 'granted' : 'unsupported',
      detail: native
        ? 'Windows input uses SendInput and brings the target window to the front. UI Automation tree is available via ax()/find(). cmd in shortcuts means Ctrl.'
        : 'Native input bridge unavailable.',
    };
  }

  async displays() {
    return screen.getAllDisplays().map((display) => {
      const bounds = toPhysical(display.bounds);
      return {
        id: String(display.id),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        scaleFactor: display.scaleFactor,
      };
    });
  }

  async windows(): Promise<ComputerWindowInfo[]> {
    const native = await this.nativeOrNull();
    if (native) return native.windows();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources.map((source) => ({
      id: source.id,
      app: source.name,
      title: source.name,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    }));
  }

  async capture(target: string, maxWidth: number, maxHeight: number): Promise<CaptureBytes> {
    const types = target === 'desktop' ? (['screen'] as const) : (['window'] as const);
    const sources = await desktopCapturer.getSources({
      types: [...types],
      thumbnailSize: { width: maxWidth, height: maxHeight },
    });
    if (target === 'desktop') {
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primaryId) ?? sources[0];
      if (!source) throw new ComputerError('window-not-found', `window '${target}' not found`);
      return this.captureFromImage(source.thumbnail, target, maxWidth, maxHeight);
    }
    const source = findCapturerWindowSource(sources, target);
    if (source) return this.captureFromImage(source.thumbnail, target, maxWidth, maxHeight);
    return this.captureWindowViaDisplay(target, maxWidth, maxHeight);
  }

  private async captureFromImage(
    image: NativeImage,
    target: string,
    maxWidth: number,
    maxHeight: number,
    windowInfo?: ComputerWindowInfo
  ): Promise<CaptureBytes> {
    const size = image.getSize();
    const png = image.toPNG();
    const info = windowInfo ?? (await this.windows()).find((window) => window.id === target);
    const scaled = scaleCaptureSize(size.width, size.height, maxWidth, maxHeight);
    const display = primaryPhysical();
    const rect = captureSourceRect({
      target,
      thumbnailWidth: size.width,
      thumbnailHeight: size.height,
      window: info,
      display: { x: display.x, y: display.y, width: display.width, height: display.height },
    });
    return {
      png,
      width: scaled.width,
      height: scaled.height,
      sourceWidth: rect.sourceWidth,
      sourceHeight: rect.sourceHeight,
      originX: rect.originX,
      originY: rect.originY,
      target,
    };
  }

  private async captureWindowViaDisplay(
    target: string,
    maxWidth: number,
    maxHeight: number
  ): Promise<CaptureBytes> {
    const info = (await this.windows()).find((window) => window.id === target);
    if (!info) throw new ComputerError('window-not-found', `window '${target}' not found`);
    const display = screen.getDisplayMatching(
      screen.screenToDipRect(null, {
        x: Math.round(info.x),
        y: Math.round(info.y),
        width: Math.max(1, Math.round(info.width)),
        height: Math.max(1, Math.round(info.height)),
      })
    );
    const bounds = toPhysical(display.bounds);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: bounds.width, height: bounds.height },
    });
    const screenSource = sources.find((item) => item.display_id === String(display.id));
    if (!screenSource) throw new ComputerError('window-not-found', `window '${target}' not found`);
    const thumb = screenSource.thumbnail.getSize();
    const crop = thumbnailCropForWindow({
      window: info,
      display: bounds,
      thumbnailWidth: thumb.width,
      thumbnailHeight: thumb.height,
    });
    if (!crop) throw new ComputerError('window-not-found', `window '${target}' not found`);
    return this.captureFromImage(
      screenSource.thumbnail.crop(crop),
      target,
      maxWidth,
      maxHeight,
      info
    );
  }

  async click(_target: string, screenX: number, screenY: number, opts?: PointerOptions) {
    if ((opts?.delivery ?? 'background') === 'background') {
      throw new BackgroundUnavailableError(
        'Windows pixel click cannot target a window in background'
      );
    }
    await (await this.requireNative()).click(screenX, screenY, {
      button: opts?.button,
      count: opts?.count,
      modifiers: opts?.modifiers,
    });
  }

  async move(_target: string, screenX: number, screenY: number, opts?: PointerOptions) {
    if ((opts?.delivery ?? 'background') === 'background') {
      throw new BackgroundUnavailableError('Windows mouse move cannot run in background');
    }
    await (await this.requireNative()).move(screenX, screenY);
  }

  async drag(target: string, points: Array<{ x: number; y: number }>, opts?: PointerOptions) {
    if (points.length === 0) return;
    await this.move(target, points[0].x, points[0].y, opts);
    await (await this.requireNative()).drag(points);
  }

  async scroll(
    _target: string,
    screenX: number,
    screenY: number,
    dx: number,
    dy: number,
    opts?: PointerOptions
  ) {
    if ((opts?.delivery ?? 'background') === 'background') {
      throw new BackgroundUnavailableError('Windows scroll cannot run in background');
    }
    await (await this.requireNative()).scroll(screenX, screenY, dx, dy);
  }

  async typeText(_target: string, text: string, opts?: PointerOptions) {
    if ((opts?.delivery ?? 'background') === 'background') {
      throw new BackgroundUnavailableError('Windows typing cannot run in background');
    }
    await (await this.requireNative()).typeText(text);
  }

  async keyChord(_target: string, keys: string[], opts?: PointerOptions) {
    if ((opts?.delivery ?? 'background') === 'background') {
      throw new BackgroundUnavailableError('Windows key chords cannot run in background');
    }
    await (await this.requireNative()).keyChord(keys);
  }

  async raise(windowId: string) {
    await (await this.requireNative()).raise(windowId);
  }

  async endRun() {
    this.native?.endInput();
  }

  async launchApp(name: string, opts?: { pane?: string }) {
    const pane = opts?.pane ? resolveWinSettingsPane(opts.pane) : undefined;
    if (pane) {
      await shell.openExternal(pane);
      return;
    }
    const launch = resolveWinLaunch(name);
    if (!launch.app) {
      await shell.openExternal(launch.target);
      return;
    }
    await execFileAsync('cmd.exe', ['/c', 'start', '', launch.target], { windowsHide: true });
  }

  async axSnapshot(target: string, opts?: AxSnapshotOptions) {
    if (opts?.root) {
      throw new ComputerError('unsupported', 'ax({ root }) is not supported on Windows yet');
    }
    const native = await this.requireNative();
    const generation = this.registry.beginSnapshot(target);
    const nodes = await withAxErrors(() =>
      native.axSnapshot(target, opts?.maxDepth ?? (opts?.all ? 8 : AX_SNAPSHOT_DEFAULT_DEPTH))
    );
    const attach = (node: AxTreeNode): AxTreeNode => {
      const ref = this.registry.register(target, generation, node.ref);
      return { ...node, ref, children: node.children?.map(attach) };
    };
    return nodes.map(attach);
  }

  async axQuery(
    target: string,
    query: {
      role?: string;
      title?: string;
      value?: string;
      description?: string;
      limit?: number;
    }
  ) {
    const native = await this.requireNative();
    const generation = this.registry.beginSnapshot(target);
    try {
      const nodes = await withAxErrors(() => native.axQuery(target, query));
      return nodes.map((node) => ({
        ...node,
        ref: this.registry.register(target, generation, node.ref),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'AX_TIMEOUT') return [];
      throw error;
    }
  }

  private registerDesktopNode(node: AxTreeNode | null): AxTreeNode | null {
    if (!node) return null;
    const generation = this.registry.beginSnapshot('desktop');
    return { ...node, ref: this.registry.register('desktop', generation, node.ref) };
  }

  async axElementAt(screenX: number, screenY: number) {
    const native = await this.requireNative();
    return this.registerDesktopNode(await withAxErrors(() => native.axElementAt(screenX, screenY)));
  }

  async axFocused() {
    const native = await this.requireNative();
    return this.registerDesktopNode(await withAxErrors(() => native.axFocused()));
  }

  async axNode(ref: string) {
    const handle = this.registry.resolve(ref);
    const native = await this.requireNative();
    return { ...(await withAxErrors(() => native.axNode(handle), ref)), ref };
  }

  async axAttributes(ref: string) {
    const native = await this.requireNative();
    const handle = this.registry.resolve(ref);
    return withAxErrors(() => native.axAttributes(handle), ref);
  }

  async axChildren(ref: string) {
    const native = await this.requireNative();
    const handle = this.registry.resolve(ref);
    const children = await withAxErrors(() => native.axChildren(handle), ref);
    return children.map((child) => ({
      ...child,
      ref: this.registry.adopt(ref, child.ref),
    }));
  }

  async axParent() {
    return null;
  }

  async axPerform(ref: string, action: string) {
    const native = await this.requireNative();
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axPerform(handle, action), ref);
  }

  async axSetValue(ref: string, value: string) {
    const native = await this.requireNative();
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axSetValue(handle, value), ref);
  }

  async axFocus(ref: string) {
    const native = await this.requireNative();
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axFocus(handle), ref);
  }

  async axClick(ref: string) {
    try {
      await this.axPerform(ref, 'press');
    } catch (error) {
      if (!isAxPressUnsupported(error)) throw error;
      const node = await this.axNode(ref);
      const bounds = node.bounds;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error(axPressFallbackMessage(node.role, ref));
      }
      await this.click(
        this.registry.targetOf(ref),
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        { delivery: 'foreground' }
      );
    }
  }

  async clipboardRead() {
    return clipboard.readText();
  }

  async clipboardWrite(text: string) {
    clipboard.writeText(text);
  }
}
