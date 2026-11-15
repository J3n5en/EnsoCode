// 验收脚本的纯隔离规则：目录、端口、进程归属。进程树只认 pid/ppid，不看命令行。

export function explicitPort(name, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return port;
}

export function keepRequested(env, argv) {
  const raw = env.SEC_VERIFY_KEEP;
  if (raw === '1' || raw === 'true') return true;
  return argv.includes('--keep');
}

/** mk-env 只接受 /tmp 前缀，自动目录必须落在 /tmp 而不是 os.tmpdir()。 */
export function resolveArtDir(env, createTemp) {
  const given = env.SEC_VERIFY_DIR?.trim();
  if (given) return given;
  return createTemp('/tmp/sec-verify-');
}

/**
 * 从已记录的 pid 和本次 spawn 的根 pid 沿当前 ppid 往下收子孙。
 * 父进程先退出、子进程被领养到 pid 1 之后，只要之前记过，就不会丢。
 */
export function mergeOwnedPids(already, processes, roots) {
  const children = new Map();
  for (const proc of processes) {
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const owned = [];
  const seen = new Set();
  const queue = [];
  const push = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return;
    seen.add(pid);
    owned.push(pid);
    queue.push(pid);
  };
  for (const pid of already) push(pid);
  for (const pid of roots) push(pid);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) push(child);
  }
  return owned;
}

/** 只关闭组长也属于本次进程树的进程组，避免误伤验收脚本自己或其他会话。 */
export function ownedProcessGroups(processes, ownedPids) {
  const owned = new Set(ownedPids);
  const groups = [];
  const seen = new Set();
  for (const proc of processes) {
    if (!owned.has(proc.pid) || !Number.isInteger(proc.pgid) || proc.pgid <= 1) continue;
    if (!owned.has(proc.pgid) || seen.has(proc.pgid)) continue;
    seen.add(proc.pgid);
    groups.push(proc.pgid);
  }
  return groups;
}

export async function reservePorts(requested, open) {
  const held = [];
  const ports = {};
  try {
    for (const key of ['cdp', 'fake', 'plugin', 'renderer', 'telegram']) {
      const want = requested[key];
      let listener;
      try {
        listener = await open(want ?? 0);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
          throw new Error(`port ${want} is already in use`);
        }
        throw error;
      }
      held.push({ key, listener });
      if (want && listener.port !== want) throw new Error(`port ${want} is already in use`);
      ports[key] = listener.port;
    }
  } catch (error) {
    await Promise.all(held.splice(0).map((item) => item.listener.close()));
    throw error;
  }
  return {
    ports,
    // 不在挑完时立刻放开：prepareEnv 和 dev 构建期间其它验收会把同一端口挑走。
    async release(key) {
      const closing = [];
      for (let index = held.length - 1; index >= 0; index--) {
        if (key && held[index].key !== key) continue;
        closing.push(held.splice(index, 1)[0]);
      }
      await Promise.all(closing.map((item) => item.listener.close()));
    },
  };
}
