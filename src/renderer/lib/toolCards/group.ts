/** 连续同名、且交给卡片渲染的工具调用。中间任何其它行都会断开。 */
export function mergeRuns<T extends { kind: string; name?: string }>(
  items: readonly T[],
  accepts: (name: string) => boolean,
  merge: (head: T, rest: readonly T[]) => T
): T[] {
  const result: T[] = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index];
    if (item.kind !== 'tool' || !item.name || !accepts(item.name)) {
      result.push(item);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < items.length && items[end].kind === 'tool' && items[end].name === item.name) {
      end += 1;
    }
    result.push(end - index >= 2 ? merge(item, items.slice(index + 1, end)) : item);
    index = end;
  }
  return result;
}
