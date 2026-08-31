/**
 * 线协议类型：手机 ↔ Electron 经中继交换的帧。
 * pair 包自包含，不反向依赖应用源码；与 @shared/types/agent 的枚举取值保持一致，
 * main 侧解密后按结构校验再交给现有 sendCommand / IPC。
 */

// 与 @shared/types/agent 对齐的最小重定义（保持字面量一致以便结构兼容）
export interface AttachedImage {
  data: string;
  mimeType: string;
}
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max';
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';

// ── 中继明文控制帧（中继可见，不加密）──────────────────────────────────
export type PairControl =
  | { type: 'host-online' }
  | { type: 'host-offline' }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  /** 配对已被任一端解除：收到即清本地凭据、停止重连，不可与网络断开混淆 */
  | { type: 'revoked' };

/**
 * Web Push 订阅（PushSubscription.toJSON() 的结构子集）。
 * 手机经加密信道交给桌面，桌面 main 用 web-push 直发，中继不参与。
 */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// ── 上行：手机 → Electron（加密 payload，白名单）─────────────────────────
export type PhoneToHost =
  | { type: 'prompt'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'steer'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'approval-respond'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'ask-respond'; sessionId: string; requestId: string; answer: string }
  | { type: 'snapshot' }
  | { type: 'subscribe'; sessionId: string | null; sinceIndex?: number }
  | {
      type: 'spawn';
      sessionId: string;
      projectId: string;
      providerId: string;
      modelId: string;
      presetId?: string;
      approvalMode?: ApprovalMode;
      reasoningEnabled?: boolean;
      thinkingLevel?: ThinkingLevel;
    }
  /** 与桌面 setModel 同语义：记忆会话选用模型，运行中的会话下次 spawn 生效 */
  | { type: 'set-model'; sessionId: string; providerId: string; modelId: string }
  | { type: 'set-reasoning'; sessionId: string; enabled: boolean }
  | { type: 'set-thinking'; sessionId: string; level: ThinkingLevel }
  /** 上滑分页：拉取 beforeIndex 之前的一页历史消息 */
  | { type: 'history'; sessionId: string; beforeIndex: number }
  /** 登记/解除 Web Push 订阅：手机离线时桌面用它发系统推送 */
  | { type: 'push-subscribe'; subscription: PushSubscriptionJson }
  | { type: 'push-unsubscribe' }
  /**
   * 可见性上报：iOS 锁屏/切后台时 socket 只是半开不会 close，桌面无法靠
   * peer-left 判断手机是否还在看。退后台瞬间主动发一帧，推送据此门控。
   */
  | { type: 'presence'; visible: boolean };

/** 手机命令白名单：main 只接受这些 type，其余（set-approval-mode、设置写入等）拒绝 */
export const PHONE_COMMAND_TYPES = [
  'prompt',
  'steer',
  'abort',
  'approval-respond',
  'ask-respond',
  'snapshot',
  'subscribe',
  'spawn',
  'set-model',
  'set-reasoning',
  'set-thinking',
  'history',
  'push-subscribe',
  'push-unsubscribe',
  'presence',
] as const satisfies readonly PhoneToHost['type'][];

export function isPhoneCommand(value: unknown): value is PhoneToHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    (PHONE_COMMAND_TYPES as readonly string[]).includes(
      (value as { type?: unknown }).type as string
    )
  );
}

// ── 下行：Electron → 手机（加密 payload）────────────────────────────────
export interface CatalogEntry {
  id: string;
  title: string;
  projectName: string;
  projectId: string;
  status: string;
  parentId?: string;
  /** 最后活动时间（末条消息或创建时间），手机端显示相对时间 */
  updatedAt?: number;
  /** 置顶/归档（与桌面侧栏同语义：归档与置顶互斥，归档只进单独栏目） */
  pinned?: boolean;
  archived?: boolean;
  /** 会话当前选用的 provider/model 与推理档位，手机模型切换器回显用 */
  providerId?: string;
  modelId?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  kind?: 'local' | 'ssh';
  sshConnectionName?: string;
  sshHost?: string;
}
/** provider 剥密后下发，只够手机做 provider/model 选择 */
export interface ProviderEntry {
  id: string;
  name: string;
  models: { id: string; label?: string }[];
}

/**
 * 桌面下发的外观偏好，手机作为默认值（可本地覆盖）。
 * sync-terminal 表示整套 UI 配色由终端主题推导（与桌面同语义），
 * 此时须配合 terminal 调色板使用。
 */
export type HostAppearance = 'light' | 'dark' | 'system' | 'sync-terminal';

/**
 * 终端配色（bash 工具输出用）。只下发桌面当前选中主题解析后的调色板，
 * 手机不必打包整份 ghostty 主题库。字段与 renderer 的 XtermTheme 一致。
 */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 下行信封：pair 自有的目录类帧 + 透传的现有 RendererAgentEvent（此处不重定义，按 unknown 透传） */
export type HostToPhone =
  | {
      type: 'catalog';
      entries: CatalogEntry[];
      /** 桌面置顶组的手动拖拽顺序；缺省（旧桌面）时手机按活跃倒序 */
      pinnedOrder?: string[];
    }
  | { type: 'projects'; projects: ProjectEntry[] }
  | { type: 'providers'; providers: ProviderEntry[] }
  | {
      type: 'appearance';
      theme: HostAppearance;
      /** 桌面选中的终端配色；缺省表示用手机默认 */
      terminal?: TerminalPalette;
      terminalFontFamily?: string;
    }
  | { type: 'agent-event'; event: unknown }
  /** Web Push 能力下发：手机拿 VAPID 公钥才能 pushManager.subscribe */
  | { type: 'push-config'; vapidPublicKey: string }
  /** history 命令的应答：baseIndex 之前拼接的一页消息，手机按绝对 index 合并 */
  | { type: 'history'; sessionId: string; baseIndex: number; messages: unknown[] };
