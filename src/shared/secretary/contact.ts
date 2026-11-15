import type { SecretaryProposal, SecretaryResultKind } from '../types/secretary';

/** 绑定码有效期：与 deepchat 的配对码同一量级，够慢手操作，又不给陌生人留窗口 */
export const CONTACT_BIND_CODE_TTL_MS = 10 * 60 * 1000;
export const CONTACT_BIND_CODE_LENGTH = 6;
/** 对不上太多次就作废这个码：陌生人猜码猜不穿 10 分钟窗口 */
export const CONTACT_BIND_MAX_FAILURES = 5;
/** Telegram 单条上限 4096，留点余量给省略号 */
export const CONTACT_OUTBOUND_MAX_CHARS = 3900;
/** 手机上一屏能读完的正文上限 */
export const CONTACT_TEXT_MAX_CHARS = 180;

export type ContactLang = 'zh' | 'en';

/**
 * BotFather 的 token 形状：<bot id>:<密钥>。只做形状校验，真假一律由 getMe 定。
 * 收窄在这里做，是为了不把明显的错字（少了冒号、贴了 username）发到网络上去。
 */
export function normalizeBotToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(trimmed)) return null;
  return trimmed;
}

/** 界面上只显示 bot id 与密钥前两位，够认出是哪一个，不足以复用它 */
export function botTokenHint(token: string): string {
  const [id, secret = ''] = token.split(':');
  return `${id}:${secret.slice(0, 2)}…`;
}

/** 6 位数字绑定码；random 由调用方注入，测试里可复现 */
export function createBindCode(random: () => number): string {
  const value = Math.floor(Math.abs(random()) * 1_000_000) % 1_000_000;
  return String(value).padStart(CONTACT_BIND_CODE_LENGTH, '0');
}

/** 手机点一下就完成绑定：Telegram 会把 start 参数原样回给 bot */
export function bindDeepLink(username: string, code: string): string {
  return `https://t.me/${username.replace(/^@/, '')}?start=${code}`;
}

/** 从 /start 或 /start <code> 里取码；带 @botname 后缀也认 */
export function startCommandCode(text: string): string | null {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  return match[1] ?? null;
}

/** 码要对得上、没过期、且还没被用掉 */
export function bindCodeUsable(
  bind: { code: string; expiresAt: number } | undefined,
  code: string,
  now: number
): boolean {
  if (!bind) return false;
  if (bind.expiresAt <= now) return false;
  return bind.code === code;
}

/** 只认绑定的那个 chat：群、频道、别人的私聊一律不算 */
export function isBoundChat(bound: number | undefined, incoming: number): boolean {
  return typeof bound === 'number' && Number.isInteger(incoming) && bound === incoming;
}

/**
 * 出站是否发这条里程碑：off 全不发；needs-user 只发要人处理的；
 * with-done 再加上做完的。中间进度（turn-ended）与静默回合永远不发。
 */
export function shouldForwardMilestone(
  mode: 'needs-user' | 'with-done' | 'off',
  kind: SecretaryResultKind
): boolean {
  if (mode === 'off') return false;
  if (kind === 'turn-ended') return false;
  if (kind === 'goal-complete') return mode === 'with-done';
  return true;
}

const MILESTONE_LABEL: Record<ContactLang, Record<SecretaryResultKind, string>> = {
  zh: {
    'goal-complete': '✅ 完成',
    'goal-blocked': '⛔ 受阻',
    'turn-ended': '· 一轮结束',
    'needs-user': '👉 需要你',
    failed: '❌ 失败',
    stalled: '⏳ 停滞',
    interrupted: '⚠️ 中断',
  },
  en: {
    'goal-complete': '✅ Done',
    'goal-blocked': '⛔ Blocked',
    'turn-ended': '· Turn ended',
    'needs-user': '👉 Needs you',
    failed: '❌ Failed',
    stalled: '⏳ Stalled',
    interrupted: '⚠️ Interrupted',
  },
};

/** 回到应用的深链：Main 收到后聚焦窗口并选中这个会话 */
export function conversationDeepLink(conversationId: string): string {
  return `enso://secretary?conversation=${encodeURIComponent(conversationId)}`;
}

/** 定位到具体那张确认卡：会话选中后再把工作台滚到这张卡 */
export function proposalDeepLink(conversationId: string, proposalId: string): string {
  return `${conversationDeepLink(conversationId)}&proposal=${encodeURIComponent(proposalId)}`;
}

function oneLine(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > CONTACT_TEXT_MAX_CHARS ? `${flat.slice(0, CONTACT_TEXT_MAX_CHARS)}…` : flat;
}

/** 手机上读的一条里程碑：一行状态 + 会话标题，一句正文，一个回应用的链接 */
export function formatMilestoneMessage(
  lang: ContactLang,
  input: { kind: SecretaryResultKind; title: string; lastText?: string; link?: string }
): string {
  const lines = [`${MILESTONE_LABEL[lang][input.kind]} · ${input.title.trim()}`];
  const body = oneLine(input.lastText);
  if (body) lines.push(body);
  if (input.link) lines.push(input.link);
  return lines.join('\n');
}

const ASK_HINT: Record<ContactLang, string> = {
  zh: '点按钮，或直接回一句话。应用里先答了就以那边为准。',
  en: 'Tap a button or just reply. Whichever side answers first wins.',
};

/** 秘书用 ask_user 问 J 哥：问题、选项、怎么答，一条说完 */
export function formatAskMessage(
  lang: ContactLang,
  input: { question: string; options?: readonly string[]; title?: string }
): string {
  const lines = [input.title ? `❓ ${input.title}` : lang === 'zh' ? '❓ 秘书问你' : '❓ Question'];
  lines.push(input.question.trim());
  if (input.options && input.options.length > 0) {
    lines.push(...input.options.map((option, index) => `${index + 1}. ${option}`));
  }
  lines.push(ASK_HINT[lang]);
  return lines.join('\n');
}

/** 手机上能看到的卡片类型：按钮与提示都用它说清是哪一类 */
export type SecretaryCardKind = SecretaryProposal['kind'];

const CARD_KIND_LABEL: Record<ContactLang, Record<SecretaryCardKind, string>> = {
  zh: {
    dispatch: '派发',
    profile: '设置',
    skill: '技能',
    tool: '工具',
    takeover: '接管',
    cleanup: '清理',
  },
  en: {
    dispatch: 'dispatch',
    profile: 'settings',
    skill: 'skill',
    tool: 'tool',
    takeover: 'takeover',
    cleanup: 'cleanup',
  },
};

export function isSecretaryCardKind(value: unknown): value is SecretaryCardKind {
  return (
    value === 'dispatch' ||
    value === 'profile' ||
    value === 'skill' ||
    value === 'tool' ||
    value === 'takeover' ||
    value === 'cleanup'
  );
}

/** 卡片的一句话标签：派发取标题或首句，其余取名字，接管取会话标题 */
export function proposalCardTitle(proposal: SecretaryProposal): string | undefined {
  switch (proposal.kind) {
    case 'dispatch':
      return (
        proposal.draft.title?.trim() || proposal.draft.prompt.split('\n')[0]?.trim() || undefined
      );
    case 'profile':
      return proposal.draft.name?.trim() || undefined;
    case 'skill':
    case 'tool':
      return proposal.draft.name;
    case 'takeover':
      return proposal.draft.title?.trim() || proposal.draft.conversationId;
    case 'cleanup':
      return proposal.draft.items.length > 0
        ? `${proposal.draft.items.length} 项待清理`
        : undefined;
  }
}

/** Telegram 按钮文案上限 64 字节，中文按 3 字节算，标题留 24 个字 */
const CARD_TITLE_MAX_CHARS = 24;

function shortTitle(title: string | undefined): string {
  const flat = (title ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > CARD_TITLE_MAX_CHARS ? `${flat.slice(0, CARD_TITLE_MAX_CHARS)}…` : flat;
}

/** 「确认派发：秘书看板改用 kanban」：一眼看出确认的是哪张卡 */
export function cardConfirmButtonText(
  lang: ContactLang,
  kind: SecretaryCardKind,
  title?: string
): string {
  const label = CARD_KIND_LABEL[lang][kind];
  const head = lang === 'zh' ? `确认${label}` : `Confirm ${label}`;
  const rest = shortTitle(title);
  return rest ? `${head}：${rest}` : head;
}

export function cardOpenButtonText(lang: ContactLang): string {
  return lang === 'zh' ? '在应用里打开' : 'Open in the app';
}

/** 卡片类型的一句话标签，审计与提示共用 */
export function cardKindLabel(lang: ContactLang, kind: SecretaryCardKind): string {
  return CARD_KIND_LABEL[lang][kind];
}

/**
 * 确认卡与审批：默认只提示回应用确认。
 * confirmable 只在「允许从 Telegram 确认卡片」打开且这条消息带的是确认卡时才是真的；
 * 审批永远只有提示。
 */
export function formatCardWaitingMessage(
  lang: ContactLang,
  input: {
    count: number;
    title?: string;
    confirmable?: boolean;
    approval?: boolean;
    link?: string;
  }
): string {
  const head = lang === 'zh' ? '🗂 有一张卡在等你' : '🗂 A card is waiting';
  let body: string;
  if (input.approval) {
    body =
      lang === 'zh'
        ? '审批只能在应用里处理，手机上没有确认入口。'
        : 'Approvals can only be handled in the app; there is no confirm button here.';
  } else if (input.confirmable) {
    body =
      lang === 'zh'
        ? '点下面的按钮直接确认。审批永远只能在应用里处理。'
        : 'Tap a button below to confirm. Approvals always stay in the app.';
  } else {
    body =
      lang === 'zh'
        ? '请回应用确认：开关关着，手机上不提供确认按钮。审批永远只能在应用里处理。'
        : 'Confirm it in the app: the switch is off, so there is no confirm button here. Approvals always stay in the app.';
  }
  const lines = [input.title ? `${head} · ${input.title}` : head, body];
  if (input.count > 1) lines.push(lang === 'zh' ? `共 ${input.count} 张` : `${input.count} cards`);
  if (input.link) lines.push(input.link);
  return lines.join('\n');
}

/** 卡片处理掉之后原消息补一行，按钮同时清掉 */
export function cardHandledLine(lang: ContactLang): string {
  return lang === 'zh' ? '· 已处理' : '· Handled';
}

/** 确认卡片的按钮：card:<槽位>:c|r|o，槽位同样是内存里的短编号 */
export function cardCallbackData(slot: number, action: 'confirm' | 'reject' | 'open'): string {
  const code = action === 'confirm' ? 'c' : action === 'reject' ? 'r' : 'o';
  return `card:${slot}:${code}`;
}

export function parseCardCallbackData(
  data: string
): { slot: number; action: 'confirm' | 'reject' | 'open' } | null {
  const match = /^card:(\d{1,6}):([cro])$/.exec(data.trim());
  if (!match) return null;
  const action = match[2] === 'c' ? 'confirm' : match[2] === 'r' ? 'reject' : 'open';
  return { slot: Number(match[1]), action };
}

/** 卡片确认后的提示：说清确认了哪一类哪一张 */
export function cardCallbackToast(
  lang: ContactLang,
  action: 'confirm' | 'reject' | 'open',
  card?: { kind: SecretaryCardKind; title?: string }
): string {
  if (action === 'open') return lang === 'zh' ? '已在应用里打开' : 'Opened in the app';
  const label = card ? cardKindLabel(lang, card.kind) : '';
  const title = shortTitle(card?.title);
  const target = [label, title].filter(Boolean).join(' ');
  if (action === 'reject') {
    return lang === 'zh'
      ? `已拒绝${target ? `：${target}` : '这张卡'}`
      : `Rejected${target ? `: ${target}` : ' the card'}`;
  }
  return lang === 'zh'
    ? `已确认${target ? `：${target}` : '这张卡'}`
    : `Confirmed${target ? `: ${target}` : ' the card'}`;
}

/** 绑定完成后的欢迎消息：告诉 J 哥现在能做什么 */
export function formatWelcomeMessage(lang: ContactLang, name: string): string {
  return lang === 'zh'
    ? `已连上 ${name}。里程碑会推到这里；直接回话就是跟秘书说话。派发确认与审批请回应用处理。`
    : `${name} is connected. Milestones arrive here; reply to talk to the secretary. Dispatch confirmations and approvals stay in the app.`;
}

/** inline 按钮的回调数据：ask:<槽位>:<选项序号>，槽位是内存里的短编号，躲开 64 字节上限 */
export function askCallbackData(slot: number, index: number): string {
  return `ask:${slot}:${index}`;
}

export function parseAskCallbackData(data: string): { slot: number; index: number } | null {
  const match = /^ask:(\d{1,6}):(\d{1,2})$/.exec(data.trim());
  if (!match) return null;
  return { slot: Number(match[1]), index: Number(match[2]) };
}

/** /feed 的「更早」按钮：游标存在 Main 内存里，按钮上只带短编号 */
export function feedCallbackData(token: string): string {
  return `feed:${token}`;
}

export function parseFeedCallback(data: string): string | null {
  const match = /^feed:([A-Za-z0-9]{1,8})$/u.exec(data.trim());
  return match ? match[1] : null;
}

/** 手机点按钮后 Telegram 顶部的提示 */
export function askCallbackToast(lang: ContactLang, option: string): string {
  const capped = option.length > 40 ? `${option.slice(0, 40)}…` : option;
  return lang === 'zh' ? `已回答：${capped}` : `Answered: ${capped}`;
}

/**
 * 手机发来的一句话进秘书会话时的正文：应用写的那一行说明「这是用户本人从手机发的」，
 * 用户正文按外部文本包裹——转发来的内容里可能藏着指令，只有用户真的要求才执行。
 */
/** 「发一条测试消息」：确认手机这一侧真的收得到 */
export function formatTestMessage(lang: ContactLang, name: string): string {
  return lang === 'zh'
    ? `✅ 测试消息：${name} 能连到你。`
    : `✅ Test message: ${name} can reach you.`;
}
