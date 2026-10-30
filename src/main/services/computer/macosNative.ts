import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { AxTreeNode } from '@shared/computer/axTree';
import type { ComputerAppIdentity, ComputerWindowInfo } from '@shared/computer/types';
import { AX_WORKER_TIMEOUT_MS } from './axWalkBudget';
import type { AxWorkerRequest } from './axWorkerClient';
import { createAxWorkerClient, spawnAxWorker } from './axWorkerClient';
import axWorkerPath from './axWorkerThread?modulePath';
import type { PointerOptions } from './backend';
import { decodeCfNumberAsFloat64, kCFNumberFloat64Type } from './cfNumber';
import {
  macClickCount,
  macKeyForAsciiChar,
  macModifierFlag,
  macModifierFlags,
  macMouseButton,
  pickEnglishLayoutIndex,
  splitMacChord,
} from './macKey';
import { withMacWindowFocus } from './macWindowFocus';
import {
  SKY_CLICK_UNAVAILABLE,
  type SkyClickEventStep,
  type SkyMouseButton,
  skyClickCgEventType,
  skyLightActivationRecord,
  skyLightKeyWindowRecords,
  skyMouseButtonNumber,
} from './skyClick';
import { isListedCgWindowLayer } from './windowSource';

/** 后台窗口事件的落点：屏幕坐标与窗口内坐标（含标题栏）同时给出 */
export interface SkyPoint {
  screenX: number;
  screenY: number;
  windowX: number;
  windowY: number;
}

export interface MacosNative {
  windows(): Promise<ComputerWindowInfo[]>;
  click(x: number, y: number, opts?: PointerOptions & { pid?: number }): Promise<void>;
  /** SkyLight 私有通道是否可用（激活包与窗口事件都依赖它） */
  skyAvailable(): boolean;
  /** 系统真前台进程 */
  frontPid(): number | undefined;
  /** 合成激活：目标相信自己激活、该窗口为 key；不改变系统真前台 */
  activateWindow(pid: number, windowId: number): void;
  deactivateWindow(pid: number, windowId: number): void;
  /** 把系统真前台交给 pid，只带它的最前窗口 */
  setFrontProcess(pid: number): boolean;
  /** pid 所属 app 的规范身份（realpath 后的 .app 与 bundle id） */
  appIdentity(pid: number): ComputerAppIdentity | null;
  /** 当前输入源是否为输入法（拼音等会截获合成按键），而非纯键盘布局 */
  inputMethodActive(): boolean;
  /** 按配方投递一串带窗口身份的鼠标事件到 pid；中途失败会补发抬起 */
  skyPointer(input: {
    pid: number;
    windowId: number;
    button: SkyMouseButton;
    flags: number;
    points: SkyPoint[];
    steps: SkyClickEventStep[];
  }): Promise<void>;
  skyScroll(input: {
    pid: number;
    windowId: number;
    point: SkyPoint;
    dx: number;
    dy: number;
    flags: number;
  }): Promise<void>;
  /** 键盘事件直投 pid（不经 HID，不切换系统输入法） */
  pidKeyChord(pid: number, keys: string[]): Promise<void>;
  pidTypeText(pid: number, text: string, opts?: { englishLayout?: boolean }): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(points: Array<{ x: number; y: number }>): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  typeText(text: string): Promise<void>;
  keyChord(keys: string[]): Promise<void>;
  /** run 结束：等已投递的键盘事件被消费后恢复用户原输入法 */
  endInput(): Promise<void>;
  raise(windowId: string): Promise<void>;
  axSnapshot(target: string, maxDepth: number): Promise<AxTreeNode[]>;
  axQuery(
    target: string,
    query: { role?: string; title?: string; value?: string; description?: string; limit?: number }
  ): Promise<AxTreeNode[]>;
  axElementAt(x: number, y: number, pid?: number): Promise<AxTreeNode | null>;
  axFocused(): Promise<AxTreeNode | null>;
  axNode(handle: string): Promise<AxTreeNode>;
  axAttributes(handle: string): Promise<Array<[string, string]>>;
  axChildren(handle: string): Promise<AxTreeNode[]>;
  axParent(handle: string): Promise<AxTreeNode | null>;
  axPerform(handle: string, action: string): Promise<void>;
  axSetValue(handle: string, value: string): Promise<void>;
  axFocus(handle: string): Promise<void>;
  axPid(handle: string): Promise<number | undefined>;
  axEnable(pid: number, bundleId: string | undefined): Promise<{ changed: string[] }>;
  axRestoreEnable(pid: number, attrs: string[]): Promise<void>;
}

let cached: Promise<MacosNative | null> | undefined;

export function loadMacosNative(): Promise<MacosNative | null> {
  cached ??= load().catch(() => null);
  return cached;
}

interface KoffiApi {
  load(path: string): {
    func: (name: string, ret: string, args: unknown[]) => (...args: unknown[]) => unknown;
    symbol(name: string): unknown;
  };
  struct(name: string, fields: Record<string, string>): unknown;
  pointer(ref: unknown, count?: number): unknown;
  out(type: unknown): unknown;
  decode(ref: unknown, type: string): unknown;
}

const RAISE_MESSAGING_TIMEOUT_SEC = 1.5;
const kCGMouseEventClickState = 1;

async function load(): Promise<MacosNative | null> {
  const koffi = (await import('koffi')).default as unknown as KoffiApi;
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const ax = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
  );
  const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
  const GetFrontProcess = carbon.func('GetFrontProcess', 'int32', ['void *']);
  const GetProcessPID = carbon.func('GetProcessPID', 'int32', ['void *', 'void *']);
  const GetProcessForPID = carbon.func('GetProcessForPID', 'int32', ['int32', 'void *']);
  const SetFrontProcessWithOptions = carbon.func('SetFrontProcessWithOptions', 'int32', [
    'void *',
    'uint32',
  ]);
  const kSetFrontProcessFrontWindowOnly = 1;
  const libSystem = koffi.load('/usr/lib/libSystem.B.dylib');
  const procPidPath = libSystem.func('proc_pidpath', 'int', ['int', 'void *', 'uint32']);

  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
  const CGEventCreateMouseEvent = cg.func('CGEventCreateMouseEvent', 'void *', [
    'void *',
    'uint32',
    CGPoint,
    'uint32',
  ]);
  const CGEventPost = cg.func('CGEventPost', 'void', ['uint32', 'void *']);
  const CGEventPostToPid = cg.func('CGEventPostToPid', 'void', ['int32', 'void *']);
  const CGEventSetLocation = cg.func('CGEventSetLocation', 'void', ['void *', CGPoint]);
  const CGEventSetIntegerValueField = cg.func('CGEventSetIntegerValueField', 'void', [
    'void *',
    'uint32',
    'int64',
  ]);
  const CFRelease = cf.func('CFRelease', 'void', ['void *']);
  const CFRetain = cf.func('CFRetain', 'void *', ['void *']);
  const TISCopyCurrentKeyboardInputSource = carbon.func(
    'TISCopyCurrentKeyboardInputSource',
    'void *',
    []
  );
  const TISCopyCurrentASCIICapableKeyboardLayoutInputSource = carbon.func(
    'TISCopyCurrentASCIICapableKeyboardLayoutInputSource',
    'void *',
    []
  );
  const TISSelectInputSource = carbon.func('TISSelectInputSource', 'int32', ['void *']);
  const TISCreateInputSourceList = carbon.func('TISCreateInputSourceList', 'void *', [
    'void *',
    'bool',
  ]);
  const TISGetInputSourceProperty = carbon.func('TISGetInputSourceProperty', 'void *', [
    'void *',
    'void *',
  ]);
  const kTISPropertyInputSourceID = koffi.decode(
    carbon.symbol('kTISPropertyInputSourceID'),
    'void *'
  );
  const kTISPropertyInputSourceType = koffi.decode(
    carbon.symbol('kTISPropertyInputSourceType'),
    'void *'
  );
  const CGEventCreateKeyboardEvent = cg.func('CGEventCreateKeyboardEvent', 'void *', [
    'void *',
    'uint16',
    'bool',
  ]);
  const CGEventSetFlags = cg.func('CGEventSetFlags', 'void', ['void *', 'uint64']);
  const CGEventSetType = cg.func('CGEventSetType', 'void', ['void *', 'uint32']);
  const CGEventKeyboardSetUnicodeString = cg.func('CGEventKeyboardSetUnicodeString', 'void', [
    'void *',
    'ulong',
    'void *',
  ]);
  // CGEventCreateScrollWheelEvent 是变参函数：arm64 上变参走栈，不能按定参声明
  const createScrollEvent = (() => {
    try {
      const fn = cg.func('CGEventCreateScrollWheelEvent2', 'void *', [
        'void *',
        'uint32',
        'uint32',
        'int32',
        'int32',
        'int32',
      ]);
      return (dy: number, dx: number) => fn(null, 0, 2, dy, dx, 0);
    } catch {
      const fn = cg.func('CGEventCreateScrollWheelEvent', 'void *', [
        'void *',
        'uint32',
        'uint32',
        'int32',
        '...',
      ]);
      return (dy: number, dx: number) => fn(null, 0, 2, dy, 'int32', dx);
    }
  })();
  const CGWindowListCopyWindowInfo = cg.func('CGWindowListCopyWindowInfo', 'void *', [
    'uint32',
    'uint32',
  ]);
  const CFArrayGetCount = cf.func('CFArrayGetCount', 'long', ['void *']);
  const CFArrayGetValueAtIndex = cf.func('CFArrayGetValueAtIndex', 'void *', ['void *', 'long']);
  const CFDictionaryGetValue = cf.func('CFDictionaryGetValue', 'void *', ['void *', 'void *']);
  const CFStringCreateWithCString = cf.func('CFStringCreateWithCString', 'void *', [
    'void *',
    'str',
    'uint32',
  ]);
  const CFStringGetLength = cf.func('CFStringGetLength', 'long', ['void *']);
  const CFStringGetCString = cf.func('CFStringGetCString', 'bool', [
    'void *',
    'char *',
    'long',
    'uint32',
  ]);
  const CFNumberGetValue = cf.func('CFNumberGetValue', 'bool', ['void *', 'int', 'void *']);
  const CFGetTypeID = cf.func('CFGetTypeID', 'ulong', ['void *']);
  const CFStringGetTypeID = cf.func('CFStringGetTypeID', 'ulong', []);
  const CFNumberGetTypeID = cf.func('CFNumberGetTypeID', 'ulong', []);
  const CFDictionaryGetTypeID = cf.func('CFDictionaryGetTypeID', 'ulong', []);
  const CFURLCreateFromFileSystemRepresentation = cf.func(
    'CFURLCreateFromFileSystemRepresentation',
    'void *',
    ['void *', 'void *', 'long', 'bool']
  );
  const CFBundleCreate = cf.func('CFBundleCreate', 'void *', ['void *', 'void *']);
  const CFBundleGetIdentifier = cf.func('CFBundleGetIdentifier', 'void *', ['void *']);
  const AXUIElementCreateApplication = ax.func('AXUIElementCreateApplication', 'void *', ['int']);
  const axRefOut = koffi.out(koffi.pointer('void', 2));
  const AXUIElementCopyAttributeValue = ax.func('AXUIElementCopyAttributeValue', 'int', [
    'void *',
    'void *',
    axRefOut,
  ]);
  const AXUIElementPerformAction = ax.func('AXUIElementPerformAction', 'int', ['void *', 'void *']);
  const AXUIElementSetMessagingTimeout = ax.func('AXUIElementSetMessagingTimeout', 'int', [
    'void *',
    'float',
  ]);
  let AXUIElementGetWindow: ((element: unknown, out: Buffer) => unknown) | undefined;
  try {
    AXUIElementGetWindow = ax.func('_AXUIElementGetWindow', 'int', ['void *', 'void *']);
  } catch {
    AXUIElementGetWindow = undefined;
  }
  const kCFStringEncodingUTF8 = 0x08000100;

  const withCfString = <R>(value: string, fn: (ref: unknown) => R): R => {
    const ref = CFStringCreateWithCString(null, value, kCFStringEncodingUTF8);
    if (!ref) throw new Error('CFStringCreateWithCString failed');
    try {
      return fn(ref);
    } finally {
      CFRelease(ref);
    }
  };
  const readString = (ref: unknown): string => {
    if (!ref) return '';
    if (CFGetTypeID(ref) !== CFStringGetTypeID()) return '';
    const length = Number(CFStringGetLength(ref)) + 1;
    const buf = Buffer.alloc(length * 4);
    if (!CFStringGetCString(ref, buf, buf.length, kCFStringEncodingUTF8)) return '';
    const end = buf.indexOf(0);
    return buf.toString('utf8', 0, end === -1 ? buf.length : end);
  };
  const readNumber = (ref: unknown): number => {
    if (!ref) return 0;
    if (CFGetTypeID(ref) !== CFNumberGetTypeID()) return 0;
    const out = Buffer.alloc(8);
    if (!CFNumberGetValue(ref, kCFNumberFloat64Type, out)) return 0;
    return decodeCfNumberAsFloat64(out);
  };
  const dictGet = (dict: unknown, key: string): unknown =>
    withCfString(key, (cfKey) => CFDictionaryGetValue(dict, cfKey));

  const kCGWindowListOptionOnScreenOnly = 1;
  const kCGWindowListExcludeDesktopElements = 16;
  const kCGHIDEventTap = 0;
  const kCGEventMouseMoved = 5;
  const kCGMouseButtonLeft = 0;
  const LEFT = macMouseButton('left');

  const postMouse = (
    type: number,
    x: number,
    y: number,
    pid?: number,
    extra?: { button?: number; clickState?: number; flags?: number }
  ) => {
    const event = CGEventCreateMouseEvent(
      null,
      type,
      { x, y },
      extra?.button ?? kCGMouseButtonLeft
    );
    if (!event) throw new Error('CGEventCreateMouseEvent failed');
    try {
      if (extra?.clickState) {
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, extra.clickState);
      }
      if (extra?.flags) CGEventSetFlags(event, extra.flags);
      if (typeof pid === 'number' && pid > 0) CGEventPostToPid(pid, event);
      else CGEventPost(kCGHIDEventTap, event);
    } finally {
      CFRelease(event);
    }
  };

  const windowPid = async (
    target: string
  ): Promise<{ pid: number; windowId: number; title: string }> => {
    const windows = await listWindows();
    const found = windows.find((window) => window.id === target);
    if (!found) throw new Error(`window '${target}' not found`);
    if (!found.pid) throw new Error(`window '${target}' has no pid`);
    return { pid: found.pid, windowId: Number(found.id), title: found.title };
  };

  const listWindows = async (): Promise<ComputerWindowInfo[]> => {
    const array = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      0
    );
    if (!array) return [];
    try {
      const count = Number(CFArrayGetCount(array));
      const windows: ComputerWindowInfo[] = [];
      for (let i = 0; i < count; i++) {
        const dict = CFArrayGetValueAtIndex(array, i);
        if (!dict || CFGetTypeID(dict) !== CFDictionaryGetTypeID()) continue;
        const bounds = dictGet(dict, 'kCGWindowBounds');
        const layer = readNumber(dictGet(dict, 'kCGWindowLayer'));
        if (!isListedCgWindowLayer(layer)) continue;
        const id = String(Math.round(readNumber(dictGet(dict, 'kCGWindowNumber'))));
        windows.push({
          id,
          app: readString(dictGet(dict, 'kCGWindowOwnerName')),
          title: readString(dictGet(dict, 'kCGWindowName')),
          pid: Math.round(readNumber(dictGet(dict, 'kCGWindowOwnerPID'))),
          focused: false,
          x:
            bounds && CFGetTypeID(bounds) === CFDictionaryGetTypeID()
              ? readNumber(dictGet(bounds, 'X'))
              : 0,
          y:
            bounds && CFGetTypeID(bounds) === CFDictionaryGetTypeID()
              ? readNumber(dictGet(bounds, 'Y'))
              : 0,
          width:
            bounds && CFGetTypeID(bounds) === CFDictionaryGetTypeID()
              ? readNumber(dictGet(bounds, 'Width'))
              : 0,
          height:
            bounds && CFGetTypeID(bounds) === CFDictionaryGetTypeID()
              ? readNumber(dictGet(bounds, 'Height'))
              : 0,
        });
      }
      return withMacWindowFocus(windows, focusedWindow());
    } finally {
      CFRelease(array);
    }
  };

  const postKey = (code: number, down: boolean, flags = 0) => {
    const event = CGEventCreateKeyboardEvent(null, code, down);
    if (!event) throw new Error('CGEventCreateKeyboardEvent failed');
    try {
      CGEventSetFlags(event, flags);
      CGEventPost(kCGHIDEventTap, event);
    } finally {
      CFRelease(event);
    }
  };
  const releaseKey = (code: number, flags = 0) => {
    try {
      postKey(code, false, flags);
    } catch {
      // 尽力释放，不覆盖原始错误
    }
  };
  const tapKey = (code: number, flags: number) => {
    postKey(code, true, flags);
    releaseKey(code, flags);
  };

  const postUnicodeChar = (char: string) => {
    const buf = Buffer.from(char, 'utf16le');
    const units = buf.length / 2;
    if (units === 0) return;
    for (const down of [true, false]) {
      const event = CGEventCreateKeyboardEvent(null, 0, down);
      if (!event) throw new Error('CGEventCreateKeyboardEvent failed');
      try {
        CGEventKeyboardSetUnicodeString(event, units, buf);
        CGEventPost(kCGHIDEventTap, event);
      } finally {
        CFRelease(event);
      }
    }
  };

  const inputSourceId = (source: unknown): string =>
    source ? readString(TISGetInputSourceProperty(source, kTISPropertyInputSourceID)) : '';
  /** 精确选 ABC / US；都没启用时退回系统给的 ASCII-capable 布局。返回 +1 引用。 */
  const copyEnglishLayout = (): unknown => {
    const list = TISCreateInputSourceList(null, false);
    if (list) {
      try {
        const count = Number(CFArrayGetCount(list));
        const ids: string[] = [];
        for (let i = 0; i < count; i++) ids.push(inputSourceId(CFArrayGetValueAtIndex(list, i)));
        const index = pickEnglishLayoutIndex(ids);
        if (index !== -1) {
          const source = CFArrayGetValueAtIndex(list, index);
          if (source) return CFRetain(source);
        }
      } finally {
        CFRelease(list);
      }
    }
    return TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
  };

  /**
   * 键盘事件按目标 App 处理时的输入源解释，而不是投递时：每次输入后立刻切回会让拼音等
   * 输入法吞进组字缓冲并乱序上屏。所以整次 run 内首次输入时切到英文布局并确认生效，
   * run 结束（输入已被消费）后再恢复。
   */
  let layoutRestore: { original: unknown } | null = null;
  /** endInput 递增：等输入法切换期间 run 已被中止时，挂起的输入不再发送 */
  let inputEpoch = 0;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const currentSourceId = (): string => {
    const now = TISCopyCurrentKeyboardInputSource();
    try {
      return inputSourceId(now);
    } finally {
      if (now) CFRelease(now);
    }
  };
  const ensureEnglishLayout = async (): Promise<void> => {
    if (layoutRestore) return;
    const current = TISCopyCurrentKeyboardInputSource();
    const english = copyEnglishLayout();
    try {
      const target = english ? inputSourceId(english) : '';
      if (!target || target === inputSourceId(current)) {
        layoutRestore = { original: null };
        return;
      }
      if (Number(TISSelectInputSource(english)) !== 0) {
        layoutRestore = { original: null };
        return;
      }
      layoutRestore = { original: current ? CFRetain(current) : null };
      for (let i = 0; i < 20 && currentSourceId() !== target; i++) await sleep(25);
      await sleep(300);
    } finally {
      if (english) CFRelease(english);
      if (current) CFRelease(current);
    }
  };
  const withEnglishLayout = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const epoch = inputEpoch;
    await ensureEnglishLayout();
    if (epoch !== inputEpoch) throw new Error('Computer action aborted');
    return fn();
  };

  let axClient: ReturnType<typeof createAxWorkerClient> | undefined;
  const axCall = async (request: AxWorkerRequest) => {
    if (!axClient) {
      axClient = createAxWorkerClient({
        timeoutMs: AX_WORKER_TIMEOUT_MS,
        spawn: () => spawnAxWorker(axWorkerPath),
      });
    }
    return axClient.call(request);
  };

  let sky: {
    setIntegerField: (event: unknown, field: number, value: number) => void;
    setWindowLocation: (event: unknown, x: number, y: number) => void;
    postEventRecord: (psn: unknown, record: unknown) => number;
  } | null = null;
  let slPostToPid: ((pid: number, event: unknown) => void) | undefined;
  try {
    const sl = koffi.load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight');
    sky = {
      setIntegerField: sl.func('SLEventSetIntegerValueField', 'void', [
        'void *',
        'uint32',
        'int64',
      ]) as (event: unknown, field: number, value: number) => void,
      setWindowLocation: sl.func('CGEventSetWindowLocation', 'void', [
        'void *',
        'double',
        'double',
      ]) as (event: unknown, x: number, y: number) => void,
      postEventRecord: sl.func('SLPSPostEventRecordTo', 'int32', ['void *', 'void *']) as (
        psn: unknown,
        record: unknown
      ) => number,
    };
    try {
      slPostToPid = sl.func('SLEventPostToPid', 'void', ['int32', 'void *']) as (
        pid: number,
        event: unknown
      ) => void;
    } catch {
      slPostToPid = undefined;
    }
  } catch {
    sky = null;
  }
  // 每个事件只投递一次：优先 SLEventPostToPid，不可用时退回 CGEventPostToPid
  const postToPidOnce = (pid: number, event: unknown) => {
    if (slPostToPid) {
      try {
        slPostToPid(pid, event);
        return;
      } catch {
        // FFI 调用失败才退回，避免双投递
      }
    }
    CGEventPostToPid(pid, event);
  };

  const psnFor = (pid: number): Buffer => {
    const psn = Buffer.alloc(8);
    const status = Number(GetProcessForPID(pid, psn));
    if (status !== 0) throw new Error(`${SKY_CLICK_UNAVAILABLE}: PSN ${status}`);
    return psn;
  };
  const frontPid = (): number | undefined => {
    const psn = Buffer.alloc(8);
    const pidBuffer = Buffer.alloc(4);
    if (Number(GetFrontProcess(psn)) !== 0 || Number(GetProcessPID(psn, pidBuffer)) !== 0) return;
    const pid = pidBuffer.readInt32LE();
    return pid > 0 ? pid : undefined;
  };
  const postRecord = (psn: Buffer, record: Uint8Array) => {
    if (!sky) throw new Error(SKY_CLICK_UNAVAILABLE);
    const status = Number(sky.postEventRecord(psn, Buffer.from(record)));
    if (status !== 0) throw new Error(`${SKY_CLICK_UNAVAILABLE}: focus ${status}`);
  };
  const postActivation = (pid: number, windowId: number, focused: boolean) => {
    const psn = psnFor(pid);
    postRecord(psn, skyLightActivationRecord(windowId, focused));
    // 激活后把目标窗口设为 key：否则键盘落在该 app 原来的 key 窗口（可能是别的文档）
    if (focused) for (const record of skyLightKeyWindowRecords(windowId)) postRecord(psn, record);
  };
  /** 窗口事件公共字段：40 目标 pid，51/91/92 窗口号，58 点击分组，7 事件来源 */
  const tagSkyEvent = (
    event: unknown,
    input: { pid: number; windowId: number; windowX: number; windowY: number; groupId: number }
  ) => {
    if (!sky) throw new Error(SKY_CLICK_UNAVAILABLE);
    sky.setIntegerField(event, 7, 3);
    sky.setIntegerField(event, 40, input.pid);
    sky.setIntegerField(event, 51, input.windowId);
    sky.setIntegerField(event, 58, input.groupId);
    sky.setIntegerField(event, 91, input.windowId);
    sky.setIntegerField(event, 92, input.windowId);
    sky.setWindowLocation(event, input.windowX, input.windowY);
  };
  const readCfString = (ref: unknown): string => readString(ref);
  const appIdentity = (pid: number): ComputerAppIdentity | null => {
    const buf = Buffer.alloc(4096);
    const length = Number(procPidPath(pid, buf, buf.length));
    if (length <= 0) return null;
    const executable = buf.toString('utf8', 0, length);
    const inner = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/u.exec(executable);
    const outer = /^(.*?\.app)(?:\/|$)/u.exec(executable);
    const bundlePath = inner?.[1] ?? outer?.[1];
    if (!bundlePath) return null;
    let canonical: string;
    try {
      canonical = realpathSync(bundlePath);
    } catch {
      return null;
    }
    const pathBuf = Buffer.from(canonical, 'utf8');
    const url = CFURLCreateFromFileSystemRepresentation(null, pathBuf, pathBuf.length, true);
    let bundleId = '';
    if (url) {
      try {
        const bundle = CFBundleCreate(null, url);
        if (bundle) {
          try {
            bundleId = readCfString(CFBundleGetIdentifier(bundle));
          } finally {
            CFRelease(bundle);
          }
        }
      } finally {
        CFRelease(url);
      }
    }
    const name =
      canonical
        .split('/')
        .pop()
        ?.replace(/\.app$/iu, '') ?? canonical;
    return { bundleId, name, path: canonical };
  };
  const inputMethodActive = (): boolean => {
    const now = TISCopyCurrentKeyboardInputSource();
    if (!now) return false;
    try {
      return (
        readString(TISGetInputSourceProperty(now, kTISPropertyInputSourceType)) !==
        'TISTypeKeyboardLayout'
      );
    } finally {
      CFRelease(now);
    }
  };
  /** 后台输入的输入法处理：只在本次输入期间切到英文布局，输入被消费后立即切回 */
  const withScopedEnglishLayout = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (layoutRestore) return fn();
    const current = TISCopyCurrentKeyboardInputSource();
    const english = copyEnglishLayout();
    let original: unknown = null;
    try {
      const target = english ? inputSourceId(english) : '';
      if (
        target &&
        target !== inputSourceId(current) &&
        Number(TISSelectInputSource(english)) === 0
      ) {
        original = current ? CFRetain(current) : null;
        for (let i = 0; i < 20 && currentSourceId() !== target; i++) await sleep(25);
        await sleep(80);
      }
    } finally {
      if (english) CFRelease(english);
      if (current) CFRelease(current);
    }
    try {
      return await fn();
    } finally {
      if (original) {
        await sleep(150);
        try {
          TISSelectInputSource(original);
        } finally {
          CFRelease(original);
        }
      }
    }
  };
  const kCGEventFlagsChanged = 12;
  const postPidFlags = (pid: number, code: number, flags: number) => {
    const event = CGEventCreateKeyboardEvent(null, code, true);
    if (!event) throw new Error('CGEventCreateKeyboardEvent failed');
    try {
      CGEventSetType(event, kCGEventFlagsChanged);
      CGEventSetFlags(event, flags);
      postToPidOnce(pid, event);
    } finally {
      CFRelease(event);
    }
  };
  const postPidKey = (
    pid: number,
    code: number,
    down: boolean,
    flags: number,
    unicode?: string
  ) => {
    const event = CGEventCreateKeyboardEvent(null, code, down);
    if (!event) throw new Error('CGEventCreateKeyboardEvent failed');
    try {
      CGEventSetFlags(event, flags);
      if (unicode) {
        const units = Buffer.from(unicode, 'utf16le');
        CGEventKeyboardSetUnicodeString(event, units.length / 2, units);
      }
      postToPidOnce(pid, event);
    } finally {
      CFRelease(event);
    }
  };

  const raiseWindow = (pid: number, windowId: number, title: string) => {
    const app = AXUIElementCreateApplication(pid);
    if (!app) throw new Error('AXUIElementCreateApplication failed');
    try {
      AXUIElementSetMessagingTimeout(app, RAISE_MESSAGING_TIMEOUT_SEC);
      withCfString('AXRaise', (raiseAttr) => {
        const out = [null];
        const status = withCfString('AXWindows', (windowsAttr) =>
          Number(AXUIElementCopyAttributeValue(app, windowsAttr, out))
        );
        const array = status === 0 ? out[0] : null;
        if (array) {
          try {
            const count = Number(CFArrayGetCount(array));
            const windows: unknown[] = [];
            for (let i = 0; i < count; i++) {
              const item = CFArrayGetValueAtIndex(array, i);
              if (item) windows.push(item);
            }
            const target =
              windows.find((item) => axWindowId(item) === windowId) ??
              (title ? windows.find((item) => axTitle(item) === title) : undefined) ??
              windows[0];
            if (target) AXUIElementPerformAction(target, raiseAttr);
          } finally {
            CFRelease(array);
          }
        }
        AXUIElementPerformAction(app, raiseAttr);
      });
    } finally {
      CFRelease(app);
    }
  };
  const axWindowId = (element: unknown): number | undefined => {
    if (!AXUIElementGetWindow) return undefined;
    try {
      const buf = Buffer.alloc(4);
      return Number(AXUIElementGetWindow(element, buf)) === 0 ? buf.readUInt32LE(0) : undefined;
    } catch {
      return undefined;
    }
  };
  const focusedWindow = (): { pid: number; windowId: string } | undefined => {
    const psn = Buffer.alloc(8);
    const pidBuffer = Buffer.alloc(4);
    if (Number(GetFrontProcess(psn)) !== 0 || Number(GetProcessPID(psn, pidBuffer)) !== 0) return;
    const pid = pidBuffer.readInt32LE();
    if (pid <= 0) return;
    const app = AXUIElementCreateApplication(pid);
    if (!app) return;
    try {
      AXUIElementSetMessagingTimeout(app, RAISE_MESSAGING_TIMEOUT_SEC);
      const out = [null];
      const status = withCfString('AXFocusedWindow', (attr) =>
        Number(AXUIElementCopyAttributeValue(app, attr, out))
      );
      if (status !== 0 || !out[0]) return;
      try {
        const windowId = axWindowId(out[0]);
        // 焦点不可读时拒绝输入，不能用浮层 z-order 或同进程其他窗口猜测。
        return windowId ? { pid, windowId: String(windowId) } : undefined;
      } finally {
        CFRelease(out[0]);
      }
    } finally {
      CFRelease(app);
    }
  };
  const axTitle = (element: unknown): string => {
    const out = [null];
    const status = withCfString('AXTitle', (attr) =>
      Number(AXUIElementCopyAttributeValue(element, attr, out))
    );
    if (status !== 0 || !out[0]) return '';
    try {
      return readString(out[0]);
    } finally {
      CFRelease(out[0]);
    }
  };

  return {
    windows: listWindows,
    async click(x, y, opts) {
      const pid = typeof opts?.pid === 'number' && opts.pid > 0 ? opts.pid : undefined;
      const button = macMouseButton(opts?.button);
      const count = macClickCount(opts?.count);
      const flags = macModifierFlags(opts?.modifiers);
      postMouse(kCGEventMouseMoved, x, y, pid, { flags });
      for (let clickState = 1; clickState <= count; clickState++) {
        const extra = { button: button.button, clickState, flags };
        postMouse(button.down, x, y, pid, extra);
        postMouse(button.up, x, y, pid, extra);
      }
    },
    skyAvailable: () => sky !== null,
    frontPid,
    activateWindow(pid, windowId) {
      postActivation(pid, windowId, true);
    },
    deactivateWindow(pid, windowId) {
      postActivation(pid, windowId, false);
    },
    setFrontProcess(pid) {
      try {
        return (
          Number(SetFrontProcessWithOptions(psnFor(pid), kSetFrontProcessFrontWindowOnly)) === 0
        );
      } catch {
        return false;
      }
    },
    appIdentity,
    inputMethodActive,
    async skyPointer(input) {
      if (!sky) throw new Error(SKY_CLICK_UNAVAILABLE);
      const button = skyMouseButtonNumber(input.button);
      const groupId = Date.now() % 1_000_000_000;
      const postStep = (step: SkyClickEventStep) => {
        const target = step.pointKind === 'target';
        const point = input.points[step.pointIndex ?? 0];
        if (target && !point) throw new Error('sky pointer step has no point');
        const screen = target ? { x: point.screenX, y: point.screenY } : { x: -1, y: -1 };
        // primer 永远是左键 (-1,-1)，不落在任何控件上
        const primer = !target;
        const event = CGEventCreateMouseEvent(
          null,
          skyClickCgEventType(step.kind, primer ? 'left' : input.button),
          screen,
          primer ? kCGMouseButtonLeft : button
        );
        if (!event) throw new Error('CGEventCreateMouseEvent failed');
        try {
          sky?.setIntegerField(event, 0, step.phase);
          sky?.setIntegerField(event, 1, step.clickState);
          sky?.setIntegerField(event, 3, primer ? kCGMouseButtonLeft : button);
          if (!primer && input.flags) CGEventSetFlags(event, input.flags);
          tagSkyEvent(event, {
            pid: input.pid,
            windowId: input.windowId,
            windowX: target ? point.windowX : -1,
            windowY: target ? point.windowY : -1,
            groupId,
          });
          postToPidOnce(input.pid, event);
        } finally {
          CFRelease(event);
        }
      };
      let openDown: SkyClickEventStep | undefined;
      try {
        for (const step of input.steps) {
          postStep(step);
          if (step.pointKind === 'target') {
            if (step.kind === 'down') openDown = step;
            else if (step.kind === 'up') openDown = undefined;
            else if (step.kind === 'dragged' && openDown)
              openDown = { ...openDown, pointIndex: step.pointIndex };
          }
          if (step.delayAfterMs > 0) await sleep(step.delayAfterMs);
        }
      } finally {
        if (openDown) {
          try {
            postStep({ ...openDown, kind: 'up', delayAfterMs: 0 });
          } catch {
            // 尽力补发抬起，避免目标卡在按下状态
          }
        }
      }
    },
    async skyScroll(input) {
      if (!sky) throw new Error(SKY_CLICK_UNAVAILABLE);
      const groupId = Date.now() % 1_000_000_000;
      const { point } = input;
      const moved = CGEventCreateMouseEvent(
        null,
        kCGEventMouseMoved,
        { x: point.screenX, y: point.screenY },
        kCGMouseButtonLeft
      );
      if (!moved) throw new Error('CGEventCreateMouseEvent failed');
      try {
        tagSkyEvent(moved, { ...input, windowX: point.windowX, windowY: point.windowY, groupId });
        postToPidOnce(input.pid, moved);
      } finally {
        CFRelease(moved);
      }
      await sleep(10);
      const event = createScrollEvent(Math.round(input.dy), Math.round(input.dx));
      if (!event) throw new Error('CGEventCreateScrollWheelEvent failed');
      try {
        CGEventSetLocation(event, { x: point.screenX, y: point.screenY });
        if (input.flags) CGEventSetFlags(event, input.flags);
        tagSkyEvent(event, { ...input, windowX: point.windowX, windowY: point.windowY, groupId });
        postToPidOnce(input.pid, event);
      } finally {
        CFRelease(event);
      }
    },
    async pidKeyChord(pid, keys) {
      const chord = splitMacChord(keys);
      if (chord.modifiers.length + chord.keys.length === 0) throw new Error('unmapped key chord');
      // 直投进程时修饰键必须是 FlagsChanged 事件：作为 keyDown 投递，AppKit 会一直认为它按着
      const held: number[] = [];
      let flags = 0;
      try {
        for (const code of chord.modifiers) {
          flags |= macModifierFlag(code);
          postPidFlags(pid, code, flags);
          held.push(code);
          await sleep(4);
        }
        for (const code of chord.keys) {
          postPidKey(pid, code, true, chord.flags);
          await sleep(4);
          postPidKey(pid, code, false, chord.flags);
          await sleep(4);
        }
      } finally {
        for (const code of held.reverse()) {
          flags &= ~macModifierFlag(code);
          try {
            postPidFlags(pid, code, flags);
          } catch {
            // 尽力释放修饰键
          }
        }
        await sleep(20);
      }
    },
    async pidTypeText(pid, text, opts) {
      if (!text) return;
      const send = async () => {
        for (const char of text) {
          const mapped = macKeyForAsciiChar(char);
          // 键码给出物理键（e.code），Unicode 串给出字符：不依赖当前布局
          const control = char === '\n' || char === '\r' || char === '\t';
          const code = mapped?.code ?? 0;
          const flags = mapped?.flags ?? 0;
          postPidKey(pid, code, true, flags, control ? undefined : char);
          postPidKey(pid, code, false, flags, control ? undefined : char);
          await sleep(3);
        }
      };
      if (opts?.englishLayout) await withScopedEnglishLayout(send);
      else await send();
    },
    async move(x, y) {
      postMouse(kCGEventMouseMoved, x, y);
    },
    async drag(points) {
      if (points.length === 0) return;
      postMouse(kCGEventMouseMoved, points[0].x, points[0].y);
      postMouse(LEFT.down, points[0].x, points[0].y);
      let last = points[0];
      try {
        for (const point of points.slice(1)) {
          postMouse(LEFT.dragged, point.x, point.y);
          last = point;
        }
      } finally {
        postMouse(LEFT.up, last.x, last.y);
      }
    },
    async scroll(x, y, dx, dy) {
      postMouse(kCGEventMouseMoved, x, y);
      const event = createScrollEvent(Math.round(dy), Math.round(dx));
      if (!event) throw new Error('CGEventCreateScrollWheelEvent failed');
      try {
        CGEventPost(kCGHIDEventTap, event);
      } finally {
        CFRelease(event);
      }
    },
    async typeText(text) {
      if (!text) return;
      // 整段（含非 ASCII）都在英文布局下注入，避免拼音输入法拦截 keycode 0 的 Unicode 事件
      await withEnglishLayout(() => {
        for (const char of text) {
          const mapped = macKeyForAsciiChar(char);
          if (mapped) tapKey(mapped.code, mapped.flags);
          else postUnicodeChar(char);
        }
      });
    },
    async keyChord(keys) {
      const chord = splitMacChord(keys);
      if (chord.modifiers.length + chord.keys.length === 0) throw new Error('unmapped key chord');
      await withEnglishLayout(() => {
        const held: number[] = [];
        try {
          for (const code of chord.modifiers) {
            postKey(code, true, chord.flags);
            held.push(code);
          }
          for (const code of chord.keys) tapKey(code, chord.flags);
        } finally {
          for (const code of held.reverse()) releaseKey(code);
        }
      });
    },
    async endInput() {
      inputEpoch += 1;
      const restore = layoutRestore;
      layoutRestore = null;
      if (!restore?.original) return;
      await sleep(200);
      try {
        TISSelectInputSource(restore.original);
      } finally {
        CFRelease(restore.original);
      }
    },
    async raise(windowId) {
      const { pid, windowId: cgWindowId, title } = await windowPid(windowId);
      raiseWindow(pid, cgWindowId, title);
      if (Number.isInteger(pid) && pid > 0) {
        await new Promise<void>((resolve) => {
          execFile(
            '/usr/bin/osascript',
            [
              '-e',
              `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
            ],
            { timeout: 4000 },
            () => resolve()
          );
        });
      }
    },
    async axSnapshot(target, maxDepth) {
      const { pid } = await windowPid(target);
      return (await axCall({ op: 'snapshot', pid, maxDepth })) as AxTreeNode[];
    },
    async axQuery(target, query) {
      const { pid } = await windowPid(target);
      return (await axCall({
        op: 'query',
        pid,
        limit: query.limit ?? 20,
        ...(query.role ? { role: query.role } : {}),
        ...(query.title ? { title: query.title } : {}),
        ...(query.value ? { value: query.value } : {}),
        ...(query.description ? { description: query.description } : {}),
      })) as AxTreeNode[];
    },
    async axElementAt(x, y, pid) {
      return (await axCall({
        op: 'elementAt',
        x,
        y,
        ...(pid ? { pid } : {}),
      })) as AxTreeNode | null;
    },
    async axFocused() {
      return (await axCall({ op: 'focused' })) as AxTreeNode | null;
    },
    async axNode(handle) {
      return (await axCall({ op: 'node', handle })) as AxTreeNode;
    },
    async axAttributes(handle) {
      return (await axCall({ op: 'attributes', handle })) as Array<[string, string]>;
    },
    async axChildren(handle) {
      return (await axCall({ op: 'children', handle })) as AxTreeNode[];
    },
    async axParent() {
      return null;
    },
    async axPerform(handle, action) {
      await axCall({ op: 'perform', handle, action });
    },
    async axSetValue(handle, value) {
      await axCall({ op: 'setValue', handle, value });
    },
    async axFocus(handle) {
      await axCall({ op: 'focus', handle });
    },
    async axPid(handle) {
      const pid = await axCall({ op: 'pid', handle });
      return typeof pid === 'number' && pid > 0 ? pid : undefined;
    },
    async axEnable(pid, bundleId) {
      const result = (await axCall({ op: 'enable', pid, ...(bundleId ? { bundleId } : {}) })) as {
        changed?: unknown;
      } | null;
      const changed = Array.isArray(result?.changed)
        ? result.changed.filter((item): item is string => typeof item === 'string')
        : [];
      return { changed };
    },
    async axRestoreEnable(pid, attrs) {
      await axCall({ op: 'restoreEnable', pid, attrs });
    },
  };
}
