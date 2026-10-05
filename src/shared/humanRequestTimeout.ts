/** Bot 群聊里审批卡 / 提问卡等人处理的时限（截止时间以 Main 的墙钟为准） */
export const HUMAN_REQUEST_TIMEOUT_MS = 10 * 60_000;

export const APPROVAL_TIMEOUT_PREFIX = '审批超时（10 分钟未处理）';
export const ASK_TIMEOUT_PREFIX = '提问超时（10 分钟未回答）';

export const APPROVAL_TIMEOUT_ERROR = `${APPROVAL_TIMEOUT_PREFIX}: nobody handled this approval within 10 minutes, so it was auto-denied. This is NOT a user decision. Try another approach that does not need this approval, or stop and explain what you need approved.`;
export const ASK_TIMEOUT_ERROR = `${ASK_TIMEOUT_PREFIX}: the user did not answer within 10 minutes. This is not an answer. Continue only with an assumption you state explicitly, or stop and explain what you need from the user.`;

export const isHumanRequestTimeout = (text: string): boolean =>
  text.startsWith(APPROVAL_TIMEOUT_PREFIX) || text.startsWith(ASK_TIMEOUT_PREFIX);
