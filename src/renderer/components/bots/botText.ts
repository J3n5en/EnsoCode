import { imageSendErrorText } from '@shared/bots/sendImage';
import type { TeamFileError } from '@shared/bots/team';
import type { BotChat, BotProfile } from '@shared/types/bot';
import type { Project } from '@shared/types/project';
import type { TFunction } from '@/i18n';

export function teamFileErrorText(error: TeamFileError | string, t: TFunction): string {
  switch (error) {
    case 'too-large':
      return t('This team file is too large.');
    case 'invalid-json':
      return t('This file is not valid JSON.');
    case 'unsupported-version':
      return t('This team file comes from an unsupported version.');
    case 'invalid':
      return t('This file is not a valid EnsoCode team file.');
    default:
      return error;
  }
}

/** 成员写入失败 reason → 文案 */
export function botErrorText(reason: string | undefined, error: string, t: TFunction): string {
  switch (reason) {
    case 'invalid':
      return t('Names can use up to 24 letters, digits, _ or -, without spaces.');
    case 'reserved':
      return t('This name is reserved. Choose another one.');
    case 'duplicate':
      return t('Another member already uses this name.');
    case 'conflict':
      return t('This member was changed elsewhere. Refresh and try again.');
    case 'not-found':
      return t('This member no longer exists.');
    default:
      return error;
  }
}

export function chatErrorText(error: string, t: TFunction): string {
  const imageError = imageSendErrorText(error);
  if (imageError) return t(imageError);
  switch (error) {
    case 'chat-archived':
      return t('This chat is archived. Restore it before sending.');
    case 'group-not-ready':
    case 'group-unavailable':
      return t('Group chat is not available right now.');
    case 'conflict':
      return t('This chat was changed elsewhere. Refresh and try again.');
    case 'budget-exceeded':
      return t("This member's daily budget is used up. Try again tomorrow or raise the budget.");
    case 'chat-ref-not-found':
      return t('The referenced chat no longer exists.');
    case 'chat-ref-self':
      return t('A chat cannot reference itself.');
    case 'file-outside-workspace':
      return t("The file is not inside this chat's workspace.");
    case 'skill-unavailable':
      return t('This skill is not available to the member.');
    case 'session-busy':
      return t('The member is busy. Try again after the current turn.');
    case 'retry-unavailable':
      return t('This reply can no longer be retried. Please send your request again.');
    case 'rewind-target-not-found':
      return t('That message is no longer on the current branch.');
    default:
      return error;
  }
}

export function chatTitle(chat: BotChat, bots: readonly BotProfile[], t: TFunction): string {
  if (chat.kind === 'direct') {
    return bots.find((bot) => bot.id === chat.members[0])?.name ?? t('Deleted member');
  }
  return chat.title || t('Untitled group');
}

export function workspaceLabel(
  chat: BotChat,
  projects: readonly Project[],
  bots: readonly BotProfile[],
  t: TFunction
): string {
  switch (chat.workspace.kind) {
    case 'member-home': {
      const name = bots.find((bot) => bot.id === chat.members[0])?.name ?? '';
      return t("{{name}}'s workspace", { name });
    }
    case 'chat-home':
      return t('Group workspace');
    case 'project': {
      const projectId = chat.workspace.projectId;
      const project = projects.find((item) => item.id === projectId);
      return project ? project.alias || project.name : t('Missing project');
    }
  }
}

/** 只有本地项目能当 Bot 工作区 */
export function localProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => project.kind !== 'ssh');
}

/** 「X 的副本」重名时依次加 2、3… */
export function cloneTitle(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}
