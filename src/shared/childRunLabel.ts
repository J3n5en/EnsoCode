const INSTANCE_SUFFIX = /-([0-9a-f]{8})$/i;

/** 子代理历史行的可见名：优先任务标题，否则去掉实例名末尾的 8 位哈希。 */
export function childRunLabel(item: { name: string; title?: string }): string {
  const title = item.title?.trim();
  if (title) return title;
  const stripped = item.name.replace(INSTANCE_SUFFIX, '').trim();
  return stripped || item.name;
}
