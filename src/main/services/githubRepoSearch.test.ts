import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn }));

import { resetGithubRepoSearchCacheForTest, searchGithubRepos } from './githubRepoSearch';

const TIMEOUT_MS = 15_000;
const LIST_JSON = 'name,nameWithOwner,description,isPrivate,updatedAt,url,sshUrl';
const SEARCH_JSON = 'name,fullName,description,isPrivate,updatedAt,url';

class FakeGh extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

describe('searchGithubRepos', () => {
  afterEach(() => {
    vi.useRealTimers();
    spawn.mockReset();
    resetGithubRepoSearchCacheForTest();
  });

  function arm(): FakeGh[] {
    const children: FakeGh[] = [];
    spawn.mockImplementation(() => {
      const child = new FakeGh();
      children.push(child);
      // gh api user 用来自动应答当前账号 login：搜索类用例都依赖它，逐个 emit 太啰嗦
      const args = spawn.mock.calls[children.length - 1]?.[1] as string[] | undefined;
      if (args?.[0] === 'api' && args?.[1] === 'user') {
        queueMicrotask(() => {
          child.stdout.emit('data', 'me\n');
          child.emit('close', 0);
        });
      }
      return child;
    });
    return children;
  }

  function calls(): { command: string; args: string[]; shell: unknown; windowsHide: unknown }[] {
    return spawn.mock.calls.map((call) => {
      const options = call[2] as { shell?: unknown; windowsHide?: unknown };
      return {
        command: call[0] as string,
        args: call[1] as string[],
        shell: options.shell,
        windowsHide: options.windowsHide,
      };
    });
  }

  function emitJson(child: FakeGh, value: unknown, code = 0) {
    child.stdout.emit('data', JSON.stringify(value));
    child.emit('close', code);
  }

  // 等待搜索用的两个 gh search spawn 出现（api user 先跑、resolve 后才发起搜索）。
  // 返回过滤掉 api user 后的搜索调用与对应 children（children[0] 恒为 api user）。
  async function searchCalls(children: FakeGh[]) {
    await vi.waitFor(() => {
      if (calls().length < 3) throw new Error('waiting for search spawns');
    });
    return {
      seen: calls().filter((call) => call.args[0] === 'search'),
      searchChildren: children.slice(1),
    };
  }

  it('lists the signed-in user repos when the query is empty and sorts by updatedAt', async () => {
    const children = arm();
    const pending = searchGithubRepos('  ');
    expect(calls()).toEqual([
      {
        command: 'gh',
        args: ['repo', 'list', '--json', LIST_JSON, '--limit', '20'],
        shell: undefined,
        windowsHide: true,
      },
    ]);
    emitJson(children[0], [
      {
        name: 'old',
        nameWithOwner: 'me/old',
        description: 'older',
        isPrivate: false,
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://github.com/me/old',
        sshUrl: 'git@github.com:me/old.git',
      },
      {
        name: 'new',
        nameWithOwner: 'me/new',
        description: null,
        isPrivate: true,
        updatedAt: '2024-06-01T00:00:00Z',
        url: 'https://github.com/me/new',
        sshUrl: 'git@github.com:me/new.git',
      },
    ]);
    await expect(pending).resolves.toEqual({
      ok: true,
      repos: [
        {
          name: 'new',
          nameWithOwner: 'me/new',
          description: null,
          isPrivate: true,
          url: 'https://github.com/me/new',
          sshUrl: 'git@github.com:me/new.git',
        },
        {
          name: 'old',
          nameWithOwner: 'me/old',
          description: 'older',
          isPrivate: false,
          url: 'https://github.com/me/old',
          sshUrl: 'git@github.com:me/old.git',
        },
      ],
    });
  });

  it('searches by keyword and merges a private search without duplicates', async () => {
    const children = arm();
    const pending = searchGithubRepos('enso code', 5);
    const { seen, searchChildren } = await searchCalls(children);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      command: 'gh',
      args: [
        'search',
        'repos',
        '--json',
        SEARCH_JSON,
        '--limit',
        '5',
        '--owner',
        'me',
        '--sort',
        'updated',
        '--order',
        'desc',
        '--',
        'enso code',
      ],
      shell: undefined,
      windowsHide: true,
    });
    expect(seen[1]).toEqual({
      command: 'gh',
      args: [
        'search',
        'repos',
        '--json',
        SEARCH_JSON,
        '--limit',
        '5',
        '--owner',
        'me',
        '--visibility=private',
        '--',
        'enso code',
      ],
      shell: undefined,
      windowsHide: true,
    });
    emitJson(searchChildren[0], [
      {
        name: 'enso',
        fullName: 'me/enso',
        description: 'public copy',
        isPrivate: false,
        updatedAt: '2024-03-01T00:00:00Z',
        url: 'https://github.com/me/enso',
      },
      {
        name: 'demo',
        fullName: 'me/demo',
        description: 'demo',
        isPrivate: false,
        updatedAt: '2024-05-01T00:00:00Z',
        url: 'https://github.com/me/demo',
      },
    ]);
    emitJson(searchChildren[1], [
      {
        name: 'enso',
        fullName: 'me/enso',
        description: null,
        isPrivate: true,
        updatedAt: '2024-04-01T00:00:00Z',
        url: 'https://github.com/me/enso',
      },
      {
        name: 'secret',
        fullName: 'me/secret',
        description: 'hidden',
        isPrivate: true,
        updatedAt: '2024-02-01T00:00:00Z',
        url: 'https://github.com/me/secret',
      },
    ]);
    await expect(pending).resolves.toEqual({
      ok: true,
      repos: [
        {
          name: 'demo',
          nameWithOwner: 'me/demo',
          description: 'demo',
          isPrivate: false,
          url: 'https://github.com/me/demo',
        },
        {
          name: 'enso',
          nameWithOwner: 'me/enso',
          description: 'public copy',
          isPrivate: true,
          url: 'https://github.com/me/enso',
        },
        {
          name: 'secret',
          nameWithOwner: 'me/secret',
          description: 'hidden',
          isPrivate: true,
          url: 'https://github.com/me/secret',
        },
      ],
    });
  });

  it('keeps a hyphenated query behind -- so gh does not treat it as a flag', async () => {
    const children = arm();
    const pending = searchGithubRepos('-label:bug');
    const { seen, searchChildren } = await searchCalls(children);
    expect(seen[0]?.args.slice(-2)).toEqual(['--', '-label:bug']);
    expect(seen[1]?.args.slice(-2)).toEqual(['--', '-label:bug']);
    for (const child of searchChildren) emitJson(child, []);
    await expect(pending).resolves.toEqual({ ok: true, repos: [] });
  });

  it('returns a search failure when gh JSON is not an array', async () => {
    const children = arm();
    const pending = searchGithubRepos('');
    children[0].stdout.emit('data', '{');
    children[0].emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: false, error: 'GitHub search failed.' });
  });

  it('reports a missing gh binary', async () => {
    spawn.mockImplementation(() => {
      const child = new FakeGh();
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
      );
      return child;
    });
    await expect(searchGithubRepos('enso')).resolves.toEqual({
      ok: false,
      error: 'GitHub CLI (gh) was not found.',
    });
  });

  it('reports when gh is not logged in', async () => {
    // 未登录时 gh api user 也会失败：不能用 arm 的自动 login，全部 child 都报认证错误
    const children: FakeGh[] = [];
    spawn.mockImplementation(() => {
      const child = new FakeGh();
      children.push(child);
      queueMicrotask(() => {
        child.stderr.emit('data', 'error: not logged into any GitHub hosts. authentication failed');
        child.emit('close', 4);
      });
      return child;
    });
    const pending = searchGithubRepos('enso');
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Sign in to GitHub with gh CLI.',
    });
  });

  it('kills gh when the search exceeds 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const children = arm();
    const pending = searchGithubRepos('enso');
    // children[0] 是 gh api user（queueMicrotask 应答 login），多轮 microtask 让 login resolve、搜索 spawn 出现
    for (let i = 0; i < 20 && children.length < 3; i += 1) {
      await Promise.resolve();
    }
    expect(children.length).toBeGreaterThanOrEqual(3);
    const searchChildren = children.slice(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(searchChildren[0]?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(searchChildren.map((child) => child.kill.mock.calls)).toEqual([
      [['SIGKILL']],
      [['SIGKILL']],
    ]);
    await expect(pending).resolves.toEqual({ ok: false, error: 'GitHub search timed out.' });
  });

  it('rejects a malformed request without spawning gh', async () => {
    arm();
    await expect(searchGithubRepos(1)).resolves.toEqual({ ok: false, error: 'Invalid request.' });
    await expect(searchGithubRepos('enso', 0)).resolves.toEqual({
      ok: false,
      error: 'Invalid request.',
    });
    await expect(searchGithubRepos('enso', 1.5)).resolves.toEqual({
      ok: false,
      error: 'Invalid request.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
