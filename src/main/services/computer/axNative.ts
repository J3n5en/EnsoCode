import { randomBytes } from 'node:crypto';
import { AX_STALE_HANDLE, formatAxHandle, parseAxHandle } from '@shared/computer/axRegistry';
import type { AxTreeNode } from '@shared/computer/axTree';
import { isLikelyCfPointer, splitUniqueRefs, takeOwnedRefs } from './axCfArray';
import { axEnablementAttribute } from './axEnablement';
import { type AxJobBridge, dispatchAxJob } from './axJob';
import { collectAxRoots } from './axRoots';
import {
  AX_MESSAGING_TIMEOUT_SEC,
  AX_SNAPSHOT_MAX_CHILDREN,
  axChildTraversalAttributes,
  axFillEmptyRowTitle,
  axKeepPartialOnTimeout,
  axNextDepth,
  axNodeMatchesQuery,
  axQueryShouldExpand,
  axRowTitleFromCells,
  axShouldExpand,
  axWalkDecision,
} from './axWalkBudget';
import type { AxWorkerRequest } from './axWorkerClient';

export interface AxHandleScope {
  scope: string;
  generation: number;
}

export function axAttributePairs(node: AxTreeNode): Array<[string, string]> {
  const pairs: Array<[string, string]> = [['role', node.role]];
  for (const key of ['title', 'value', 'description'] as const) {
    const value = node[key];
    if (value) pairs.push([key, value]);
  }
  return pairs;
}

export function axSetValueRejection(input: {
  role: string;
  settable: boolean;
  actions: string[];
}): string | undefined {
  if (input.settable) return undefined;
  const hint =
    input.actions.length > 0
      ? `; available actions: ${input.actions.map((action) => `el.perform(${JSON.stringify(action)})`).join(', ')}`
      : '';
  return `AX setValue unsupported: AXValue is not settable on ${input.role}${hint}`;
}

/**
 * worker 侧句柄表：每个句柄持有独立引用（add 时 retain），
 * 同 scope 只保留当前与上一代，与 Main 侧 AxRegistry 对齐。
 */
export class AxHandleTable<T> {
  private next = 1;
  private readonly generations = new Map<string, number>();
  private readonly entries = new Map<string, { value: T; hash?: number } & AxHandleScope>();
  /** scope → 元素哈希 → 句柄；提供身份函数时用于跨代复用同一元素的句柄 */
  private readonly index = new Map<string, Map<number, string[]>>();

  constructor(
    private readonly epoch: string,
    private readonly refs: {
      retain: (value: T) => void;
      release: (value: T) => void;
      /** 元素身份（如 CFHash/CFEqual）；省略时每次 add 都是新句柄 */
      hash?: (value: T) => number;
      equals?: (a: T, b: T) => boolean;
    }
  ) {}

  private unindex(id: string, entry: { scope: string; hash?: number }): void {
    if (entry.hash === undefined) return;
    const bucket = this.index.get(entry.scope)?.get(entry.hash);
    if (!bucket) return;
    const at = bucket.indexOf(id);
    if (at !== -1) bucket.splice(at, 1);
    if (bucket.length === 0) this.index.get(entry.scope)?.delete(entry.hash);
  }

  get size(): number {
    return this.entries.size;
  }

  begin(scope: string): AxHandleScope {
    const generation = (this.generations.get(scope) ?? 0) + 1;
    this.generations.set(scope, generation);
    for (const [id, entry] of this.entries) {
      if (entry.scope === scope && entry.generation + 1 < generation) {
        this.entries.delete(id);
        this.unindex(id, entry);
        this.refs.release(entry.value);
      }
    }
    return { scope, generation };
  }

  add(value: T, at: AxHandleScope): string {
    const current = this.generations.get(at.scope) ?? 0;
    if (at.generation + 1 < current) return formatAxHandle(this.epoch, this.next++);
    const { hash: hashOf, equals } = this.refs;
    const hash = hashOf && equals ? hashOf(value) : undefined;
    if (hash !== undefined && equals) {
      for (const id of this.index.get(at.scope)?.get(hash) ?? []) {
        const entry = this.entries.get(id);
        if (entry && equals(entry.value, value)) {
          entry.generation = Math.max(entry.generation, at.generation);
          return id;
        }
      }
    }
    const id = formatAxHandle(this.epoch, this.next++);
    this.refs.retain(value);
    this.entries.set(id, { value, scope: at.scope, generation: at.generation, hash });
    if (hash !== undefined) {
      let byHash = this.index.get(at.scope);
      if (!byHash) {
        byHash = new Map();
        this.index.set(at.scope, byHash);
      }
      byHash.set(hash, [...(byHash.get(hash) ?? []), id]);
    }
    return id;
  }

  get(handle: string): T {
    return this.entry(handle).value;
  }

  scopeOf(handle: string): AxHandleScope {
    const { scope, generation } = this.entry(handle);
    return { scope, generation };
  }

  private entry(handle: string) {
    const parsed = parseAxHandle(handle);
    const entry = parsed?.epoch === this.epoch ? this.entries.get(handle) : undefined;
    if (!entry) throw new Error(`${AX_STALE_HANDLE}: ${handle}`);
    return entry;
  }
}

interface KoffiApi {
  load(path: string): {
    func: (name: string, ret: string, args: unknown[]) => (...args: unknown[]) => unknown;
    symbol(name: string): unknown;
  };
  pointer(ref: unknown, count?: number): unknown;
  out(type: unknown): unknown;
  decode(ref: unknown, type: string): unknown;
}

let cached: Promise<AxJobBridge | null> | undefined;

async function loadAxBridge(): Promise<AxJobBridge | null> {
  cached ??= load().catch(() => null);
  return cached;
}

const AX_DESKTOP_SCOPE = 'desktop';

async function load(): Promise<AxJobBridge> {
  const koffi = (await import('koffi')).default as unknown as KoffiApi;
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const ax = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
  );
  const CFRelease = cf.func('CFRelease', 'void', ['void *']);
  const CFRetain = cf.func('CFRetain', 'void *', ['void *']);
  const CFArrayGetCount = cf.func('CFArrayGetCount', 'long', ['void *']);
  const CFArrayGetValueAtIndex = cf.func('CFArrayGetValueAtIndex', 'void *', ['void *', 'long']);
  const CFArrayGetTypeID = cf.func('CFArrayGetTypeID', 'ulong', []);
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
  const CFGetTypeID = cf.func('CFGetTypeID', 'ulong', ['void *']);
  const CFEqual = cf.func('CFEqual', 'bool', ['void *', 'void *']);
  const CFStringGetTypeID = cf.func('CFStringGetTypeID', 'ulong', []);
  const kCFBooleanTrue = koffi.decode(cf.symbol('kCFBooleanTrue'), 'void *');
  const kCFBooleanFalse = koffi.decode(cf.symbol('kCFBooleanFalse'), 'void *');
  const AXUIElementCreateApplication = ax.func('AXUIElementCreateApplication', 'void *', ['int']);
  const AXUIElementGetPid = ax.func('AXUIElementGetPid', 'int', ['void *', 'void *']);
  const AXUIElementCreateSystemWide = ax.func('AXUIElementCreateSystemWide', 'void *', []);
  const AXIsProcessTrusted = ax.func('AXIsProcessTrusted', 'bool', []);
  const axRefOut = koffi.out(koffi.pointer('void', 2));
  const AXUIElementCopyAttributeValue = ax.func('AXUIElementCopyAttributeValue', 'int', [
    'void *',
    'void *',
    axRefOut,
  ]);
  const AXUIElementCopyElementAtPosition = ax.func('AXUIElementCopyElementAtPosition', 'int', [
    'void *',
    'float',
    'float',
    axRefOut,
  ]);
  const AXUIElementSetMessagingTimeout = ax.func('AXUIElementSetMessagingTimeout', 'int', [
    'void *',
    'float',
  ]);
  const AXUIElementPerformAction = ax.func('AXUIElementPerformAction', 'int', ['void *', 'void *']);
  const AXUIElementSetAttributeValue = ax.func('AXUIElementSetAttributeValue', 'int', [
    'void *',
    'void *',
    'void *',
  ]);
  const AXUIElementIsAttributeSettable = ax.func('AXUIElementIsAttributeSettable', 'int', [
    'void *',
    'void *',
    koffi.out(koffi.pointer('bool')),
  ]);
  const AXUIElementCopyActionNames = ax.func('AXUIElementCopyActionNames', 'int', [
    'void *',
    axRefOut,
  ]);
  const AXValueGetValue = ax.func('AXValueGetValue', 'bool', ['void *', 'uint32', 'void *']);
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
  const releaseAll = (refs: unknown[]) => {
    for (const ref of refs) CFRelease(ref);
  };
  const sameElement = (a: unknown, b: unknown) => Boolean(CFEqual(a, b));
  const readString = (ref: unknown): string => {
    if (!ref) return '';
    if (CFGetTypeID(ref) !== CFStringGetTypeID()) return '';
    const length = Number(CFStringGetLength(ref)) + 1;
    const buf = Buffer.alloc(length * 4);
    if (!CFStringGetCString(ref, buf, buf.length, kCFStringEncodingUTF8)) return '';
    const end = buf.indexOf(0);
    return buf.toString('utf8', 0, end === -1 ? buf.length : end);
  };
  /** 读 AX 属性，得到 +1 引用（调用方负责释放）；失败返回 status 与 null。 */
  const copyAttr = (element: unknown, name: string): { status: number; value: unknown } =>
    withCfString(name, (attr) => {
      const out = [null];
      const status = Number(AXUIElementCopyAttributeValue(element, attr, out));
      // 短 CFString 可能是 tagged pointer（超出安全整数），这里只判空
      return { status, value: status === 0 && out[0] ? out[0] : null };
    });
  /** 读 CFArray 属性，元素各自 +1 返回；数组本身即刻释放。 */
  const copyArrayAttr = (element: unknown, name: string): { status: number; values: unknown[] } => {
    const { status, value: array } = copyAttr(element, name);
    if (!array) return { status, values: [] };
    try {
      if (CFGetTypeID(array) !== CFArrayGetTypeID()) return { status, values: [] };
      const values = takeOwnedRefs(
        Number(CFArrayGetCount(array)),
        (i) => CFArrayGetValueAtIndex(array, i),
        (item) => {
          CFRetain(item);
        }
      );
      return { status, values };
    } finally {
      CFRelease(array);
    }
  };

  const CFHash = cf.func('CFHash', 'ulong', ['void *']);
  // 同一原生元素跨快照保持同一句柄，Main 侧 ref 随之稳定（diff 视图里未变行的 ref 仍可用）
  const handles = new AxHandleTable<unknown>(randomBytes(4).toString('hex'), {
    retain: (element) => {
      CFRetain(element);
    },
    release: (element) => {
      CFRelease(element);
    },
    hash: (element) => Number(CFHash(element)),
    equals: sameElement,
  });
  const axActionName = (action: string) =>
    action.startsWith('AX') ? action : `AX${action[0].toUpperCase()}${action.slice(1)}`;
  const readActionNames = (element: unknown): string[] => {
    const out = [null];
    if (Number(AXUIElementCopyActionNames(element, out)) !== 0 || !out[0]) return [];
    const array = out[0];
    try {
      if (CFGetTypeID(array) !== CFArrayGetTypeID()) return [];
      const names: string[] = [];
      for (let i = 0; i < Number(CFArrayGetCount(array)); i++) {
        const name = readString(CFArrayGetValueAtIndex(array, i));
        if (name) names.push(name);
      }
      return names;
    } finally {
      CFRelease(array);
    }
  };
  const isSettable = (element: unknown, name: string): boolean =>
    withCfString(name, (attr) => {
      const out = [false];
      return Number(AXUIElementIsAttributeSettable(element, attr, out)) === 0 && Boolean(out[0]);
    });
  const readAxString = (element: unknown, name: string): string => {
    if (!isLikelyCfPointer(element)) return '';
    const { value } = copyAttr(element, name);
    if (!value) return '';
    try {
      return readString(value);
    } finally {
      CFRelease(value);
    }
  };
  /** 返回的子元素均为 +1 引用，调用方必须 releaseAll；未采用/重复的引用在此释放。 */
  const readAxChildren = (element: unknown): unknown[] => {
    if (!isLikelyCfPointer(element)) return [];
    const owned: unknown[] = [];
    try {
      const role = readAxString(element, 'AXRole');
      const rows = copyArrayAttr(element, 'AXRows').values;
      owned.push(...rows);
      const visible = copyArrayAttr(element, 'AXVisibleChildren').values;
      owned.push(...visible);
      const children: unknown[] = [];
      for (const name of axChildTraversalAttributes({
        role,
        hasRows: rows.length > 0,
        hasVisibleChildren: visible.length > 0,
      })) {
        let values = rows;
        if (name === 'AXVisibleChildren') values = visible;
        else if (name !== 'AXRows') {
          values = copyArrayAttr(element, name).values;
          owned.push(...values);
        }
        children.push(...values);
      }
      const { unique } = splitUniqueRefs(children, sameElement);
      const kept = new Set(unique);
      for (const ref of owned) {
        if (kept.has(ref)) kept.delete(ref);
        else CFRelease(ref);
      }
      return unique;
    } catch (error) {
      releaseAll(owned);
      throw error;
    }
  };
  const readAxCgPair = (
    element: unknown,
    name: string,
    type: number
  ): { a: number; b: number } | undefined => {
    if (!isLikelyCfPointer(element)) return undefined;
    const { value } = copyAttr(element, name);
    if (!value) return undefined;
    try {
      const buf = Buffer.alloc(16);
      if (!AXValueGetValue(value, type, buf)) return undefined;
      return { a: buf.readDoubleLE(0), b: buf.readDoubleLE(8) };
    } finally {
      CFRelease(value);
    }
  };
  const readAxBounds = (element: unknown) => {
    const pos = readAxCgPair(element, 'AXPosition', 1);
    const size = readAxCgPair(element, 'AXSize', 2);
    if (!pos || !size) return undefined;
    return { x: pos.a, y: pos.b, width: size.a, height: size.b };
  };
  const describeLite = (element: unknown, ref: string): AxTreeNode => ({
    ref,
    role: readAxString(element, 'AXRole') || 'unknown',
    title: readAxString(element, 'AXTitle') || undefined,
    value: readAxString(element, 'AXValue') || undefined,
    description: readAxString(element, 'AXDescription') || undefined,
  });
  const describe = (element: unknown, ref: string): AxTreeNode => ({
    ...describeLite(element, ref),
    bounds: readAxBounds(element),
  });
  const elementPid = (element: unknown): number | undefined => {
    const out = Buffer.alloc(4);
    if (Number(AXUIElementGetPid(element, out)) !== 0) return undefined;
    const pid = out.readInt32LE(0);
    return pid > 0 ? pid : undefined;
  };
  const readAxBool = (element: unknown, name: string): boolean => {
    const { value } = copyAttr(element, name);
    if (!value) return false;
    try {
      return Boolean(CFEqual(value, kCFBooleanTrue));
    } finally {
      CFRelease(value);
    }
  };
  const describeNew = (element: unknown, at: AxHandleScope) =>
    describe(element, handles.add(element, at));
  const readCellTexts = (element: unknown): string[] => {
    const texts: string[] = [];
    const walk = (el: unknown, depth: number) => {
      if (depth > 3) return;
      const kids = readAxChildren(el);
      try {
        for (const child of kids.slice(0, 8)) {
          const title = readAxString(child, 'AXTitle');
          const value = readAxString(child, 'AXValue');
          const desc = readAxString(child, 'AXDescription');
          if (title) texts.push(title);
          if (value) texts.push(value);
          if (desc) texts.push(desc);
          walk(child, depth + 1);
        }
      } finally {
        releaseAll(kids);
      }
    };
    walk(element, 0);
    return texts;
  };
  const fillRowTitle = (node: AxTreeNode, element: unknown) => {
    if (node.role !== 'AXRow' && node.role !== 'AXCell') return;
    const title = axRowTitleFromCells(node.title, node.value, readCellTexts(element));
    if (title) node.title = title;
  };
  const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const walk = async (
    element: unknown,
    depth: number,
    maxDepth: number,
    startedAt: number,
    counter: { nodes: number },
    at: AxHandleScope
  ): Promise<AxTreeNode> => {
    if (axWalkDecision({ startedAt, nodeCount: counter.nodes }) === 'timeout') {
      if (!axKeepPartialOnTimeout(counter.nodes)) throw new Error('AX_TIMEOUT');
    }
    counter.nodes += 1;
    const node = describeNew(element, at);
    if (
      !axShouldExpand(node.role, depth, maxDepth) ||
      axWalkDecision({ startedAt, nodeCount: counter.nodes }) !== 'continue'
    ) {
      fillRowTitle(node, element);
      return node;
    }
    if (counter.nodes % 4 === 0) await yieldTurn();
    if (axWalkDecision({ startedAt, nodeCount: counter.nodes }) === 'timeout') {
      fillRowTitle(node, element);
      return node;
    }
    const children: AxTreeNode[] = [];
    const kids = readAxChildren(element);
    try {
      for (const child of kids.slice(0, AX_SNAPSHOT_MAX_CHILDREN)) {
        if (axWalkDecision({ startedAt, nodeCount: counter.nodes }) !== 'continue') break;
        children.push(
          await walk(child, axNextDepth(node.role, depth), maxDepth, startedAt, counter, at)
        );
      }
    } finally {
      releaseAll(kids);
    }
    node.children = children;
    axFillEmptyRowTitle(node);
    return node;
  };
  const withApp = async <R>(pid: number, fn: (app: unknown) => Promise<R>): Promise<R> => {
    const app = AXUIElementCreateApplication(pid);
    if (!app) throw new Error('AXUIElementCreateApplication failed');
    try {
      AXUIElementSetMessagingTimeout(app, AX_MESSAGING_TIMEOUT_SEC);
      return await fn(app);
    } finally {
      CFRelease(app);
    }
  };
  const withSystemWide = <R>(fn: (sys: unknown) => R): R => {
    const sys = AXUIElementCreateSystemWide();
    if (!sys) throw new Error('AXUIElementCreateSystemWide failed');
    try {
      AXUIElementSetMessagingTimeout(sys, AX_MESSAGING_TIMEOUT_SEC);
      return fn(sys);
    } finally {
      CFRelease(sys);
    }
  };

  return {
    async snapshot(pid, maxDepth) {
      const at = handles.begin(`pid:${pid}`);
      return withApp(pid, async (app) => {
        const trusted = Boolean(AXIsProcessTrusted());
        const toRelease: unknown[] = [];
        const copyArray = (name: string) => {
          const result = copyArrayAttr(app, name);
          toRelease.push(...result.values);
          return result;
        };
        const copyOne = (name: string): unknown[] => {
          const { value } = copyAttr(app, name);
          if (!value) return [];
          toRelease.push(value);
          return [value];
        };
        try {
          const windows = copyArray('AXWindows');
          const status = windows.status;
          if (!trusted || status === -25211) throw new Error('AX_TCC_DENIED');
          if (status === -25204) throw new Error('AX_TIMEOUT');
          let roots = collectAxRoots((attr) => {
            if (attr === 'AXWindows') return windows.values;
            if (attr === 'AXChildren') return copyArray(attr).values;
            return copyOne(attr);
          }).filter((element) => readAxString(element, 'AXRole') !== 'AXMenuBar');
          if (roots.length === 0) roots = windows.values;
          if (roots.length === 0 && status !== 0) throw new Error(`AX_STATUS_${status}`);
          const startedAt = Date.now();
          const counter = { nodes: 0 };
          const nodes: AxTreeNode[] = [];
          for (const element of roots.slice(0, 8)) {
            const next = axWalkDecision({ startedAt, nodeCount: counter.nodes });
            if (next === 'timeout') {
              if (!axKeepPartialOnTimeout(counter.nodes)) throw new Error('AX_TIMEOUT');
              break;
            }
            if (next === 'budget') break;
            nodes.push(await walk(element, 0, maxDepth, startedAt, counter, at));
          }
          const focused = copyOne('AXFocusedUIElement')[0];
          if (focused) {
            const role = readAxString(focused, 'AXRole');
            if (
              role === 'AXMenu' ||
              role === 'AXSheet' ||
              role === 'AXDialog' ||
              role === 'AXPopover'
            ) {
              const next = axWalkDecision({ startedAt, nodeCount: counter.nodes });
              if (next === 'continue') {
                nodes.push(await walk(focused, 0, maxDepth, startedAt, counter, at));
              }
            }
          }
          return nodes;
        } finally {
          releaseAll(toRelease);
        }
      });
    },
    async query(pid, query) {
      const at = handles.begin(`pid:${pid}`);
      return withApp(pid, async (app) => {
        const toRelease: unknown[] = [];
        const copyArray = (name: string): unknown[] => {
          const { values } = copyArrayAttr(app, name);
          toRelease.push(...values);
          return values;
        };
        try {
          const queue = splitUniqueRefs(
            [...copyArray('AXWindows'), ...copyArray('AXChildren')],
            sameElement
          ).unique.filter((element) => readAxString(element, 'AXRole') !== 'AXMenuBar');
          const found: AxTreeNode[] = [];
          const limit = query.limit ?? 20;
          const startedAt = Date.now();
          const counter = { nodes: 0 };
          while (queue.length > 0 && found.length < limit) {
            if (axWalkDecision({ startedAt, nodeCount: counter.nodes }) !== 'continue') break;
            const element = queue.shift();
            if (!element) break;
            counter.nodes += 1;
            const node = describeLite(element, '');
            if (axNodeMatchesQuery(node, query))
              found.push({ ...node, ref: handles.add(element, at) });
            if (found.length >= limit) break;
            if (axQueryShouldExpand(node.role)) {
              const kids = readAxChildren(element);
              toRelease.push(...kids);
              queue.push(...kids.slice(0, AX_SNAPSHOT_MAX_CHILDREN));
            }
          }
          return found;
        } finally {
          releaseAll(toRelease);
        }
      });
    },
    async elementAt(x, y, pid) {
      const hit = (root: unknown) => {
        const out = [null];
        const status = Number(AXUIElementCopyElementAtPosition(root, x, y, out));
        const element = out[0];
        if (!element) return null;
        try {
          if (status !== 0 || !isLikelyCfPointer(element)) return null;
          const owner = elementPid(element);
          const actions = readActionNames(element);
          return {
            ...describeNew(element, handles.begin(AX_DESKTOP_SCOPE)),
            ...(owner ? { pid: owner } : {}),
            ...(actions.length > 0 ? { actions } : {}),
          };
        } finally {
          CFRelease(element);
        }
      };
      if (typeof pid === 'number' && pid > 0) {
        const app = AXUIElementCreateApplication(pid);
        if (!app) return null;
        try {
          AXUIElementSetMessagingTimeout(app, AX_MESSAGING_TIMEOUT_SEC);
          return hit(app);
        } finally {
          CFRelease(app);
        }
      }
      return withSystemWide(hit);
    },
    async focused() {
      return withSystemWide((sys) => {
        const { value } = copyAttr(sys, 'AXFocusedUIElement');
        if (!value) return null;
        try {
          return describeNew(value, handles.begin(AX_DESKTOP_SCOPE));
        } finally {
          CFRelease(value);
        }
      });
    },
    async node(handle) {
      const element = handles.get(handle);
      const actions = readActionNames(element);
      const pid = elementPid(element);
      return {
        ...describe(element, handle),
        ...(actions.length > 0 ? { actions } : {}),
        ...(pid ? { pid } : {}),
      };
    },
    async attributes(handle) {
      return axAttributePairs(describeLite(handles.get(handle), handle));
    },
    async children(handle) {
      const element = handles.get(handle);
      const at = handles.scopeOf(handle);
      const kids = readAxChildren(element);
      try {
        return kids.map((child) => describeNew(child, at));
      } finally {
        releaseAll(kids);
      }
    },
    async perform(handle, action) {
      const element = handles.get(handle);
      const status = withCfString(axActionName(action), (name) =>
        Number(AXUIElementPerformAction(element, name))
      );
      if (status !== 0) throw new Error(`AX action ${action} failed (${status})`);
    },
    async setValue(handle, value) {
      const element = handles.get(handle);
      const rejection = axSetValueRejection({
        role: readAxString(element, 'AXRole') || 'unknown',
        settable: isSettable(element, 'AXValue'),
        actions: readActionNames(element),
      });
      if (rejection) throw new Error(rejection);
      const status = withCfString('AXValue', (attr) =>
        withCfString(value, (cfValue) =>
          Number(AXUIElementSetAttributeValue(element, attr, cfValue))
        )
      );
      if (status !== 0) throw new Error(`AX setValue failed (${status})`);
    },
    async focus(handle) {
      const element = handles.get(handle);
      const status = withCfString('AXFocused', (attr) =>
        Number(AXUIElementSetAttributeValue(element, attr, kCFBooleanTrue))
      );
      if (status !== 0) throw new Error(`AX focus failed (${status})`);
    },
    async pid(handle) {
      return elementPid(handles.get(handle));
    },
    async enable(pid, bundleId) {
      return withApp(pid, async (app) => {
        const attr = axEnablementAttribute({
          manualSettable: isSettable(app, 'AXManualAccessibility'),
          bundleId,
        });
        if (!attr || readAxBool(app, attr)) return { changed: [] };
        const status = withCfString(attr, (name) =>
          Number(AXUIElementSetAttributeValue(app, name, kCFBooleanTrue))
        );
        return { changed: status === 0 ? [attr] : [] };
      });
    },
    async restoreEnable(pid, attrs) {
      await withApp(pid, async (app) => {
        for (const attr of attrs) {
          if (attr !== 'AXManualAccessibility' && attr !== 'AXEnhancedUserInterface') continue;
          withCfString(attr, (name) => AXUIElementSetAttributeValue(app, name, kCFBooleanFalse));
        }
      });
    },
  };
}

export async function performAxJob(request: AxWorkerRequest): Promise<unknown> {
  const ax = await loadAxBridge();
  if (!ax) throw new Error('AX native unavailable');
  return dispatchAxJob(ax, request);
}
