/**
 * 在途时再调用不并发重跑：合并成一次尾随执行（保证调用之后的状态被看到），调用方都等它结束。
 */
export function coalesceRuns<T>(task: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const run = task().finally(() => {
      if (current === run) current = null;
    });
    current = run;
    return run;
  };
  return () => {
    if (!current) return start();
    next ??= current
      .catch(() => undefined)
      .then(() => {
        next = null;
        return start();
      });
    return next;
  };
}

/** 有上限的并发 map：结果按输入顺序 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
