import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  decodeRemoteValue,
  encodeBase64,
  encodeRemoteValue,
  type HostToRemote,
  type RemoteToHost,
} from '@enso/pair';
import { app, type IpcEvent, type IpcInvokeEvent, ipcMain } from '@platform';
import { RemoteReadCache, takeRemoteMarks, writeSeedOf } from '@shared/remoteDelta';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { readSettings } from '../../ipc/settings';
import { handleLocalImageRequest } from '../localImageProtocol';
import { isPairHeadless, setPairHeadless } from '../pairSessionHost';
import { localMainContents } from '../renderers';
import { localUi } from '../uiHost';
import { bundleManifest, downloadEstimate, readRendererAsset, rendererBuildId } from './assets';
import { isRemoteChannelAllowed } from './channels';
import { withoutConversations } from './conversationSync';
import { type RemoteLink, setRemoteHostHooks } from './hostHooks';
import { installIpcRegistry, registeredHandler, registeredListeners } from './ipcRegistry';
import { resumeGrace } from './resumeGrace';
import { REMOTE_SECRET_SENTINEL, redactSecrets, restoreSecrets } from './secrets';
import {
  addRemoteSender,
  getRemoteSender,
  hasRemoteMain,
  RemoteSender,
  remoteLeaderId,
  remoteSenderById,
  remoteSenders,
  staleRemoteSenders,
} from './senders';

let hostControl = false;

/** 无界面服务端把自身的更新/重启开放给已配对的浏览器 */
export function allowRemoteHostControl(): void {
  hostControl = true;
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

export type { RemoteLink };

const graceTimers = new Map<number, NodeJS.Timeout>();
const leaderSent = new Map<number, boolean>();

/** 只读结果按内容 hash 缓存（已脱敏），各远端共用 */
const readCache = new RemoteReadCache((json) =>
  createHash('sha1').update(json).digest('base64url').slice(0, 22)
);

const rendererRoot = (): string => join(app.getAppPath(), 'out', 'renderer');

/** 必须早于 registerIpcHandlers：之后注册的 handler 才会进镜像表 */
export function setupRemoteRenderer(): void {
  installIpcRegistry(ipcMain as never);
  setRemoteHostHooks({
    command: handleRemoteCommand,
    linkDown: remoteLinkDown,
    linkRevoked: remoteLinkRevoked,
  });
  ipcMain.handle(IPC_CHANNELS.REMOTE_UPLOAD, async (event, name: unknown, data: unknown) => {
    if (!remoteSenderById(event.sender.id)) return { ok: false, error: 'not-remote' };
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) {
      return { ok: false, error: 'invalid' };
    }
    if (data.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: 'too-large' };
    const safe =
      basename(name)
        .replace(/[\\/:*?"<>|\0]/g, '_')
        .slice(0, 200) || 'upload';
    const dir = join(app.getPath('temp'), 'enso-remote-uploads', randomUUID());
    await mkdir(dir, { recursive: true });
    const path = join(dir, safe);
    await writeFile(path, data);
    return { ok: true, path };
  });
}

const isMainWindowAlive = (): boolean => localMainContents() !== null;
/** 服务器没有本地界面，等同永久托盘态 */
const isTrayMode = (): boolean => localUi()?.trayMode() ?? true;

export const hasMainRenderer = (): boolean => isMainWindowAlive() || hasRemoteMain();

function isLeader(sender: RemoteSender): boolean {
  return remoteLeaderId(isMainWindowAlive()) === sender.id;
}

/** 主窗口开关、远端主界面接入/离开后调用：推送 leader 变化，并在托盘态把 pair 职责交给远端 leader */
export function refreshRemoteLeadership(): void {
  const desktop = isMainWindowAlive();
  const leader = remoteLeaderId(desktop);
  for (const sender of remoteSenders()) {
    if (sender.kind !== 'main') continue;
    const value = sender.id === leader;
    if (leaderSent.get(sender.id) === value) continue;
    leaderSent.set(sender.id, value);
    sender.send(IPC_CHANNELS.REMOTE_LEADER_CHANGED, value);
  }
  if (!desktop && isTrayMode()) {
    const headless = leader === null;
    if (isPairHeadless() !== headless) setPairHeadless(headless);
  }
}

function fakeEvent(sender: RemoteSender): IpcInvokeEvent & IpcEvent {
  return {
    sender,
    senderFrame: null,
    processId: -1,
    frameId: -1,
    ports: [],
    returnValue: undefined,
    defaultPrevented: false,
    preventDefault() {},
    reply: (channel: string, ...args: unknown[]) => sender.send(channel, ...args),
  } as unknown as IpcInvokeEvent & IpcEvent;
}

function settingsState(): Record<string, unknown> {
  const store = readSettings()?.['enso-settings'] as
    | { state?: Record<string, unknown> }
    | undefined;
  return store?.state ?? {};
}

/** 远端表单里已有 provider 的 key 是哨兵：按 api+baseUrl 换回宿主真值 */
function resolveProviderSecret(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config;
  const c = config as Record<string, unknown>;
  if (c.apiKey !== REMOTE_SECRET_SENTINEL) return config;
  const providers = Array.isArray(settingsState().providers)
    ? (settingsState().providers as Record<string, unknown>[])
    : [];
  const match = providers.find((p) => p.api === c.api && p.baseUrl === c.baseUrl);
  return { ...c, apiKey: typeof match?.apiKey === 'string' ? match.apiKey : '' };
}

function prepareArgs(channel: string, args: unknown[]): unknown[] {
  switch (channel) {
    case IPC_CHANNELS.SETTINGS_WRITE_KEY: {
      const [name, value] = args;
      if (typeof name !== 'string') return args;
      return [name, restoreSecrets(value, readSettings()?.[name]), ...args.slice(2)];
    }
    case IPC_CHANNELS.SETTINGS_WRITE:
      return [restoreSecrets(args[0], readSettings()), ...args.slice(1)];
    case IPC_CHANNELS.PROVIDERS_LIST_MODELS:
    case IPC_CHANNELS.PROVIDERS_TEST:
      return [resolveProviderSecret(args[0]), ...args.slice(1)];
    default:
      return args;
  }
}

function prepareResult(channel: string, result: unknown): unknown {
  return channel === IPC_CHANNELS.SETTINGS_READ
    ? redactSecrets(withoutConversations(result))
    : result;
}

const deliverer = (link: RemoteLink) => (frame: HostToRemote) => link.send(frame);

function cancelGrace(sender: RemoteSender): void {
  const timer = graceTimers.get(sender.id);
  if (timer) clearTimeout(timer);
  graceTimers.delete(sender.id);
}

function dispose(sender: RemoteSender): void {
  cancelGrace(sender);
  leaderSent.delete(sender.id);
  sender.destroy();
}

async function hello(link: RemoteLink, command: Extract<RemoteToHost, { type: 'rpc-hello' }>) {
  const version = await rendererBuildId(rendererRoot(), app.getVersion());
  if (!version) {
    link.send({ type: 'rpc-ready', cid: command.cid, ok: false, error: 'renderer-missing' });
    return;
  }
  let sender = getRemoteSender(link.pairId, command.cid);
  let resumed = false;
  if (sender && sender.kind === command.kind) {
    cancelGrace(sender);
    resumed = sender.resume(deliverer(link), command.seq);
    if (!resumed) {
      dispose(sender);
      sender = undefined;
    }
  } else if (sender) {
    dispose(sender);
    sender = undefined;
  }
  if (!sender) {
    sender = new RemoteSender(link.pairId, command.cid, command.kind, deliverer(link));
    addRemoteSender(sender);
  }
  sender.page = command.page;
  for (const stale of staleRemoteSenders(link.pairId, command.page)) dispose(stale);
  const leader = sender.kind === 'main' && isLeader(sender);
  if (sender.kind === 'main') leaderSent.set(sender.id, leader);
  link.send({
    type: 'rpc-ready',
    cid: command.cid,
    ok: true,
    resumed,
    version,
    platform: process.platform,
    leader,
    replay: true,
  });
  refreshRemoteLeadership();
}

async function invoke(link: RemoteLink, command: Extract<RemoteToHost, { type: 'rpc-invoke' }>) {
  const sender = getRemoteSender(link.pairId, command.cid);
  if (!sender?.online) {
    link.send({
      type: 'rpc-result',
      cid: command.cid,
      id: command.id,
      ok: false,
      error: 'remote-session-lost',
    });
    return;
  }
  // 浏览器续上后会重发未决 invoke：已处理过的不再执行，结果由 seq 补发送达
  if (!sender.accept(command.id)) return;
  const fail = (error: string) =>
    sender.post({ type: 'rpc-result', cid: command.cid, id: command.id, ok: false, error });
  if (!isRemoteChannelAllowed(command.ch, isLeader(sender), hostControl)) {
    return fail(`Channel '${command.ch}' is not available remotely`);
  }
  const handler = registeredHandler(command.ch);
  if (!handler) return fail(`No handler registered for '${command.ch}'`);
  const decoded = decodeRemoteValue<unknown>(command.args);
  const marks = takeRemoteMarks(Array.isArray(decoded) ? decoded : []);
  if (marks.upsertReset) sender.resetUpserts();
  let raw = marks.args;
  let commit: (() => void) | undefined;
  if (command.ch === IPC_CHANNELS.SETTINGS_WRITE_KEY && typeof raw[0] === 'string') {
    try {
      const resolved = sender.writes.resolve(raw[0], raw[1]);
      raw = [raw[0], resolved.value, ...raw.slice(2)];
      commit = resolved.commit;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const args = prepareArgs(command.ch, raw);
  try {
    const result = prepareResult(command.ch, await handler(fakeEvent(sender), ...args));
    commit?.();
    const data = encodeRemoteValue(result);
    const seed = writeSeedOf(command.ch, data);
    if (seed) sender.writes.seed(seed.name, seed.value);
    sender.post({
      type: 'rpc-result',
      cid: command.cid,
      id: command.id,
      ok: true,
      data: marks.ifNone === undefined ? data : readCache.respond(data, marks.ifNone),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function emit(link: RemoteLink, command: Extract<RemoteToHost, { type: 'rpc-send' }>): void {
  const sender = getRemoteSender(link.pairId, command.cid);
  if (!sender?.online || !sender.accept(command.id)) return;
  if (!isRemoteChannelAllowed(command.ch, isLeader(sender), hostControl)) return;
  const decoded = decodeRemoteValue<unknown>(command.args);
  const args = Array.isArray(decoded) ? decoded : [];
  const event = fakeEvent(sender);
  for (const listener of registeredListeners(command.ch)) {
    try {
      listener(event, ...args);
    } catch (error) {
      console.warn(`[remote] listener ${command.ch} failed`, error);
    }
  }
}

async function asset(link: RemoteLink, command: Extract<RemoteToHost, { type: 'asset-get' }>) {
  const reply = (status: number, mime: string, body: Uint8Array) =>
    link.send({ type: 'asset', id: command.id, status, mime, data: encodeBase64(body) });
  if (command.path === 'meta') {
    const root = rendererRoot();
    const version = await rendererBuildId(root, app.getVersion());
    const download = version ? await downloadEstimate(root, link.gzip === true, version) : 0;
    const bundle = version ? (await bundleManifest(root, version))?.id : undefined;
    const body = JSON.stringify(
      version
        ? {
            version,
            platform: process.platform,
            ...(download ? { download } : {}),
            ...(bundle ? { bundle } : {}),
          }
        : {}
    );
    reply(version ? 200 : 503, 'application/json', new TextEncoder().encode(body));
    return;
  }
  if (command.path.startsWith('r/')) {
    const file = await readRendererAsset(rendererRoot(), command.path.slice(2));
    reply(file.status, file.mime, file.body);
    return;
  }
  if (command.path.startsWith('li/')) {
    let url: string;
    try {
      url = decodeURIComponent(command.path.slice(3));
    } catch {
      reply(400, 'text/plain', new Uint8Array());
      return;
    }
    const response = await handleLocalImageRequest(url, null);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_LOCAL_IMAGE_BYTES) {
      reply(413, 'text/plain', new Uint8Array());
      return;
    }
    reply(
      response.status,
      response.headers.get('content-type') ?? 'application/octet-stream',
      body
    );
    return;
  }
  reply(404, 'text/plain', new Uint8Array());
}

export async function handleRemoteCommand(link: RemoteLink, command: RemoteToHost): Promise<void> {
  switch (command.type) {
    case 'rpc-hello':
      await hello(link, command);
      return;
    case 'rpc-bye': {
      const sender = getRemoteSender(link.pairId, command.cid);
      if (sender) dispose(sender);
      refreshRemoteLeadership();
      return;
    }
    case 'rpc-invoke':
      // 不阻塞接收队列：长耗时 handler（spawn、搜索）不应卡住同连接的后续帧
      void invoke(link, command);
      return;
    case 'rpc-send':
      emit(link, command);
      return;
    case 'asset-get':
      void asset(link, command).catch(() =>
        link.send({ type: 'asset', id: command.id, status: 500, mime: 'text/plain', data: '' })
      );
      return;
  }
}

/** 配对连接断开：该设备的远端 renderer 进入宽限期，超时销毁 */
export function remoteLinkDown(pairId: string): void {
  for (const sender of remoteSenders(pairId)) {
    if (!sender.online) continue;
    sender.suspend();
    cancelGrace(sender);
    scheduleGrace(sender, Date.now());
  }
  // 挂起的页面收不到事件，立刻把 leader 让给还在线的页面
  refreshRemoteLeadership();
}

/** 缓冲没溢出就留着续；溢出或挂起太久才销毁。到点再看，期间回来即取消 */
function scheduleGrace(sender: RemoteSender, suspendedAt: number): void {
  const elapsed = Date.now() - suspendedAt;
  const action = resumeGrace({
    retainedBytes: sender.bufferedBytes,
    maxBytes: sender.bufferLimit,
    suspendedMs: elapsed,
  });
  if (action === 'dispose') {
    graceTimers.delete(sender.id);
    dispose(sender);
    refreshRemoteLeadership();
    return;
  }
  graceTimers.set(
    sender.id,
    setTimeout(() => scheduleGrace(sender, suspendedAt), 5_000)
  );
}

/** 设备被解绑：立即销毁 */
export function remoteLinkRevoked(pairId: string): void {
  const senders = remoteSenders(pairId);
  for (const sender of senders) dispose(sender);
  if (senders.length > 0) refreshRemoteLeadership();
}
