export interface MarketLoadRequest {
  installedKey: string;
  /** true：向市场要新索引；false：沿用本次进程里已有的索引，只更新安装状态 */
  refresh: boolean;
}

/** 对话框挂载就是一次打开，必须拉索引。 */
export function openMarketLoadRequest(installedKey: string): MarketLoadRequest {
  return { installedKey, refresh: true };
}

/**
 * 已装版本键没变时保持同一次请求，避免效果重复拉索引。
 * 键变了只为刷新「已安装」标记，不重新请求市场。
 */
export function nextMarketLoadRequest(
  current: MarketLoadRequest,
  installedKey: string
): MarketLoadRequest {
  if (current.installedKey === installedKey) return current;
  return { installedKey, refresh: false };
}
