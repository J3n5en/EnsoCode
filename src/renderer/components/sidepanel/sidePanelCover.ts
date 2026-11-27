/**
 * 右侧面板当前是否会全宽盖在主聊天区之上：
 * - 桌面端显式全屏且面板开启时盖住主聊天区；
 * - 手机端（窄视口）没有并排空间，只要面板开启就全宽盖住主聊天区。
 *
 * 透明背景图模式下底色 alpha=0，App 与 BotChatView 必须据此藏掉被盖正文，
 * 避免正文从透明面板底下透上来形成叠字。
 */
export function sidePanelCoversMain(input: {
  open: boolean;
  fullscreen?: boolean;
  isMobile: boolean;
}): boolean {
  return input.open && (Boolean(input.fullscreen) || input.isMobile);
}
