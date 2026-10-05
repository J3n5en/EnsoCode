import type { AbilitySuggestion } from '../bots/abilitySuggest';
import type { GoalSuggestion, GoalSuggestTemplate } from '../bots/goalSuggest';
import type { PersonaSuggestion } from '../bots/personaSuggest';
import type { BotMediaItem } from '../bots/sendImage';
import type { TeamFileError, TeamMemberAssets, TeamRename, TeamSpec } from '../bots/team';
import type { BotTemplateLibrary } from '../bots/templateLibrary';
import type {
  ApprovalRequestInfo,
  AskRequestInfo,
  AttachedImage,
  ConversationAuthority,
} from './agent';
import type {
  BotChat,
  BotProfile,
  BotRoutine,
  BotRoutineRun,
  Delegation,
  GroupEntry,
  GroupTask,
} from './bot';

export type BotDelegationsResult =
  | { ok: true; delegations: Delegation[]; enabled: boolean }
  | BotIpcError;
export type BotDelegationRetryResult =
  | { ok: true; delegationId: string; warning?: string }
  | BotIpcError;
export type BotRoutinesResult =
  | { ok: true; routines: BotRoutine[]; enabled: boolean }
  | BotIpcError;
export type BotRoutineSaveInput = Pick<
  BotRoutine,
  'botId' | 'title' | 'prompt' | 'schedule' | 'chatId'
> & {
  id?: string;
  enabled?: boolean;
  catchUp?: boolean;
  /** 缺省沿用原执行者；null = 由归属成员自己执行 */
  doneBy?: string | null;
};
export type BotRoutineSaveResult = { ok: true; routine: BotRoutine } | BotIpcError;
/** 拒绝从未批准过的提议时直接删除，不带 routine */
export type BotRoutineReviewResult = { ok: true; routine?: BotRoutine } | BotIpcError;
export type BotRoutineRunsResult = { ok: true; runs: BotRoutineRun[] } | BotIpcError;
export type BotTasksResult = { ok: true; tasks: GroupTask[]; enabled: boolean } | BotIpcError;
export type BotTaskWriteResult = { ok: true; task: GroupTask } | BotIpcError;
/** 新建传 title/detail；编辑另带 id（只改标题 / 详情，不写时间线） */
export interface BotTaskSaveInput {
  chatId: string;
  id?: string;
  title: string;
  detail?: string;
  /** 验收文本（output-contains）；编辑时传空串清除 */
  check?: string;
}

/** renderer 可写的成员字段；engine:null = 跟随全局默认模型 */
export type BotDraftInput = Partial<
  Pick<
    BotProfile,
    | 'name'
    | 'title'
    | 'scope'
    | 'avatar'
    | 'approvalMode'
    | 'tools'
    | 'skillIds'
    | 'mcpServerIds'
    | 'delegation'
    | 'memory'
  >
> & {
  engine?: BotProfile['engine'] | null;
  persona?: string;
  /** null / 缺省 = 不限 */
  budget?: BotProfile['budget'] | null;
  /** null = 默认时限 */
  delegationTimeoutMinutes?: number | null;
  /** null = 不限 */
  maxTokensPerTurn?: number | null;
};

/** renderer 选工作区：chat-home 的项目由 Main 建，不收 projectId */
export type BotChatWorkspaceInput =
  | { kind: 'member-home' }
  | { kind: 'chat-home' }
  | { kind: 'project'; projectId: string };

export interface BotChatCreateInput {
  kind: BotChat['kind'];
  title?: string;
  members: string[];
  bossBotId?: string | null;
  workspace: BotChatWorkspaceInput;
  routing?: Partial<BotChat['routing']>;
}

export interface BotChatUpdateInput {
  chatId: string;
  expectedVersion?: number;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  /** 搁置（置顶会同时取消）/ 回到进行中（同时取消提醒） */
  settled?: boolean;
  /** 稍后提醒的时间（隐含搁置）；null 取消提醒 */
  snoozedUntil?: number | null;
  /** 置顶内顺序；null 清除 */
  pinOrder?: number | null;
  members?: string[];
  bossBotId?: string | null;
  routing?: Partial<BotChat['routing']>;
  /** 变更后所有成员下次投递开新会话，旧会话只读保留 */
  workspace?: BotChatWorkspaceInput;
}

export type BotEventKind =
  | 'catalog'
  | 'chat'
  | 'timeline'
  | 'queue'
  | 'delegation'
  | 'routine'
  /** 群任务看板变化（带 chatId）；手机端协议不转发 */
  | 'tasks'
  /** 核心笔记变化（群笔记带 chatId）；手机端协议不转发 */
  | 'notes'
  /** 某成员今日预算耗尽（投递被拒或回合被停）；renderer 刷新用量概览与收件箱 */
  | 'budget'
  /** 运行中的成员会话进入 / 退出静默（BotSilence）；renderer 刷新聊天运行态 */
  | 'silence'
  /** 稍后提醒到点（带 chatId）：Main 已取消搁置，renderer 标为未读；手机端不转发 */
  | 'reminder'
  /** Main 收件箱有变化：renderer 重新拉 BOT_INBOX_LIST；手机端改推 bot-inbox 帧 */
  | 'inbox'
  /** 点击系统通知：切到 Bot 模式并打开 chatId 或 conversationId 所属聊天；只发给主窗口 */
  | 'open';

/** main → renderer：Bot 数据变化提示，renderer 按 kind/chatId 重新拉取 */
export interface BotEvent {
  kind: BotEventKind;
  chatId?: string;
  /** kind 为 'open' 时：触发通知的成员会话 */
  conversationId?: string;
  seq?: number;
}

export type BotIpcError = { ok: false; error: string; reason?: string; chatIds?: string[] };

/** 运行中的成员轮次超过静默阈值没有任何输出；since = 最后一次输出时间 */
export interface BotSilence {
  conversationId: string;
  /** 委派会话为 null */
  chatId: string | null;
  botId: string;
  delegationId?: string;
  since: number;
}

export type BotInboxKind =
  | 'approval'
  | 'ask'
  | 'delegation-interrupted'
  | 'budget'
  | 'routine-draft'
  | 'routine-blocked'
  | 'silence';

/** Main 持久化的收件箱条目；key 为去重身份，同 key 重新出现时重新打开 */
export interface BotInboxItem {
  key: string;
  kind: BotInboxKind;
  /** 打开哪个聊天；委派会话归到发起委派的聊天 */
  chatId: string | null;
  botId?: string;
  /** 审批 / 提问 / 静默所在的根会话 */
  conversationId?: string;
  delegationId?: string;
  /** 委派会话：botId 替 ownerBotId 执行 */
  ownerBotId?: string;
  routine?: { botId: string; id: string };
  approval?: ApprovalRequestInfo;
  ask?: AskRequestInfo;
  /** 预算：触达的上限与自然日 */
  budget?: { reason: 'cost' | 'tokens'; day: string };
  /** 静默起点（最后一次输出时间） */
  since?: number;
  /** 列表与手机端的摘要 */
  text?: string;
  createdAt: number;
  updatedAt: number;
  dismissedAt?: number;
  resolvedAt?: number;
}

export type BotInboxListResult = { ok: true; items: BotInboxItem[] } | BotIpcError;
export interface BotInboxUpdateInput {
  key: string;
  action: 'dismiss' | 'reopen';
}

/** 「自动设置能力」入参：只传成员描述；候选技能 / MCP / 成员由 Main 从权威记录取 */
export interface BotAbilitySuggestRequest {
  name?: string;
  title?: string;
  scope?: string;
  persona?: string;
  language?: 'zh' | 'en';
  botId?: string;
}

/** error：no-model / timeout / invalid-reply / failed（detail 为原始错误）/ disabled / invalid */
export type BotAbilitySuggestResult =
  | { ok: true; suggestion: AbilitySuggestion }
  | (BotIpcError & { detail?: string });

export interface BotPersonaSuggestRequest {
  name: string;
  title: string;
  scope?: string;
  persona?: string;
  language?: 'zh' | 'en';
}

/** 职责为空时顺带给出 scope；error 同 BotAbilitySuggestResult */
export type BotPersonaSuggestResult =
  | { ok: true; suggestion: PersonaSuggestion }
  | (BotIpcError & { detail?: string });

/** 目标式引导：templates 只传 id/标题/简介；error 同 BotAbilitySuggestResult */
export interface BotGoalSuggestRequest {
  goal: string;
  language?: 'zh' | 'en';
  templates?: GoalSuggestTemplate[];
}
export type BotGoalSuggestResult =
  | { ok: true; suggestion: GoalSuggestion }
  | (BotIpcError & { detail?: string });

/** 成员 / 群核心笔记；version 用于保存时防覆盖 */
export interface BotNotesInfo {
  content: string;
  version: string;
  maxChars: number;
}
export type BotNotesResult = { ok: true; notes: BotNotesInfo } | BotIpcError;

export interface BotQueueItem {
  chatId: string;
  botId: string;
  conversationId: string;
  /** 0 = 下一个补位 */
  position: number;
  reason?: BotQueueReason;
}

/** turn：同会话上一轮未结束；capacity：并发名额已满（同工作区写冲突在工具调用内等待） */
export type BotQueueReason = 'turn' | 'capacity';

export interface BotSessionRecord {
  conversationId: string;
  botId: string;
  lifecycle: ConversationAuthority['lifecycle'];
  /** 是否为 chat.sessions 里当前在用的会话；其余为只读历史 */
  current: boolean;
}

export type BotsListResult = { ok: true; bots: BotProfile[]; enabled: boolean } | BotIpcError;
export type BotGetResult = { ok: true; bot: BotProfile; persona: string } | BotIpcError;
export type BotWriteIpcResult = { ok: true; bot: BotProfile } | BotIpcError;
export type BotChatsListResult =
  | {
      ok: true;
      chats: BotChat[];
      queue: BotQueueItem[];
      enabled: boolean;
      silences?: BotSilence[];
    }
  | BotIpcError;
export type BotChatWriteResult = { ok: true; chat: BotChat } | BotIpcError;
export type BotTimelineResult = { ok: true; entries: GroupEntry[]; lastSeq: number } | BotIpcError;
export type BotChatSessionsResult = { ok: true; sessions: BotSessionRecord[] } | BotIpcError;
export type BotSendResult =
  | { ok: true; conversationId?: string; queued?: boolean; turnId?: string; duplicate?: true }
  | BotIpcError;
export type BotChatStateResult =
  | {
      ok: true;
      current: string | null;
      queue: string[];
      hops: number;
      turnsByBot: Record<string, number>;
      pendingHuman: boolean;
      /** 正在智能选人（分类中） */
      routing: boolean;
    }
  | BotIpcError;
/** 私聊返回新会话；群聊返回分隔线 seq（当前段为空时不变） */
export type BotNewSessionResult =
  | { ok: true; conversationId: string }
  | { ok: true; epochSeq: number }
  | BotIpcError;
export type BotActionResult = { ok: true } | BotIpcError;

export interface BotSendRequest {
  chatId: string;
  text: string;
  images?: AttachedImage[];
  deliveryId: string;
  /** 输入框 @文件：工作区相对路径（正文里已有 @path），Main 校验在聊天工作区内 */
  files?: string[];
  /** 输入框 @聊天：被引用的 Bot 聊天 id（≤3），Main 投递时注入其最近 3 轮摘录 */
  chats?: string[];
  /** 输入框 $技能：技能 id；私聊须是成员技能，群聊按被投递成员各自解析 */
  skill?: string;
}

/** @文件补全：工作区根由 Main 按 chatId 推导 */
export interface BotFileSearchRequest {
  chatId: string;
  query: string;
}
export type BotFileSearchResult =
  | { ok: true; files: { relativePath: string; name: string }[] }
  | BotIpcError;

/** 全文搜索：query 去首尾空白后 1..200 字符；limit 缺省 50，上限 100 */
export const BOT_SEARCH_QUERY_MAX = 200;
export const BOT_SEARCH_LIMIT_DEFAULT = 50;
export const BOT_SEARCH_LIMIT_MAX = 100;

export interface BotSearchRequest {
  query: string;
  limit?: number;
}

/** 命中定位：群按时间线 seq；私聊按会话内消息绝对下标（与历史投影同一编号） */
export type BotSearchLocator =
  | { kind: 'timeline'; seq: number }
  | { kind: 'session'; conversationId: string; messageIndex: number; current: boolean };

export interface BotSearchHit {
  chatId: string;
  chatKind: BotChat['kind'];
  speaker: { kind: 'human' } | { kind: 'bot'; botId: string };
  at: number;
  /** 空白已折叠的片段，裁剪处带「…」 */
  snippet: string;
  /** snippet 内的命中区间 [start, end) */
  ranges: Array<[number, number]>;
  locator: BotSearchLocator;
}

export type BotSearchResult = { ok: true; hits: BotSearchHit[]; truncated: boolean } | BotIpcError;

/** 产物卡片挂在哪条消息：群 bot 条目按 entryId；私聊按会话 + 该轮任一助手消息下标 */
export type BotArtifactTarget =
  | { chatId: string; entryId: string }
  | { chatId: string; conversationId: string; messageIndex: number };

export type BotArtifactKind = 'image' | 'markdown' | 'html' | 'pdf' | 'text' | 'other';

export interface BotArtifact {
  /** 相对工作区根的路径，同时是后续预览 / 打开的标识（Main 会重新推导并比对） */
  rel: string;
  name: string;
  size: number;
  kind: BotArtifactKind;
}

/** media：该轮 send_image 发出的图（含展示用的失败项），最多 4 张 */
export type BotArtifactsResult =
  | { ok: true; artifacts: BotArtifact[]; media: BotMediaItem[] }
  | BotIpcError;

/** 读文件产物用 rel；读 send_image 图用 mediaId（thumb = 缩略图） */
export type BotArtifactReadRequest = BotArtifactTarget &
  ({ rel: string } | { mediaId: string; variant?: 'thumb' | 'full' });

export type BotArtifactReadResult =
  | { ok: true; kind: 'image'; dataUrl: string }
  | { ok: true; kind: 'markdown' | 'html' | 'text'; text: string }
  | BotIpcError;

/** reveal：在访达中显示；open：默认应用打开（可执行文件拒绝）；preview：PDF 独立预览窗口 */
export type BotArtifactOpenAction = 'reveal' | 'open' | 'preview';

/** 团队预览：模板传 team，导入传文件原文 text；Main 严格校验并按现有成员/保留名自动改名 */
export type BotTeamPreviewRequest = { team: TeamSpec } | { text: string };
export type BotTeamPreviewResult =
  | { ok: true; team: TeamSpec; renamed: TeamRename[] }
  | (BotIpcError & { error: TeamFileError | 'disabled' | 'unavailable' });

export type BotTemplatesResult = { ok: true; library: BotTemplateLibrary } | BotIpcError;

export interface BotTeamCreateRequest {
  team: TeamSpec;
  workspace: { kind: 'chat-home' } | { kind: 'project'; projectId: string };
  assets?: TeamMemberAssets;
}
/** 成员与群一次性创建，任一步失败全部回滚 */
export type BotTeamCreateResult = { ok: true; chat: BotChat; bots: BotProfile[] } | BotIpcError;
