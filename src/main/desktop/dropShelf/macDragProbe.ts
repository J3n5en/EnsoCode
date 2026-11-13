/**
 * Electron 没有「别的应用正在拖放」的 API：轮询系统拖放剪贴板 NSDragPboard 的 changeCount
 * 判断拖动开始，CGEventSourceButtonState 判断松手。不需要辅助功能权限。
 */
export interface DragProbe {
  changeCount(): number;
  hasFiles(): boolean;
  mouseDown(): boolean;
  /** 被拖的文件路径；系统剪贴板隐私策略不是「始终允许」时不读内容，返回 null */
  filePaths(limit: number): string[] | null;
}

type NativeFn = (...args: unknown[]) => unknown;
interface KoffiApi {
  load(path: string): { func: (name: string, ret: string, args: string[]) => NativeFn };
}

let cached: Promise<DragProbe | null> | undefined;

export function loadDragProbe(): Promise<DragProbe | null> {
  cached ??= load().catch((error) => {
    console.warn('[drop-shelf] native probe unavailable', error);
    return null;
  });
  return cached;
}

async function load(): Promise<DragProbe | null> {
  if (process.platform !== 'darwin') return null;
  const koffi = (await import('koffi')).default as unknown as KoffiApi;
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');

  const getClass = objc.func('objc_getClass', 'void *', ['str']);
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const poolPush = objc.func('objc_autoreleasePoolPush', 'void *', []);
  const poolPop = objc.func('objc_autoreleasePoolPop', 'void', ['void *']);
  const msgId = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgIdId = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const msgIdIndex = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'uint64']);
  const msgIdStr = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
  const msgStr = objc.func('objc_msgSend', 'str', ['void *', 'void *']);
  const msgLong = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
  const msgBool = objc.func('objc_msgSend', 'uint8', ['void *', 'void *', 'void *']);
  const buttonState = cg.func('CGEventSourceButtonState', 'bool', ['int32', 'uint32']);

  const retained = (value: unknown) => msgId(value, sel('retain'));
  const nsString = (text: string) =>
    retained(msgIdStr(getClass('NSString'), sel('stringWithUTF8String:'), text));
  const pool = poolPush();
  const pasteboard = retained(
    msgIdId(
      getClass('NSPasteboard'),
      sel('pasteboardWithName:'),
      nsString('Apple CFPasteboard drag')
    )
  );
  poolPop(pool);
  if (!pasteboard) return null;
  const fileUrlType = nsString('public.file-url');
  const SEL_CHANGE_COUNT = sel('changeCount');
  const SEL_TYPES = sel('types');
  const SEL_CONTAINS = sel('containsObject:');
  const SEL_ITEMS = sel('pasteboardItems');
  const SEL_COUNT = sel('count');
  const SEL_AT = sel('objectAtIndex:');
  const SEL_STRING_FOR_TYPE = sel('stringForType:');
  const SEL_URL_WITH_STRING = sel('URLWithString:');
  const SEL_FILE_PATH_URL = sel('filePathURL');
  const SEL_PATH = sel('path');
  const SEL_UTF8 = sel('UTF8String');
  const NSURL = getClass('NSURL');
  // macOS 15.4+ 剪贴板隐私：只有 alwaysAllow（2）才静默可读，否则读内容会弹授权框
  const ACCESS_ALWAYS_ALLOW = 2;
  const canReadContents =
    !msgBool(pasteboard, sel('respondsToSelector:'), sel('accessBehavior')) ||
    Number(msgLong(pasteboard, sel('accessBehavior'))) === ACCESS_ALWAYS_ALLOW;
  // kCGEventSourceStateCombinedSessionState / kCGMouseButtonLeft
  const COMBINED_SESSION = 0;
  const LEFT_BUTTON = 0;

  const inPool = <T>(fn: () => T): T => {
    const token = poolPush();
    try {
      return fn();
    } finally {
      poolPop(token);
    }
  };

  return {
    changeCount: () => Number(inPool(() => msgLong(pasteboard, SEL_CHANGE_COUNT))),
    hasFiles: () =>
      inPool(() => {
        const types = msgId(pasteboard, SEL_TYPES);
        return Boolean(types && msgBool(types, SEL_CONTAINS, fileUrlType));
      }),
    mouseDown: () => Boolean(buttonState(COMBINED_SESSION, LEFT_BUTTON)),
    filePaths: (limit) => {
      if (!canReadContents) return null;
      return inPool(() => {
        const items = msgId(pasteboard, SEL_ITEMS);
        if (!items) return [];
        const total = Math.min(Number(msgLong(items, SEL_COUNT)), limit);
        const paths: string[] = [];
        for (let index = 0; index < total; index += 1) {
          const raw = msgIdId(msgIdIndex(items, SEL_AT, index), SEL_STRING_FOR_TYPE, fileUrlType);
          // Finder 给的多是 file:///.file/id=… 引用 URL，filePathURL 解析成真实路径
          const url = raw && msgId(msgIdId(NSURL, SEL_URL_WITH_STRING, raw), SEL_FILE_PATH_URL);
          const path = url && msgId(url, SEL_PATH);
          const text = path && msgStr(path, SEL_UTF8);
          if (typeof text === 'string' && text) paths.push(text);
        }
        return paths;
      });
    },
  };
}
