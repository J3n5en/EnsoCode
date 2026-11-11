/** 按工具名去掉本次运行明确禁用的工具。组 id（如 web）不在这里处理。 */
export function omitNamedTools<T extends { name: string }>(
  tools: readonly T[],
  disabled: readonly string[]
): T[] {
  if (disabled.length === 0) return [...tools];
  const off = new Set(disabled.map((name) => name.toLowerCase()));
  return tools.filter((tool) => !off.has(tool.name.toLowerCase()));
}
