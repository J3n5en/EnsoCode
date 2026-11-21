import { describe, expect, it } from 'vitest';
import {
  chromiumRole,
  classifyStoragePath,
  commandLabel,
  cpuPercent,
  descendantPids,
  isCleanableStorageCategory,
  parseCpuTime,
  parsePs,
  parsePsArgs,
  parseSessionCleanRequest,
  parseWinProcesses,
  pickCleanTargets,
  sessionCleanIds,
  sessionStorageOwner,
  storageEntryKey,
} from './resources';

describe('parseCpuTime', () => {
  it('parses mac and linux formats', () => {
    expect(parseCpuTime('0:01.25')).toBeCloseTo(1.25);
    expect(parseCpuTime('12:03.50')).toBeCloseTo(723.5);
    expect(parseCpuTime('01:02:03')).toBe(3723);
    expect(parseCpuTime('2-00:00:01')).toBe(172801);
  });
  it('rejects garbage', () => {
    expect(parseCpuTime('abc')).toBeNull();
    expect(parseCpuTime('')).toBeNull();
  });
});

describe('parsePs', () => {
  it('parses rows, converts rss KB to bytes, keeps command basename with spaces', () => {
    const rows = parsePs(
      [
        '  100     1  2048   0:01.00 /Applications/Enso Code.app/Contents/MacOS/Enso Code',
        '  200   100   512   0:00.50 /bin/zsh',
        'garbage line',
        '',
      ].join('\n')
    );
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rss: 2048 * 1024, cpuSeconds: 1, name: 'Enso Code' },
      { pid: 200, ppid: 100, rss: 512 * 1024, cpuSeconds: 0.5, name: 'zsh' },
    ]);
  });
});

describe('descendantPids', () => {
  it('collects the whole subtree without roots and survives cycles', () => {
    const rows = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
      { pid: 5, ppid: 99 },
      { pid: 6, ppid: 7 },
      { pid: 7, ppid: 6 },
    ];
    expect([...descendantPids(rows, [1])].sort()).toEqual([2, 3, 4]);
    expect([...descendantPids(rows, [1, 2])].sort()).toEqual([3, 4]);
    expect([...descendantPids(rows, [6])]).toEqual([7]);
  });
});

describe('cpuPercent', () => {
  it('normalizes by core count and clamps', () => {
    expect(cpuPercent(1, 2, 1000, 4)).toBe(25);
    expect(cpuPercent(2, 1, 1000, 4)).toBe(0);
    expect(cpuPercent(0, 100, 1000, 4)).toBe(100);
    expect(cpuPercent(0, 1, 0, 4)).toBe(0);
  });
});

describe('isCleanableStorageCategory', () => {
  it('秘书图片可清理，会话与 other 不可', () => {
    expect(isCleanableStorageCategory('secretaryImages')).toBe(true);
    expect(isCleanableStorageCategory('sessions')).toBe(false);
    expect(isCleanableStorageCategory('other')).toBe(false);
    expect(isCleanableStorageCategory('bot-chats')).toBe(false);
  });
});

describe('classifyStoragePath', () => {
  const browser = 'Partitions/enso-dev-browser';
  it.each([
    ['Cache/Cache_Data/f_1', 'cache'],
    ['Code Cache/js/index', 'cache'],
    ['GPUCache/data_0', 'cache'],
    ['agent/usage-cache/a.jsonl.json', 'cache'],
    ['agent/pi-agent/task-logs/x.log', 'logs'],
    ['agent/continuous-memory.log', 'logs'],
    ['agent/foo/bar.log', 'logs'],
    ['main.log', 'logs'],
    ['Local Storage/leveldb/000003.log', 'other'],
    ['Session Storage/000003.log', 'other'],
    ['Partitions/other/IndexedDB/x.log', 'other'],
    ['Partitions/enso-dev-browser/Cookies', 'browser'],
    ['settings.json.bak', 'backups'],
    ['oauth-accounts.json.bak-codex-20260910', 'backups'],
    ['agent/pi-agent/auth.json.bak-codex-20260910', 'backups'],
    ['memory/chat-models/q.gguf', 'models'],
    ['memory/models/e.gguf', 'models'],
    ['llama-gpu-backends/libggml.so', 'runtimes'],
    ['agent/pi-agent/bin/rg', 'runtimes'],
    ['agent/pi-agent/rtk/rtk', 'runtimes'],
    ['agent/sessions/a/b.jsonl', 'sessions'],
    ['agent/sessions/2026-x.jsonl', 'sessions'],
    ['agent/usage-ledger/2026-09.jsonl', 'sessions'],
    ['agent/source-registry.json', 'sessions'],
    ['agent/sessions/tool-output/abc/t.txt', 'toolOutputs'],
    ['agent/sessions/enso-abc__cw-def.jsonl', 'coworkers'],
    ['bot-chats/secretary-images/0b3f6c1e-7a52-4c3e-9d1a-2f6e8b4c5d7a/ab.png', 'secretaryImages'],
    ['bot-chats/secretary-images/x/a.log', 'secretaryImages'],
    ['bot-chats/11111111-1111-4111-8111-111111111111/media/ab.png', 'other'],
    ['bot-chats/a.log', 'other'],
    ['bot-chats/settings.json.bak', 'other'],
    ['memory/memory.db', 'memory'],
    ['agent/pi-agent/memories/a.md', 'memory'],
    ['worktrees/repo/file', 'worktrees'],
    ['changes-snapshots/abc.json', 'snapshots'],
    ['settings.json', 'config'],
    ['worktrees.json', 'config'],
    ['instructions/a.md', 'config'],
    ['system-prompts/a.md', 'config'],
    ['agent/pi-agent/auth.json', 'config'],
    ['agent/workflows/x.js', 'config'],
    ['Partitions/other/Cookies', 'other'],
    ['DIPS', 'other'],
  ])('%s -> %s', (rel, id) => {
    expect(classifyStoragePath(rel, browser)).toBe(id);
  });
});

describe('parsePsArgs', () => {
  it('maps pid to full argument string', () => {
    const args = parsePsArgs('  10 /usr/bin/node /x/server.js --port 3\n  11 zsh\nbad\n');
    expect(args.get(10)).toBe('/usr/bin/node /x/server.js --port 3');
    expect(args.get(11)).toBe('zsh');
    expect(args.size).toBe(2);
  });
});

describe('commandLabel', () => {
  it.each([
    ['/usr/local/bin/node', '/usr/local/bin/node /a/b/mcp-server.js --stdio', 'node mcp-server.js'],
    ['python3', 'python3 -m http.server 5190', 'python3 http.server'],
    ['python3.12', 'python3.12 -u /x/run.py', 'python3.12 run.py'],
    ['npx', 'npx -y @scope/pkg@1 --flag', 'npx @scope/pkg@1'],
    ['pnpm', 'pnpm dlx create-x', 'pnpm create-x'],
    ['uvx', 'uvx mcp-server-fetch', 'uvx mcp-server-fetch'],
    ['/bin/zsh', '/bin/zsh -c git status && echo done', 'zsh: git status && echo done'],
    ['bash', 'bash -lc pnpm test', 'bash: pnpm test'],
    ['/bin/zsh', '/bin/zsh', 'zsh'],
    [
      '/Applications/Enso Code.app/Contents/MacOS/Enso Code',
      '/Applications/Enso Code.app/Contents/MacOS/Enso Code --x',
      'Enso Code',
    ],
    ['rg.exe', '"C:\\bin\\rg.exe" foo', 'rg'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\a\\srv.js', 'node srv.js'],
    ['cmd.exe', 'cmd.exe /c dir /s', 'cmd: dir /s'],
  ])('%s | %s -> %s', (exe, args, label) => {
    expect(commandLabel(exe, args)).toBe(label);
  });

  it('truncates long shell commands', () => {
    const label = commandLabel('sh', `sh -c ${'x'.repeat(200)}`);
    expect(label.length).toBeLessThanOrEqual(84);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('parseWinProcesses', () => {
  it('parses Win32_Process JSON (array or single object)', () => {
    const json = JSON.stringify([
      {
        ProcessId: 5,
        ParentProcessId: 1,
        WorkingSetSize: 4096,
        UserModeTime: 10_000_000,
        KernelModeTime: 5_000_000,
        Name: 'node.exe',
        CommandLine: 'node.exe a.js',
      },
      { ProcessId: 'bad' },
    ]);
    expect(parseWinProcesses(json)).toEqual([
      { pid: 5, ppid: 1, rss: 4096, cpuSeconds: 1.5, name: 'node.exe', args: 'node.exe a.js' },
    ]);
    expect(
      parseWinProcesses(
        JSON.stringify({ ProcessId: 7, ParentProcessId: 5, WorkingSetSize: 1, Name: 'x.exe' })
      )
    ).toEqual([{ pid: 7, ppid: 5, rss: 1, cpuSeconds: 0, name: 'x.exe', args: 'x.exe' }]);
    expect(parseWinProcesses('not json')).toEqual([]);
  });
});

describe('chromiumRole', () => {
  const kinds = { main: new Set([2]), settings: new Set([3]), browser: new Set([4]) };
  it.each([
    [{ pid: 1, type: 'Browser' }, 'main'],
    [{ pid: 9, type: 'GPU' }, 'gpu'],
    [{ pid: 2, type: 'Tab' }, 'window'],
    [{ pid: 3, type: 'Tab' }, 'window'],
    [{ pid: 4, type: 'Tab' }, 'browser'],
    [{ pid: 8, type: 'Tab' }, 'window'],
    [{ pid: 5, type: 'Utility', serviceName: 'enso-agent-worker' }, 'agent'],
    [{ pid: 6, type: 'Utility', serviceName: 'network.mojom.NetworkService' }, 'service'],
    [{ pid: 7, type: 'Zygote' }, 'service'],
  ] as const)('%j -> %s', (metric, role) => {
    expect(chromiumRole(metric, kinds)).toBe(role);
  });
});

describe('pickCleanTargets', () => {
  const now = 100 * 86_400_000;
  const old = now - 2 * 86_400_000;
  const fresh = now - 1000;
  const owner = (rel: string) => (rel.includes('live') ? 'live' : undefined);
  const files = [
    { rel: 'agent/sessions/tool-output/live/a', abs: '/u/1', bytes: 1, mtimeMs: old },
    { rel: 'agent/sessions/tool-output/gone/a', abs: '/u/2', bytes: 2, mtimeMs: old },
    { rel: 'agent/sessions/tool-output/gone/b', abs: '/u/3', bytes: 4, mtimeMs: fresh },
    { rel: 'agent/sessions/enso-gone__cw-x.jsonl', abs: '/u/4', bytes: 8, mtimeMs: old },
    { rel: 'main.log', abs: '/u/5', bytes: 16, mtimeMs: old },
    { rel: 'other.log', abs: '/u/6', bytes: 32, mtimeMs: fresh },
  ];
  const classify = (rel: string) => classifyStoragePath(rel, 'Partitions/b');

  it('tool outputs: only orphaned and not recent', () => {
    expect(
      pickCleanTargets(files, { category: 'toolOutputs', now, owner, classify, indexReady: true })
    ).toEqual({ targets: [{ abs: '/u/2', bytes: 2 }], skipped: 2 });
  });

  it('coworker journals: orphaned only', () => {
    expect(
      pickCleanTargets(files, { category: 'coworkers', now, owner, classify, indexReady: true })
    ).toEqual({ targets: [{ abs: '/u/4', bytes: 8 }], skipped: 0 });
  });

  it('logs: keep files from the last 24h', () => {
    expect(
      pickCleanTargets(files, { category: 'logs', now, owner, classify, indexReady: true })
    ).toEqual({ targets: [{ abs: '/u/5', bytes: 16 }], skipped: 1 });
  });

  it('orphan cleanup is skipped entirely when the session index is unavailable', () => {
    expect(
      pickCleanTargets(files, { category: 'toolOutputs', now, owner, classify, indexReady: false })
    ).toEqual({ targets: [], skipped: 3 });
  });
});

describe('storageEntryKey', () => {
  it('keeps the first two segments of nested paths', () => {
    expect(storageEntryKey('agent/sessions/a/b.jsonl')).toBe('agent/sessions');
    expect(storageEntryKey('settings.json')).toBe('settings.json');
    expect(storageEntryKey('Cache/x')).toBe('Cache/x');
  });
});

describe('parseSessionCleanRequest', () => {
  it('accepts valid stale and single requests', () => {
    expect(parseSessionCleanRequest({ kind: 'stale', days: 7, includeUnarchived: true })).toEqual({
      kind: 'stale',
      days: 7,
      includeUnarchived: true,
    });
    expect(parseSessionCleanRequest({ kind: 'stale', days: 0, includeUnarchived: false })).toEqual({
      kind: 'stale',
      days: 0,
      includeUnarchived: false,
    });
    expect(parseSessionCleanRequest({ kind: 'one', id: 'abc' })).toEqual({
      kind: 'one',
      id: 'abc',
    });
    expect(
      parseSessionCleanRequest({ kind: 'stale', days: 0, includeUnarchived: true, projectId: 'p1' })
    ).toEqual({ kind: 'stale', days: 0, includeUnarchived: true, projectId: 'p1' });
  });

  it('rejects dirty input', () => {
    for (const input of [
      null,
      'x',
      { kind: 'stale', days: -1, includeUnarchived: false },
      { kind: 'stale', days: 1.5, includeUnarchived: false },
      { kind: 'stale', days: 7 },
      { kind: 'stale', days: '7', includeUnarchived: false },
      { kind: 'one', id: '' },
      { kind: 'one', id: 3 },
      { kind: 'stale', days: 7, includeUnarchived: false, projectId: '' },
      { kind: 'stale', days: 7, includeUnarchived: false, projectId: 1 },
      { kind: 'nuke' },
    ]) {
      expect(parseSessionCleanRequest(input)).toBeNull();
    }
  });
});

describe('sessionCleanIds', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const items = [
    { id: 'arch-old', archived: true, archivedAt: now - 40 * day, lastActiveAt: now },
    { id: 'arch-new', archived: true, archivedAt: now - 2 * day, lastActiveAt: now - 50 * day },
    { id: 'arch-legacy', archived: true, lastActiveAt: now - 20 * day },
    { id: 'live-old', lastActiveAt: now - 40 * day },
    { id: 'live-new', lastActiveAt: now - day },
    { id: 'pinned-old', pinned: true, lastActiveAt: now - 40 * day },
  ];

  it('archived only: by archivedAt, falling back to lastActiveAt', () => {
    expect(
      sessionCleanIds(items, { kind: 'stale', days: 15, includeUnarchived: false }, now)
    ).toEqual(['arch-old', 'arch-legacy']);
  });

  it('days 0 means all archived', () => {
    expect(
      sessionCleanIds(items, { kind: 'stale', days: 0, includeUnarchived: false }, now)
    ).toEqual(['arch-old', 'arch-new', 'arch-legacy']);
  });

  it('includeUnarchived adds inactive unpinned sessions', () => {
    expect(
      sessionCleanIds(items, { kind: 'stale', days: 30, includeUnarchived: true }, now)
    ).toEqual(['arch-old', 'live-old']);
    expect(
      sessionCleanIds(items, { kind: 'stale', days: 0, includeUnarchived: true }, now)
    ).toEqual(['arch-old', 'arch-new', 'arch-legacy', 'live-old', 'live-new']);
  });

  it('single id only when it exists', () => {
    expect(sessionCleanIds(items, { kind: 'one', id: 'pinned-old' }, now)).toEqual(['pinned-old']);
    expect(sessionCleanIds(items, { kind: 'one', id: 'ghost' }, now)).toEqual([]);
  });

  it('projectId scopes stale cleanup to one project', () => {
    const scoped = [
      { id: 'a', projectId: 'p1', archived: true, lastActiveAt: now - 40 * day },
      { id: 'b', projectId: 'p2', archived: true, lastActiveAt: now - 40 * day },
      { id: 'c', projectId: 'p1', lastActiveAt: now - day },
    ];
    expect(
      sessionCleanIds(
        scoped,
        { kind: 'stale', days: 0, includeUnarchived: true, projectId: 'p1' },
        now
      )
    ).toEqual(['a', 'c']);
    expect(
      sessionCleanIds(scoped, { kind: 'stale', days: 0, includeUnarchived: false }, now)
    ).toEqual(['a', 'b']);
  });
});

describe('sessionStorageOwner', () => {
  const owner = sessionStorageOwner([
    {
      id: 'p1',
      sessionRel: 'agent/sessions/2026_p1.jsonl',
      worktreeRel: 'worktrees/proj/abcd1234',
    },
    { id: 'c1', parentId: 'p1', sessionRel: 'agent/sessions/2026_c1.jsonl' },
    { id: 'p2' },
  ]);

  it('maps session, coworker, tool-output, snapshot and worktree files to the root session', () => {
    expect(owner('agent/sessions/2026_p1.jsonl')).toBe('p1');
    expect(owner('agent/sessions/2026_c1.jsonl')).toBe('p1');
    expect(owner('agent/sessions/enso-p1__cw-x-gen.jsonl')).toBe('p1');
    expect(owner('agent/sessions/tool-output/p1/toolu_1.txt')).toBe('p1');
    expect(owner('agent/sessions/tool-output/p1-child/toolu_1.txt')).toBe('p1');
    expect(owner('changes-snapshots/p2.json')).toBe('p2');
    expect(owner('worktrees/proj/abcd1234/src/a.ts')).toBe('p1');
  });

  it('ignores unrelated files and prefix lookalikes', () => {
    expect(owner('agent/sessions/2026_other.jsonl')).toBeUndefined();
    expect(owner('worktrees/proj/abcd12345/a.ts')).toBeUndefined();
    expect(owner('changes-snapshots/p3.json')).toBeUndefined();
    expect(owner('agent/sessions/tool-output/zz/a.txt')).toBeUndefined();
  });
});
