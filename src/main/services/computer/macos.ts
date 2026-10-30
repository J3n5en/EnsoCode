import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AxRegistry, axHandleEpoch } from '@shared/computer/axRegistry';
import type { AxTreeNode } from '@shared/computer/axTree';
import {
  BackgroundUnavailableError,
  ComputerError,
  PermissionError,
} from '@shared/computer/errors';
import { captureSourceRect, scaleCaptureSize } from '@shared/computer/frame';
import type {
  ComputerCapabilities,
  ComputerPermissionState,
  ComputerWindowInfo,
} from '@shared/computer/types';
import { clipboard, desktopCapturer, type NativeImage, screen, systemPreferences } from 'electron';
import { resolveOpenArgs } from './appLaunch';
import { AxEnablementRegistry } from './axEnablement';
import { withAxErrors } from './axErrors';
import { axPressFallbackMessage, isAxPressUnsupported } from './axJob';
import { AX_SNAPSHOT_DEFAULT_DEPTH } from './axWalkBudget';
import type {
  CaptureBytes,
  ClickOutcome,
  DesktopBackend,
  InputOutcome,
  PointerOptions,
  TargetApp,
} from './backend';
import { chooseClickPath, resolveClickRoute } from './clickRoute';
import { FocusRegistry, isUserFacingFocusError } from './focusSession';
import { macClickCount, macModifierFlags } from './macKey';
import { loadMacosNative, type MacosNative, type SkyPoint } from './macosNative';
import { hidSecondsSinceLastEvent } from './occupancyHid';
import { preflightScreenCaptureAccess } from './screenCaptureAccess';
import {
  isSkyClickUnavailable,
  skyClickLocalPoint,
  skyDragPath,
  skyDragRecipe,
  skyMouseButton,
  skyPointerClickRecipe,
} from './skyClick';
import { findCapturerWindowSource, thumbnailCropForWindow } from './windowSource';

const execFileAsync = promisify(execFile);

async function capturePermission(): Promise<ComputerPermissionState> {
  if (await preflightScreenCaptureAccess()) return 'granted';
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'unknown';
}

const AX_DESKTOP_TARGET = 'desktop';
/** 物理输入停顿超过该秒数才临时切换输入法布局，避免打乱用户正在进行的输入 */
const USER_TYPING_IDLE_SECONDS = 1;

function axPermission(): ComputerPermissionState {
  return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
}

export class MacosDesktopBackend implements DesktopBackend {
  private native: MacosNative | null | undefined;
  private readonly registry = new AxRegistry<string>(axHandleEpoch);
  private focus?: FocusRegistry;
  private axEnable?: AxEnablementRegistry;

  private async nativeOrNull(): Promise<MacosNative | null> {
    if (this.native !== undefined) return this.native;
    this.native = await loadMacosNative();
    return this.native;
  }

  async capabilities(): Promise<ComputerCapabilities> {
    const native = await this.nativeOrNull();
    const capture = await capturePermission();
    const ax = axPermission();
    const input = Boolean(native) && ax === 'granted';
    // 后台投递全部依赖 SkyLight 私有通道；它不可用时如实报 false，而不是只看权限
    const backgroundInput = input && native?.skyAvailable() === true;
    return {
      platform: 'darwin',
      capture: capture !== 'denied',
      input,
      ax: input,
      backgroundInput,
      clipboard: true,
      capturePermission: capture,
      inputPermission: ax,
      axPermission: ax,
      detail:
        capture === 'denied' || ax === 'denied'
          ? 'Grant Screen Recording and Accessibility to EnsoCode, then restart the app.'
          : native
            ? undefined
            : 'Native desktop bridge unavailable; screenshots still work.',
    };
  }

  async displays() {
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor,
    }));
  }

  async windows(): Promise<ComputerWindowInfo[]> {
    const native = await this.nativeOrNull();
    if (native) return native.windows();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources.map((source) => {
      const name = source.name;
      const split = name.indexOf(' - ');
      return {
        id: source.id,
        app: split > 0 ? name.slice(0, split) : name,
        title: split > 0 ? name.slice(split + 3) : name,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
    });
  }

  async capture(target: string, maxWidth: number, maxHeight: number): Promise<CaptureBytes> {
    if ((await capturePermission()) === 'denied') {
      throw new PermissionError(
        'capture',
        'Screen Recording is denied. Enable it for EnsoCode in System Settings.'
      );
    }
    const types = target === 'desktop' ? (['screen'] as const) : (['window'] as const);
    const sources = await desktopCapturer.getSources({
      types: [...types],
      thumbnailSize: { width: maxWidth, height: maxHeight },
    });
    if (target === 'desktop') {
      const source = sources[0];
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
    const info =
      windowInfo ??
      (await this.windows()).find((window) => window.id === target || target.includes(window.id));
    const scaled = scaleCaptureSize(size.width, size.height, maxWidth, maxHeight);
    const display = screen.getPrimaryDisplay().bounds;
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
    const display = screen.getDisplayMatching({
      x: Math.round(info.x),
      y: Math.round(info.y),
      width: Math.max(1, Math.round(info.width)),
      height: Math.max(1, Math.round(info.height)),
    });
    const bounds = display.bounds;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: bounds.width, height: bounds.height },
    });
    const screenSource =
      sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
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

  private async requireNative(kind: 'input' | 'ax'): Promise<MacosNative> {
    if (axPermission() !== 'granted') {
      throw new PermissionError(
        kind,
        'Accessibility is denied. Enable it for EnsoCode in System Settings, then restart.'
      );
    }
    const native = await this.nativeOrNull();
    if (!native) {
      throw new ComputerError('unsupported', 'Native desktop bridge is unavailable');
    }
    return native;
  }

  private focusRegistry(native: MacosNative): FocusRegistry {
    this.focus ??= new FocusRegistry({
      frontPid: () => native.frontPid(),
      activate: (pid, windowId) => native.activateWindow(pid, windowId),
      deactivate: (pid, windowId) => native.deactivateWindow(pid, windowId),
      setFront: (pid) => native.setFrontProcess(pid),
      hidIdleSeconds: hidSecondsSinceLastEvent,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    return this.focus;
  }

  /** Electron/Chromium 默认不建 AX 树；首次打开后给目标一点时间构建 */
  private async ensureAx(native: MacosNative, pid: number): Promise<void> {
    this.axEnable ??= new AxEnablementRegistry({
      enable: async (target) =>
        native.axEnable(target, native.appIdentity(target)?.bundleId || undefined),
      restore: (target, attrs) => native.axRestoreEnable(target, attrs),
    });
    if (await this.axEnable.ensure(pid)) await new Promise((resolve) => setTimeout(resolve, 400));
  }

  private async backgroundTarget(
    native: MacosNative,
    target: string,
    action: string
  ): Promise<{ window: ComputerWindowInfo; pid: number; windowId: number }> {
    if (!native.skyAvailable()) {
      throw new BackgroundUnavailableError(
        `macOS ${action}: the SkyLight event channel is unavailable on this system`
      );
    }
    if (target === 'desktop') {
      throw new BackgroundUnavailableError(
        `macOS ${action} needs a window target in background (use desktop.window(...) or desktop.app(...))`
      );
    }
    const window = (await this.windows()).find((item) => item.id === target);
    const pid = window?.pid;
    const windowId = window ? Number(window.id) : Number.NaN;
    if (!window || !pid || !Number.isInteger(windowId) || windowId <= 0) {
      throw new BackgroundUnavailableError(
        `macOS ${action}: window '${target}' has no process identity`
      );
    }
    return { window, pid, windowId };
  }

  private async inFocus<T>(
    native: MacosNative,
    pid: number,
    windowId: number,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.ensureAx(native, pid).catch(() => undefined);
    const registry = this.focusRegistry(native);
    try {
      return await registry.session(pid).guard(windowId, fn);
    } catch (error) {
      if (!isSkyClickUnavailable(error)) throw error;
      // 激活包被拒（1002 多见于辅助功能授权失效）：不要偷偷改成前台
      registry.release(pid);
      throw new BackgroundUnavailableError(
        `macOS refused background focus for this app (${error instanceof Error ? error.message : String(error)}); EnsoCode may have lost Accessibility permission`
      );
    } finally {
      if (registry.has(pid)) registry.touch(pid);
    }
  }

  private skyPoint(window: ComputerWindowInfo, x: number, y: number): SkyPoint {
    const local = skyClickLocalPoint({ x, y }, window);
    return { screenX: x, screenY: y, windowX: local.x, windowY: local.y };
  }

  async click(
    target: string,
    screenX: number,
    screenY: number,
    opts?: PointerOptions
  ): Promise<ClickOutcome> {
    const native = await this.requireNative('input');
    const delivery = opts?.delivery ?? 'background';
    const window = (await this.windows()).find((item) => item.id === target);
    const route = resolveClickRoute({
      delivery,
      pid: window?.pid,
      windowId: window ? Number(window.id) : undefined,
    });
    if (route === 'hid') {
      await native.click(screenX, screenY, opts);
      return { via: 'hid' };
    }
    if (route === 'unavailable') {
      throw new BackgroundUnavailableError(
        target === 'desktop'
          ? 'macOS background click needs a window target (use desktop.window(...) or desktop.app(...))'
          : `macOS background click: window '${target}' has no process identity`
      );
    }
    const { pid, windowId } = await this.backgroundTarget(native, target, 'click');
    const button = skyMouseButton(opts?.button);
    const count = macClickCount(opts?.count);
    const flags = macModifierFlags(opts?.modifiers);
    if (route === 'skyClick') {
      const element = await this.rawElementAt(native, screenX, screenY);
      const path = chooseClickPath({
        targetPid: pid,
        element,
        button,
        count,
        modifiers: opts?.modifiers,
      });
      if (path === 'axPress' && element) {
        try {
          await this.inFocus(native, pid, windowId, () => native.axPerform(element.ref, 'press'));
          return { via: 'axPress' };
        } catch (error) {
          if (isUserFacingFocusError(error)) throw error;
          // press 失败（控件不认、元素已变）时退回同一点的合成点击
        }
      }
      const window = (await this.windows()).find((item) => item.id === target);
      if (!window) throw new ComputerError('window-not-found', `window '${target}' not found`);
      await this.inFocus(native, pid, windowId, () =>
        native.skyPointer({
          pid,
          windowId,
          button,
          flags,
          points: [this.skyPoint(window, screenX, screenY)],
          steps: skyPointerClickRecipe({ button, count }),
        })
      );
      return { via: 'synthetic' };
    }
    await native.click(screenX, screenY, { ...opts, pid });
    return { via: 'synthetic' };
  }

  /** 落点元素（含 pid 与动作）；读不到时 null，不影响合成点击 */
  private async rawElementAt(
    native: MacosNative,
    screenX: number,
    screenY: number
  ): Promise<AxTreeNode | null> {
    try {
      return await native.axElementAt(screenX, screenY);
    } catch {
      return null;
    }
  }

  async move(target: string, screenX: number, screenY: number, opts?: PointerOptions) {
    const native = await this.requireNative('input');
    if ((opts?.delivery ?? 'background') === 'foreground') {
      await native.move(screenX, screenY);
      return;
    }
    const { window, pid, windowId } = await this.backgroundTarget(native, target, 'mouse move');
    await this.inFocus(native, pid, windowId, () =>
      native.skyPointer({
        pid,
        windowId,
        button: 'left',
        flags: macModifierFlags(opts?.modifiers),
        points: [this.skyPoint(window, screenX, screenY)],
        steps: [{ kind: 'moved', pointKind: 'target', clickState: 0, phase: 2, delayAfterMs: 0 }],
      })
    );
  }

  async drag(target: string, points: Array<{ x: number; y: number }>, opts?: PointerOptions) {
    if (points.length === 0) return;
    const native = await this.requireNative('input');
    if ((opts?.delivery ?? 'background') === 'foreground') {
      await native.move(points[0].x, points[0].y);
      await native.drag(points);
      return;
    }
    if (points.length < 2) throw new Error('drag needs at least two points');
    if (skyMouseButton(opts?.button) !== 'left') {
      throw new BackgroundUnavailableError('macOS background drag supports the left button only');
    }
    const { window, pid, windowId } = await this.backgroundTarget(native, target, 'drag');
    const path = skyDragPath(points).map((point) => this.skyPoint(window, point.x, point.y));
    await this.inFocus(native, pid, windowId, () =>
      native.skyPointer({
        pid,
        windowId,
        button: 'left',
        flags: macModifierFlags(opts?.modifiers),
        points: path,
        steps: skyDragRecipe(path.length),
      })
    );
  }

  async scroll(
    target: string,
    screenX: number,
    screenY: number,
    dx: number,
    dy: number,
    opts?: PointerOptions
  ) {
    const native = await this.requireNative('input');
    if ((opts?.delivery ?? 'background') === 'foreground') {
      await native.scroll(screenX, screenY, dx, dy);
      return;
    }
    const { window, pid, windowId } = await this.backgroundTarget(native, target, 'scroll');
    await this.inFocus(native, pid, windowId, () =>
      native.skyScroll({
        pid,
        windowId,
        point: this.skyPoint(window, screenX, screenY),
        dx,
        dy,
        flags: macModifierFlags(opts?.modifiers),
      })
    );
  }

  /** 输入法激活时需切英文布局；用户正在打字就不切（会打乱用户输入），改为提醒模型核对 */
  private layoutPlan(native: MacosNative): { englishLayout: boolean; note?: string } {
    if (!native.inputMethodActive()) return { englishLayout: false };
    const idle = hidSecondsSinceLastEvent();
    if (idle === null || idle >= USER_TYPING_IDLE_SECONDS) return { englishLayout: true };
    return {
      englishLayout: false,
      note: 'An input method is active and the user is typing, so the layout was not switched; verify the text with ax() or el.value',
    };
  }

  async typeText(target: string, text: string, opts?: PointerOptions): Promise<InputOutcome> {
    const native = await this.requireNative('input');
    if ((opts?.delivery ?? 'background') === 'foreground') {
      await native.typeText(text);
      return {};
    }
    const { pid, windowId } = await this.backgroundTarget(native, target, 'typing');
    const plan = this.layoutPlan(native);
    await this.inFocus(native, pid, windowId, () =>
      native.pidTypeText(pid, text, { englishLayout: plan.englishLayout })
    );
    return plan.note ? { note: plan.note } : {};
  }

  async keyChord(target: string, keys: string[], opts?: PointerOptions): Promise<InputOutcome> {
    const native = await this.requireNative('input');
    if ((opts?.delivery ?? 'background') === 'foreground') {
      await native.keyChord(keys);
      return {};
    }
    const { pid, windowId } = await this.backgroundTarget(native, target, 'key chords');
    await this.inFocus(native, pid, windowId, () => native.pidKeyChord(pid, keys));
    return {};
  }

  async endRun() {
    const native = await this.nativeOrNull();
    await native?.endInput();
  }

  releaseAll(): void {
    this.focus?.releaseAll();
    this.axEnable?.releaseAll();
  }

  async appForTarget(target: string): Promise<TargetApp | null> {
    if (target === 'desktop') return null;
    const native = await this.nativeOrNull();
    const window = (await this.windows()).find((item) => item.id === target);
    if (!native || !window?.pid) return null;
    const identity = native.appIdentity(window.pid);
    return identity ? { ...identity, name: window.app || identity.name, pid: window.pid } : null;
  }

  async appForRef(ref: string): Promise<TargetApp | null> {
    const native = await this.nativeOrNull();
    if (!native) return null;
    const pid = await withAxErrors(() => native.axPid(this.registry.resolve(ref)), ref);
    if (!pid) return null;
    const identity = native.appIdentity(pid);
    if (!identity) return null;
    const window = (await this.windows()).find((item) => item.pid === pid);
    return { ...identity, name: window?.app || identity.name, pid };
  }

  async raise(windowId: string) {
    const native = await this.requireNative('input');
    await native.raise(windowId);
  }

  private async ensureAxForTarget(native: MacosNative, target: string): Promise<void> {
    const pid = (await this.windows()).find((item) => item.id === target)?.pid;
    if (pid) await this.ensureAx(native, pid).catch(() => undefined);
  }

  async axSnapshot(target: string, opts?: { maxDepth?: number; all?: boolean }) {
    const native = await this.requireNative('ax');
    await this.ensureAxForTarget(native, target);
    const generation = this.registry.beginSnapshot(target);
    // 超时由 axWorkerClient 负责（到点会终止 worker），这里不再叠一层 race
    const nodes = await withAxErrors(() =>
      native.axSnapshot(target, opts?.maxDepth ?? (opts?.all ? 8 : AX_SNAPSHOT_DEFAULT_DEPTH))
    );
    const attach = (node: AxTreeNode): AxTreeNode => {
      const ref = this.registry.register(target, generation, node.ref);
      return {
        ...node,
        ref,
        children: node.children?.map(attach),
      };
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
    const native = await this.requireNative('ax');
    await this.ensureAxForTarget(native, target);
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

  /** elementAt/focused 的结果与 worker 侧 'desktop' 作用域对齐，登记后返回 eN。 */
  private registerDesktopNode(node: AxTreeNode | null): AxTreeNode | null {
    if (!node) return null;
    const generation = this.registry.beginSnapshot(AX_DESKTOP_TARGET);
    return { ...node, ref: this.registry.register(AX_DESKTOP_TARGET, generation, node.ref) };
  }

  async axElementAt(screenX: number, screenY: number) {
    const native = await this.requireNative('ax');
    return this.registerDesktopNode(await withAxErrors(() => native.axElementAt(screenX, screenY)));
  }

  async axFocused() {
    const native = await this.requireNative('ax');
    return this.registerDesktopNode(await withAxErrors(() => native.axFocused()));
  }

  async axNode(ref: string) {
    const handle = this.registry.resolve(ref);
    const native = await this.requireNative('ax');
    return { ...(await withAxErrors(() => native.axNode(handle), ref)), ref };
  }

  async axAttributes(ref: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    return withAxErrors(() => native.axAttributes(handle), ref);
  }

  async axChildren(ref: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    const children = await withAxErrors(() => native.axChildren(handle), ref);
    return children.map((child) => ({
      ...child,
      ref: this.registry.adopt(ref, child.ref),
    }));
  }

  async axParent(ref: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    return withAxErrors(() => native.axParent(handle), ref);
  }

  async axPerform(ref: string, action: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axPerform(handle, action), ref);
  }

  async axSetValue(ref: string, value: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axSetValue(handle, value), ref);
  }

  async axFocus(ref: string) {
    const native = await this.requireNative('ax');
    const handle = this.registry.resolve(ref);
    await withAxErrors(() => native.axFocus(handle), ref);
  }

  /** press 不被支持时退回控件中心点的点击，投递方式沿用调用方（缺省后台） */
  async axClick(ref: string, opts?: PointerOptions) {
    try {
      await this.axPerform(ref, 'press');
    } catch (error) {
      if (!isAxPressUnsupported(error)) throw error;
      const node = await this.axNode(ref);
      const bounds = node.bounds;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error(axPressFallbackMessage(node.role, ref));
      }
      const target = this.registry.targetOf(ref);
      const window =
        target === AX_DESKTOP_TARGET && node.pid
          ? (await this.windows()).find((item) => item.pid === node.pid)
          : undefined;
      await this.click(
        window?.id ?? target,
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        { delivery: opts?.delivery ?? 'background' }
      );
    }
  }

  async clipboardRead() {
    return clipboard.readText();
  }

  async clipboardWrite(text: string) {
    clipboard.writeText(text);
  }

  async launchApp(name: string, opts?: { pane?: string }): Promise<void> {
    await execFileAsync('/usr/bin/open', resolveOpenArgs(name, opts), {
      timeout: 15_000,
    });
  }
}
