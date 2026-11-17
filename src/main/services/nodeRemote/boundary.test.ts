import { nodeShellUrl } from '@shared/nodeSettings';
import { IPC_CHANNELS } from '@shared/types';
import { shell, type WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachNavigationGuard } from '../../windows/appNavigation';
import { isNodePageUrl, parseHostNotification, parseLocalCall } from './boundary';

const call = (channel: unknown, ...args: unknown[]) =>
  parseLocalCall(channel, JSON.stringify(args));

/** 远程节点主界面（对方下发的代码，跑在本机）请本机 main 代办的调用：白名单 + 参数收窄 */
describe('parseLocalCall', () => {
  it('放行节点切换器、请本机打开配对对话框、窗口控件、打开设置与通知上报所需的调用，参数原样保留', () => {
    expect(call(IPC_CHANNELS.NODES_LIST)).toEqual({ channel: IPC_CHANNELS.NODES_LIST, args: [] });
    expect(call(IPC_CHANNELS.NODES_ACTIVE)).toEqual({
      channel: IPC_CHANNELS.NODES_ACTIVE,
      args: [],
    });
    expect(call(IPC_CHANNELS.NODES_SWITCH, 'local')).toEqual({
      channel: IPC_CHANNELS.NODES_SWITCH,
      args: ['local'],
    });
    expect(call(IPC_CHANNELS.NODES_REQUEST_PAIR)).toEqual({
      channel: IPC_CHANNELS.NODES_REQUEST_PAIR,
      args: [],
    });
    for (const channel of [
      IPC_CHANNELS.WINDOW_MINIMIZE,
      IPC_CHANNELS.WINDOW_MAXIMIZE,
      IPC_CHANNELS.WINDOW_CLOSE,
      IPC_CHANNELS.WINDOW_IS_MAXIMIZED,
      IPC_CHANNELS.WINDOW_IS_FULLSCREEN,
    ]) {
      expect(call(channel), channel).toEqual({ channel, args: [] });
    }
    expect(call(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, false)?.args).toEqual([false]);
    expect(call(IPC_CHANNELS.WINDOW_POPUP_MENU, [{ id: 'a', label: 'A' }], 10, 20)?.args).toEqual([
      [{ id: 'a', label: 'A' }],
      10,
      20,
    ]);
    expect(call(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, { section: 'providers' })?.args).toEqual([
      { section: 'providers' },
    ]);
    expect(call(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, 's1')?.args).toEqual(['s1']);
    expect(call(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, null)?.args).toEqual([null]);
  });

  it('名单外的本机能力一律拒绝（配对与节点增删改、本机文件夹与外壳集成、标题栏、配对管理、普通业务通道）', () => {
    for (const channel of [
      IPC_CHANNELS.NODES_PAIR,
      IPC_CHANNELS.NODES_REMOVE,
      IPC_CHANNELS.NODES_RENAME,
      IPC_CHANNELS.NODES_OPEN_SETTINGS,
      IPC_CHANNELS.WINDOW_TAKE_OPEN_FOLDERS,
      IPC_CHANNELS.WINDOW_INSTALL_SHELL_INTEGRATION,
      IPC_CHANNELS.WINDOW_SET_TITLE_BAR_APPEARANCE,
      IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION,
      IPC_CHANNELS.PAIR_START,
      IPC_CHANNELS.SETTINGS_READ,
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(call(channel, 'x'), channel).toBeNull();
    }
  });

  it('参数类型不对、载荷不是 JSON 数组都拒绝', () => {
    expect(call(IPC_CHANNELS.NODES_SWITCH, 1)).toBeNull();
    expect(call(IPC_CHANNELS.NODES_SWITCH, '')).toBeNull();
    expect(call(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, 'yes')).toBeNull();
    expect(call(IPC_CHANNELS.WINDOW_POPUP_MENU, [{ id: 1, label: 'A' }])).toBeNull();
    expect(call(IPC_CHANNELS.WINDOW_POPUP_MENU, 'menu')).toBeNull();
    expect(call(IPC_CHANNELS.WINDOW_POPUP_MENU, [{ id: 'a', label: 'A' }], 'x', 1)).toBeNull();
    expect(call(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, 42)).toBeNull();
    expect(parseLocalCall(IPC_CHANNELS.NODES_LIST, 'not json')).toBeNull();
    expect(parseLocalCall(IPC_CHANNELS.NODES_LIST, '{}')).toBeNull();
    expect(parseLocalCall(IPC_CHANNELS.NODES_LIST, 1)).toBeNull();
    expect(parseLocalCall(1, '[]')).toBeNull();
  });
});

/** 宿主经隧道转来的系统通知：本机据此弹通知，字段收窄并限长 */
describe('parseHostNotification', () => {
  const encode = (...args: unknown[]) => JSON.stringify(args);

  it('取出会话、标题与正文', () => {
    expect(
      parseHostNotification(encode({ sessionId: 's1', title: '会话 · 回复完成', body: '完成' }))
    ).toEqual({ sessionId: 's1', title: '会话 · 回复完成', body: '完成' });
  });

  it('超长标题与正文截断', () => {
    const parsed = parseHostNotification(
      encode({ sessionId: 's1', title: 't'.repeat(1000), body: 'b'.repeat(5000) })
    );
    expect(parsed?.title.length).toBeLessThanOrEqual(200);
    expect(parsed?.body.length).toBeLessThanOrEqual(300);
  });

  it('缺字段、类型不对、不是 JSON 都丢弃', () => {
    expect(parseHostNotification(encode({ title: 't', body: 'b' }))).toBeNull();
    expect(parseHostNotification(encode({ sessionId: '', title: 't', body: 'b' }))).toBeNull();
    expect(parseHostNotification(encode({ sessionId: 's', title: 1, body: 'b' }))).toBeNull();
    expect(parseHostNotification(encode(null))).toBeNull();
    expect(parseHostNotification('nope')).toBeNull();
    expect(parseHostNotification(encode())).toBeNull();
  });
});

type Listener = (event: Record<string, unknown>) => void;
function fakeContents() {
  const listeners = new Map<string, Listener>();
  const contents = {
    on: (name: string, listener: Listener) => {
      listeners.set(name, listener);
      return contents;
    },
  };
  const fire = (name: string, url: string, isMainFrame: boolean) => {
    const preventDefault = vi.fn();
    listeners.get(name)?.({ preventDefault, url, isMainFrame });
    return preventDefault;
  };
  return { contents: contents as unknown as WebContents, fire };
}

const attachNodeNavigationGuard = (contents: WebContents, nodeId: string) =>
  attachNavigationGuard(contents, (url) => isNodePageUrl(url, nodeId));

/** 节点界面带 __ensoRemote：主 frame 无论经链接、重定向还是 frame 跳转，都只能停在该节点的 enso-node 页面 */
describe('attachNodeNavigationGuard', () => {
  afterEach(() => vi.restoreAllMocks());
  const own = nodeShellUrl('n1', 'main').replace('shell.html?page=main', 'r/index.html');
  const other = nodeShellUrl('n2', 'main');

  it('主 frame 跳转与重定向只放行同一节点的页面，外链交给系统浏览器', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachNodeNavigationGuard(contents, 'n1');
    for (const event of ['will-navigate', 'will-redirect']) {
      expect(fire(event, own, true), event).not.toHaveBeenCalled();
      expect(fire(event, other, true), event).toHaveBeenCalled();
      expect(fire(event, 'file:///etc/passwd', true), event).toHaveBeenCalled();
      expect(fire(event, 'https://evil.example/', true), event).toHaveBeenCalled();
    }
    expect(open).toHaveBeenCalledWith('https://evil.example/');
  });

  it('子 frame 放行同节点页面与 srcdoc 预览，其余拦下且不打开浏览器', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachNodeNavigationGuard(contents, 'n1');
    expect(fire('will-frame-navigate', own, false)).not.toHaveBeenCalled();
    expect(fire('will-frame-navigate', 'about:srcdoc', false)).not.toHaveBeenCalled();
    expect(fire('will-frame-navigate', other, false)).toHaveBeenCalled();
    expect(fire('will-frame-navigate', 'https://evil.example/', false)).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
