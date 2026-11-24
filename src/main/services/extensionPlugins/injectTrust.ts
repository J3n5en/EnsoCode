import type { ExtensionPluginPermission } from '@shared/extensionPlugins/manifest';
import type { PluginInjectOrigin, PluginInjectSender } from '@shared/extensionPlugins/protocol';
import { GITHUB_LOGIN } from '@shared/secretary/githubLogin';
import { wrapPluginDelivery } from '@shared/secretary/transcript';
import type { PluginInstallSource } from './install';

/**
 * 临时过渡：这三个官方插件投递的是用户自己定的任务，旧版还不会声明 agent.injectTrusted。
 * 只认从市场装的；插件声明了这项权限后自动不再兜底。三个插件都发了新版就删掉。
 */
const LEGACY_TRUSTED_INJECT = new Set(['enso.scheduler', 'enso.kanban', 'enso.bridge']);

/** 一次投递能否免去不可信包裹；ignored 表示插件要了 trusted 但没有权限 */
export function resolveInjectTrust(input: {
  pluginId: string;
  requested: boolean;
  permissions: readonly ExtensionPluginPermission[];
  source?: PluginInstallSource;
}): { trusted: boolean; ignored: boolean } {
  if (input.permissions.includes('agent.injectTrusted'))
    return { trusted: input.requested, ignored: false };
  const legacy =
    LEGACY_TRUSTED_INJECT.has(input.pluginId) &&
    input.source?.kind === 'market' &&
    input.source.id === input.pluginId;
  return { trusted: legacy, ignored: input.requested && !legacy };
}

/** Main 联系人绑定。Telegram 主人与私聊分开，避免群 chatId 被当成主人 */
export interface OwnerBindings {
  telegramOwnerIds: ReadonlySet<string>;
  telegramPrivateChatIds: ReadonlySet<string>;
  /** key 是小写 channelId */
  channelOwnerIds?: ReadonlyMap<string, ReadonlySet<string>>;
  /** 小写 GitHub login */
  githubLogins?: ReadonlySet<string>;
  /** 任一秘书打开：非主人投递必须主人确认 */
  externalConfirm?: boolean;
}

const EMPTY_OWNER_BINDINGS: OwnerBindings = {
  telegramOwnerIds: new Set(),
  telegramPrivateChatIds: new Set(),
};

export function isBoundOwner(
  sender: PluginInjectSender | undefined,
  bindings: OwnerBindings
): boolean {
  if (!sender) return false;
  const channel = sender.channel.toLowerCase();
  if (channel === 'telegram' || channel === 'tg') {
    if (sender.userId) return bindings.telegramOwnerIds.has(sender.userId);
    if (sender.chatId) return bindings.telegramPrivateChatIds.has(sender.chatId);
    return false;
  }
  const peers = bindings.channelOwnerIds?.get(channel);
  if (!peers) return false;
  if (sender.userId) return peers.has(sender.userId);
  if (sender.chatId) return peers.has(sender.chatId);
  return false;
}

function isOfficialGithub(input: { pluginId: string; source?: PluginInstallSource }): boolean {
  return (
    input.pluginId === 'enso.github' &&
    input.source?.kind === 'market' &&
    input.source.id === 'enso.github'
  );
}

/**
 * github 渠道只认官方市场插件 enso.github 上、已绑定的 login。
 * 别的插件自称 github、bot、没有 userId，都不是主人。Telegram 和其他渠道仍走 isBoundOwner。
 */
function senderIsOwnerOf(input: PluginInjectDeliveryInput, bindings: OwnerBindings): boolean {
  const sender = input.sender;
  if (!sender) return false;
  if (sender.channel.toLowerCase() !== 'github') return isBoundOwner(sender, bindings);
  if (!isOfficialGithub(input) || !sender.userId || !GITHUB_LOGIN.test(sender.userId)) return false;
  return bindings.githubLogins?.has(sender.userId.toLowerCase()) ?? false;
}

export interface PluginInjectDeliveryInput {
  pluginId: string;
  text: string;
  requestedTrusted: boolean;
  permissions: readonly ExtensionPluginPermission[];
  source?: PluginInstallSource;
  isSecretarySession: boolean;
  sender?: PluginInjectSender;
  ownerBindings?: OwnerBindings;
  redact?: (text: string) => string;
}

export interface PluginInjectDeliveryDecision {
  text: string;
  origin: PluginInjectOrigin;
  unwrapped: boolean;
  trustedIgnored: boolean;
  trustedOverriddenByExternal: boolean;
  senderIsOwner: boolean;
  /** 非主人，且主人打开了「必须确认」 */
  ownerConfirm: boolean;
}

export type PluginInjectPrepareInput = Pick<
  PluginInjectDeliveryInput,
  'pluginId' | 'text' | 'requestedTrusted' | 'permissions' | 'source' | 'sender'
>;

/** #412 的免包资格和「外部原文除非主人否则一律包裹」收成一次判定 */
export function resolvePluginInjectDelivery(
  input: PluginInjectDeliveryInput
): PluginInjectDeliveryDecision {
  const base = resolveInjectTrust({
    pluginId: input.pluginId,
    requested: input.requestedTrusted,
    permissions: input.permissions,
    source: input.source,
  });
  const senderIsOwner = input.sender
    ? senderIsOwnerOf(input, input.ownerBindings ?? EMPTY_OWNER_BINDINGS)
    : false;
  const origin: PluginInjectOrigin = input.sender
    ? senderIsOwner
      ? 'owner'
      : 'external'
    : base.trusted
      ? 'owner'
      : 'external';
  const trustedOverriddenByExternal = Boolean(input.sender && !senderIsOwner && base.trusted);
  const ownerConfirm = origin === 'external' && input.ownerBindings?.externalConfirm === true;
  // 有发送者一律包裹，主人也标 role。没发送者时，可信的普通会话仍免包
  const unwrapped = !input.isSecretarySession && base.trusted && !input.sender;
  if (unwrapped) {
    return {
      text: input.text,
      origin,
      unwrapped: true,
      trustedIgnored: base.ignored,
      trustedOverriddenByExternal: false,
      senderIsOwner,
      ownerConfirm,
    };
  }
  const body = input.isSecretarySession ? (input.redact?.(input.text) ?? input.text) : input.text;
  return {
    text: wrapPluginDelivery(input.pluginId, body, {
      ...(input.sender ? { sender: input.sender } : {}),
      role: origin,
    }),
    origin,
    unwrapped: false,
    trustedIgnored: base.ignored,
    trustedOverriddenByExternal,
    senderIsOwner,
    ownerConfirm,
  };
}
