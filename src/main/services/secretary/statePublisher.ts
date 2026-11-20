/**
 * 秘书状态广播：派出会话的每个事件都会请求一次，整份状态有几百 KB，
 * 远端界面要经隧道接收。空闲时立即发，密集时按间隔合并成一次尾随发布，内容未变不发。
 */
export function createStatePublisher<T>(options: {
  build: () => Promise<T>;
  emit: (state: T) => void;
  intervalMs: number;
}): () => void {
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let lastJson: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;

  const run = async (): Promise<void> => {
    pending = false;
    running = true;
    lastRunAt = Date.now();
    try {
      const state = await options.build();
      const json = JSON.stringify(state);
      if (json !== lastJson) {
        lastJson = json;
        options.emit(state);
      }
    } catch {
      // 构建失败留给下一次请求
    } finally {
      running = false;
      if (pending) request();
    }
  };

  const request = (): void => {
    pending = true;
    if (timer || running) return;
    const wait = lastRunAt + options.intervalMs - Date.now();
    if (wait <= 0) {
      void run();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, wait);
  };

  return request;
}
