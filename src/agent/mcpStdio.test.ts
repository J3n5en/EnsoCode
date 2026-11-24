import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpManager } from './mcp';
import { recordMcpServer, startTimes, sweepOrphanMcpServers } from './mcpStdio';

const posix = process.platform !== 'win32';

/**
 * 假 stdio MCP server：像 HopperMCPServer / `npm exec` 外壳一样不理 stdin EOF，
 * SIGTERM 时自己退出但不管它派生的孙进程（孙进程就是 npx 下面真正的 server）
 */
const FAKE_SERVER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], JSON.stringify({ server: process.pid, grandchild: grandchild.pid }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize')
    reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
});
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

const dirs: string[] = [];
const spawned: number[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-mcp-tree-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startFakeServer(registryDir?: string) {
  const dir = tempDir();
  const script = path.join(dir, 'server.mjs');
  const pidFile = path.join(dir, 'pids.json');
  writeFileSync(script, FAKE_SERVER);
  const manager = new McpManager({ emit: () => {}, processRegistryDir: () => registryDir });
  const tools = await manager.toolsFor([
    { name: 'fake', transport: 'stdio', command: process.execPath, args: [script, pidFile] },
  ]);
  const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { server: number; grandchild: number };
  spawned.push(pids.server, pids.grandchild);
  return { manager, tools, pids };
}

describe.runIf(posix)('stdio MCP server 进程树', () => {
  it('断开连接后 server 与它派生的孙进程都退出，不留孤儿', async () => {
    const { manager, tools, pids } = await startFakeServer();
    expect(tools.map((tool) => tool.name)).toHaveLength(1);
    expect(alive(pids.server) && alive(pids.grandchild)).toBe(true);

    await manager.closeAll();

    expect(await until(() => !alive(pids.server) && !alive(pids.grandchild), 3_000)).toBe(true);
  }, 10_000);

  it('连接期间登记 server 的 pid 与启动时间，断开后撤销登记', async () => {
    const registry = tempDir();
    const { manager, pids } = await startFakeServer(registry);
    const records = readdirSync(registry).map(
      (file) => JSON.parse(readFileSync(path.join(registry, file), 'utf8')) as Record<string, any>
    );
    expect(records).toHaveLength(1);
    const starts = startTimes();
    expect(records[0]).toMatchObject({
      pid: pids.server,
      started: starts.get(pids.server),
      owner: { pid: process.pid, started: starts.get(process.pid) },
    });

    await manager.closeAll();

    expect(readdirSync(registry)).toEqual([]);
  });
});

describe.runIf(posix)('sweepOrphanMcpServers', () => {
  /** 自立进程组的进程树，模拟上一代 worker 被强杀后留下的 server：组长 + 同组子进程 */
  async function orphanTree(): Promise<{ leader: number; member: number }> {
    const dir = tempDir();
    const pidFile = path.join(dir, 'member');
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
         require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
         setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    leader.unref();
    spawned.push(leader.pid as number);
    expect(
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 3_000)
    ).toBe(true);
    const member = Number(readFileSync(pidFile, 'utf8'));
    spawned.push(member);
    return { leader: leader.pid as number, member };
  }

  const deadOwner = { pid: 999_999, started: 'Thu Jan  1 00:00:00 1970' };

  it('登记者已不在时结束登记的 server 整棵树并撤销登记', async () => {
    const registry = tempDir();
    const { leader, member } = await orphanTree();
    recordMcpServer(registry, {
      pid: leader,
      started: startTimes().get(leader) as string,
      owner: deadOwner,
      command: 'fake',
    });

    sweepOrphanMcpServers(registry);

    expect(await until(() => !alive(leader) && !alive(member), 3_000)).toBe(true);
    expect(await until(() => readdirSync(registry).length === 0, 3_000)).toBe(true);
  });

  it('pid 已被别的进程复用（启动时间对不上）时不杀，只撤销登记', async () => {
    const registry = tempDir();
    const { leader, member } = await orphanTree();
    recordMcpServer(registry, {
      pid: leader,
      started: 'Thu Jan  1 00:00:00 1970',
      owner: deadOwner,
      command: 'fake',
    });

    sweepOrphanMcpServers(registry);

    expect(readdirSync(registry)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(leader) && alive(member)).toBe(true);
  });

  it('登记者还活着（别的 worker 正在用）时不碰', async () => {
    const registry = tempDir();
    const { leader, member } = await orphanTree();
    const starts = startTimes();
    recordMcpServer(registry, {
      pid: leader,
      started: starts.get(leader) as string,
      owner: { pid: process.pid, started: starts.get(process.pid) as string },
      command: 'fake',
    });

    sweepOrphanMcpServers(registry);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(leader) && alive(member)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
  });

  it('刚报告退出的登记者即使还在进程表里也照样清扫（应用退出时 Electron 先报 exit）', async () => {
    const registry = tempDir();
    const { leader, member } = await orphanTree();
    const starts = startTimes();
    recordMcpServer(registry, {
      pid: leader,
      started: starts.get(leader) as string,
      owner: { pid: process.pid, started: starts.get(process.pid) as string },
      command: 'fake',
    });

    sweepOrphanMcpServers(registry, process.pid);

    expect(await until(() => !alive(leader) && !alive(member), 3_000)).toBe(true);
  });
});
