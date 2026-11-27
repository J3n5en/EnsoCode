export interface GroupOps {
  signal(signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** ESRCH 表示进程组已经没了。macOS 在回收组长前可能短暂 EPERM，重试几次。 */
export async function stopGroup(ops: GroupOps, graceMs = 1000): Promise<string | undefined> {
  let gone = false;
  const attempt = async (signal: NodeJS.Signals | 0): Promise<'ok' | 'gone' | 'denied'> => {
    if (gone) return 'gone';
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        ops.signal(signal);
        return 'ok';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          gone = true;
          return 'gone';
        }
        if (code !== 'EPERM') return 'denied';
        if (retry < 2) await ops.sleep(25);
      }
    }
    return 'denied';
  };
  if ((await attempt('SIGTERM')) === 'gone') return;
  const until = ops.now() + Math.max(0, graceMs);
  while (ops.now() < until) {
    const state = await attempt(0);
    if (state === 'gone') return;
    if (state === 'denied') break;
    await ops.sleep(20);
  }
  if ((await attempt('SIGKILL')) === 'denied') {
    return 'agy process group could not be reaped';
  }
  return;
}

export function stopProcessGroup(
  pid: number | undefined,
  graceMs = 1000
): Promise<string | undefined> {
  if (pid === undefined) return Promise.resolve(undefined);
  return stopGroup(
    {
      signal: (signal) => {
        process.kill(-pid, signal);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    },
    graceMs
  );
}
