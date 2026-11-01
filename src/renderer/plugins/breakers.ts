/** 对比插件列表里的拦截熔断，返回新出现的一批；seen 记录已提示过的 */
export function newInterceptBreakers(
  plugins: readonly {
    id: string;
    name: string;
    interceptBreakers?: readonly { event: string; until: number }[];
  }[],
  seen: Set<string>
): { pluginName: string; event: string }[] {
  const current = new Set<string>();
  const fresh: { pluginName: string; event: string }[] = [];
  for (const plugin of plugins) {
    for (const breaker of plugin.interceptBreakers ?? []) {
      const key = `${plugin.id}:${breaker.event}:${breaker.until}`;
      current.add(key);
      if (!seen.has(key)) fresh.push({ pluginName: plugin.name, event: breaker.event });
    }
  }
  seen.clear();
  for (const key of current) seen.add(key);
  return fresh;
}
