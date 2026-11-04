import { THEME_ANCHORS } from './anchors';

const anchorLines = THEME_ANCHORS.map((anchor) => ` *   [data-enso="${anchor}"]`).join('\n');

/** 首次「打开 user.css」时写入；整份是注释，打开开关前后界面不变 */
export const USER_CSS_TEMPLATE = `/*
 * EnsoCode user.css
 *
 * 在「设置 → 外观 → 自定义 CSS」打开开关后，本文件注入主窗口与设置窗口，保存即生效。
 * Enable "Settings → Appearance → Custom CSS" to inject this file; changes apply on save.
 *
 * 它排在主题 token 与主题 CSS 之后，普通的 :root / .dark 规则就能覆盖颜色变量：
 *   --canvas --background --foreground --muted --muted-foreground --subtle-foreground
 *   --border --input --sunken --brand --brand-foreground --elevation-surface
 *
 * 稳定锚点（组件上的 data-enso 属性）/ Stable anchors:
${anchorLines}
 *
 * 示例（去掉行首的 " * " 即可启用）/ Examples:
 *
 * :root { --brand: oklch(0.62 0.19 25); }
 *
 * [data-enso="composer"] { border-radius: 12px; }
 */
`;
