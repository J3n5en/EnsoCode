/** 插件市场的固定分类；索引里的 category 只认这些，市场页按此顺序列出 */
export const MARKET_CATEGORIES = [
  'themes',
  'agent',
  'productivity',
  'integrations',
  'insights',
  'writing',
  'fun',
] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export const MARKET_CATEGORY_LABELS: Record<MarketCategory, string> = {
  themes: '主题外观',
  agent: 'Agent 能力',
  productivity: '效率工作流',
  integrations: '外部集成',
  insights: '观测统计',
  writing: '写作翻译',
  fun: '休闲娱乐',
};

export const isMarketCategory = (value: unknown): value is MarketCategory =>
  (MARKET_CATEGORIES as readonly unknown[]).includes(value);

export const MAX_MARKET_SCREENSHOTS = 6;

export interface MarketScreenshot {
  url: string;
  alt: string;
}
