import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  GitCommitFilesResult,
  GitErrorCode,
  GitFile,
  GitFileDiffResult,
  GitHistoryResult,
  GitStatusResult,
} from '@shared/types/git';

const MAX_TEXT_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 8_000_000;

export class GitOperationError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string
  ) {
    super(message);
  }
}

export class GitPreviewUnavailable extends GitOperationError {
  readonly unavailable = true;
}

export function validateGitPath(value: string): void {
  if (
    !value ||
    value.startsWith('-') ||
    /[\\:\0]/.test(value) ||
    path.posix.isAbsolute(value) ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          /[. ]$/.test(part) ||
          /^\.git$/i.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  ) {
    throw new GitOperationError('invalid-path', '文件标识必须是安全的仓库相对路径。');
  }
}

function run(cwd: string, args: string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_NAMESPACE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])
    delete env[key];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--literal-pathspecs', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer,
        timeout: 120_000,
        windowsHide: true,
        env,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.toString('utf8').trim() || error.message));
        else resolve(stdout);
      }
    );
  });
}

const text = async (cwd: string, args: string[]) => (await run(cwd, args)).toString('utf8');
const withoutNewline = (value: string) => value.replace(/\r?\n$/, '');

function fileStatus(code: string): GitFile['status'] {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'U') return 'conflicted';
  return 'modified';
}

function afterFields(record: string, count: number): string {
  let offset = 0;
  for (let i = 0; i < count; i++) {
    offset = record.indexOf(' ', offset);
    if (offset === -1) throw new Error('Git 返回了无效的文件状态。');
    offset++;
  }
  return record.slice(offset);
}

export function parseGitStatus(output: string): Extract<GitStatusResult, { ok: true }> {
  const result: Extract<GitStatusResult, { ok: true }> = {
    ok: true,
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
  };
  for (const record of output.split('\0')) {
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      result.head = oid === '(initial)' ? null : oid;
    } else if (record.startsWith('# branch.head ')) {
      const branch = record.slice(14);
      result.branch = branch === '(detached)' ? null : branch;
    } else if (record.startsWith('# branch.upstream ')) {
      result.upstream = record.slice(18);
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
    } else if (record.startsWith('? ')) {
      result.unstaged.push({ path: record.slice(2), status: 'untracked' });
    } else if (record.startsWith('1 ')) {
      const xy = record.slice(2, 4);
      const file = afterFields(record, 8);
      if (xy[0] !== '.') result.staged.push({ path: file, status: fileStatus(xy[0]) });
      if (xy[1] !== '.') result.unstaged.push({ path: file, status: fileStatus(xy[1]) });
    } else if (record.startsWith('u ')) {
      const file = { path: afterFields(record, 10), status: 'conflicted' as const };
      result.staged.push(file);
      result.unstaged.push(file);
    } else if (!record.startsWith('# ')) {
      throw new Error('Git 返回了无法识别的文件状态。');
    }
  }
  return result;
}

function decode(buffer: Buffer): string {
  if (buffer.includes(0)) throw new GitPreviewUnavailable('binary', '二进制文件不支持文本预览。');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new GitPreviewUnavailable('invalid-encoding', '文件不是有效 UTF-8 文本，无法预览。');
  }
}

function validateHash(hash: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash))
    throw new GitOperationError('invalid-request', '无效的提交标识。');
}

export class GitRepository {
  private constructor(
    readonly cwd: string,
    private readonly authorize: () => void
  ) {}

  static async open(cwd: string, authorize: () => void = () => {}): Promise<GitRepository> {
    const root = withoutNewline(await text(cwd, ['rev-parse', '--show-toplevel']));
    authorize();
    return new GitRepository(realpathSync(root), authorize);
  }

  private write(args: string[]): Promise<Buffer> {
    this.authorize();
    return run(this.cwd, args);
  }

  status(): Promise<Extract<GitStatusResult, { ok: true }>> {
    return text(this.cwd, [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--ignore-submodules=none',
    ]).then(parseGitStatus);
  }

  private checkPath(file: string): string {
    validateGitPath(file);
    const segments = file.split('/');
    let current = this.cwd;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new GitOperationError('invalid-path', '不能通过符号链接访问仓库文件。');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return path.join(this.cwd, ...segments);
  }

  private async head(): Promise<string | null> {
    try {
      return (await text(this.cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      // 仅空仓库可以没有 HEAD；其他仓库错误交给 status 明确返回。
      const status = await this.status();
      if (status.head) throw new Error('无法读取当前提交。');
      return null;
    }
  }

  private async assertWritable(): Promise<void> {
    const gitDir = withoutNewline(await text(this.cwd, ['rev-parse', '--absolute-git-dir']));
    if (
      [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_LOG',
        'rebase-merge',
        'rebase-apply',
        'sequencer',
      ].some((marker) => existsSync(path.join(gitDir, marker)))
    )
      throw new GitOperationError('git-busy', '请先完成或取消正在进行的 Git 操作。');
    const status = await this.status();
    if ([...status.staged, ...status.unstaged].some((file) => file.status === 'conflicted')) {
      throw new GitOperationError('conflict', '请先解决 Git 冲突。');
    }
  }

  private rejectDirectoryTarget(file: string): void {
    try {
      if (lstatSync(this.checkPath(file)).isDirectory()) {
        throw new GitOperationError(
          'invalid-path',
          '目标是目录，不能作为单个文件操作。请先处理目录中的文件。'
        );
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  private select(files: GitFile[], paths?: string[]): GitFile[] {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const overlapping = new Set<string>();
    for (const file of files) {
      for (
        let index = file.path.indexOf('/');
        index !== -1;
        index = file.path.indexOf('/', index + 1)
      ) {
        const parent = file.path.slice(0, index);
        if (byPath.has(parent)) {
          overlapping.add(parent);
          overlapping.add(file.path);
        }
      }
    }
    const selected =
      paths === undefined
        ? files
        : [...new Set(paths)].map((file) => {
            this.checkPath(file);
            const entry = byPath.get(file);
            if (!entry)
              throw new GitOperationError('stale-file', `文件不在当前改动列表中：${file}`);
            return entry;
          });
    for (const entry of selected) {
      this.checkPath(entry.path);
      if (overlapping.has(entry.path)) {
        throw new GitOperationError(
          'invalid-path',
          '目标路径与其他改动文件存在父子关系，不能作为单个文件操作。请先处理路径替换。'
        );
      }
    }
    return selected;
  }

  async stage(paths?: string[]): Promise<void> {
    await this.assertWritable();
    const files = this.select((await this.status()).unstaged, paths);
    for (const file of files) this.rejectDirectoryTarget(file.path);
    if (files.length) await this.write(['add', '--all', '--', ...files.map((file) => file.path)]);
  }

  async unstage(paths?: string[]): Promise<void> {
    await this.assertWritable();
    const files = this.select((await this.status()).staged, paths);
    for (const file of files) this.rejectDirectoryTarget(file.path);
    if (!files.length) return;
    await this.write(
      (await this.head())
        ? ['restore', '--staged', '--source=HEAD', '--', ...files.map((file) => file.path)]
        : ['rm', '--cached', '--force', '--', ...files.map((file) => file.path)]
    );
  }

  async discard(paths: string[], confirmUntracked: boolean): Promise<void> {
    await this.assertWritable();
    const files = this.select((await this.status()).unstaged, paths);
    const tracked = files.filter((file) => file.status !== 'untracked');
    const untracked = files.filter((file) => file.status === 'untracked');
    for (const file of tracked) this.rejectDirectoryTarget(file.path);
    if (untracked.length && !confirmUntracked)
      throw new GitOperationError('confirmation-required', '删除未跟踪文件前必须明确确认。');
    for (const file of untracked) {
      const stat = lstatSync(this.checkPath(file.path));
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new GitOperationError(
          'invalid-path',
          '仅允许删除明确选中的未跟踪文件，不能删除目录。'
        );
    }
    // 未跟踪文件逐个 unlink，绝不递归删除；工作树恢复仅以索引为源。
    if (tracked.length)
      await this.write(['restore', '--worktree', '--', ...tracked.map((file) => file.path)]);
    for (const file of untracked) {
      this.authorize();
      unlinkSync(this.checkPath(file.path));
    }
  }

  async commit(message: string): Promise<void> {
    if (!message.trim() || message.includes('\0') || message.length > 100_000)
      throw new GitOperationError('invalid-message', '请输入有效的提交消息。');
    await this.assertWritable();
    if (!(await this.status()).staged.length)
      throw new GitOperationError('empty-index', '暂存区为空，无法提交。');
    await this.write(['commit', '--no-status', '--cleanup=verbatim', '--message', message]);
  }

  private async blob(revision: string, file: string): Promise<string> {
    const listing =
      revision === ':'
        ? await text(this.cwd, ['ls-files', '--stage', '-z', '--', file])
        : await text(this.cwd, ['ls-tree', '-r', '-z', revision, '--', file]);
    const records = listing.split('\0').filter(Boolean);
    const record = records.find((entry) => entry.slice(entry.indexOf('\t') + 1) === file);
    if (!record) return '';
    const metadata = record.slice(0, record.indexOf('\t')).split(' ');
    const mode = metadata[0];
    if (mode !== '100644' && mode !== '100755')
      throw new GitPreviewUnavailable('unsupported', '符号链接或子模块不支持文本预览。');
    const oid = revision === ':' ? metadata[1] : metadata[2];
    if (revision === ':' && metadata[2] !== '0')
      throw new GitPreviewUnavailable('conflict', '冲突文件不支持文本预览。');
    const size = Number((await text(this.cwd, ['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size > MAX_TEXT_BYTES)
      throw new GitPreviewUnavailable('too-large', '文件过大，无法预览（上限 2 MB）。');
    return decode(await run(this.cwd, ['cat-file', 'blob', oid], MAX_TEXT_BYTES + 1));
  }

  private workingText(file: string): string {
    const target = this.checkPath(file);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
      throw error;
    }
    if (!stat.isFile())
      throw new GitPreviewUnavailable('unsupported', '符号链接、目录或子模块不支持文本预览。');
    if (stat.size > MAX_TEXT_BYTES)
      throw new GitPreviewUnavailable('too-large', '文件过大，无法预览（上限 2 MB）。');
    return decode(readFileSync(target));
  }

  async fileDiff(file: string, staged: boolean): Promise<Extract<GitFileDiffResult, { ok: true }>> {
    this.checkPath(file);
    const status = await this.status();
    const entry = (staged ? status.staged : status.unstaged).find((entry) => entry.path === file);
    if (!entry) throw new GitOperationError('stale-file', '文件已不在当前改动列表中，请刷新。');
    if (entry.status === 'conflicted')
      throw new GitPreviewUnavailable('conflict', '冲突文件不支持文本预览。');
    const head = staged ? await this.head() : null;
    const oldText = staged ? (head ? await this.blob(head, file) : '') : await this.blob(':', file);
    const newText = staged ? await this.blob(':', file) : this.workingText(file);
    return { ok: true, path: file, oldText, newText };
  }

  async history(
    skip = 0,
    limit = 30,
    head?: string
  ): Promise<Extract<GitHistoryResult, { ok: true }>> {
    if (
      !Number.isSafeInteger(skip) ||
      skip < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new GitOperationError('invalid-request', '无效的历史分页参数。');
    }
    if (head !== undefined) validateHash(head);
    const revision = head ?? (await this.head());
    if (!revision) return { ok: true, commits: [], hasMore: false };
    const output = await text(this.cwd, [
      'log',
      '--no-show-signature',
      `--skip=${skip}`,
      `--max-count=${limit + 1}`,
      '--format=%H%x00%s%x00%an%x00%aI',
      '-z',
      revision,
      '--',
    ]);
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    const commits = [];
    for (let i = 0; i < fields.length; i += 4) {
      if (fields[i + 3] === undefined) throw new Error('Git 返回了无效的提交历史。');
      commits.push({
        hash: fields[i],
        subject: fields[i + 1],
        author: fields[i + 2],
        date: fields[i + 3],
      });
    }
    return { ok: true, commits: commits.slice(0, limit), hasMore: commits.length > limit };
  }

  private async commitBase(hash: string): Promise<string | null> {
    validateHash(hash);
    await run(this.cwd, ['cat-file', '-e', `${hash}^{commit}`]);
    const parents = (await text(this.cwd, ['rev-list', '--parents', '-n', '1', hash, '--']))
      .trim()
      .split(' ');
    return parents[1] ?? null;
  }

  async commitFiles(hash: string): Promise<Extract<GitCommitFilesResult, { ok: true }>> {
    const base = await this.commitBase(hash);
    const output = await text(
      this.cwd,
      base
        ? [
            'diff-tree',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-z',
            '--no-renames',
            base,
            hash,
            '--',
          ]
        : [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-z',
            '--no-renames',
            hash,
            '--',
          ]
    );
    const tokens = output.split('\0').filter(Boolean);
    const files: GitFile[] = [];
    for (let i = 0; i < tokens.length; i += 2) {
      if (!tokens[i + 1]) throw new Error('Git 返回了无效的历史文件列表。');
      files.push({ path: tokens[i + 1], status: fileStatus(tokens[i]) });
    }
    return { ok: true, files };
  }

  async commitDiff(hash: string, file: string): Promise<Extract<GitFileDiffResult, { ok: true }>> {
    this.checkPath(file);
    const files = await this.commitFiles(hash);
    if (!files.files.some((entry) => entry.path === file))
      throw new GitOperationError('stale-file', '文件不属于该提交。');
    const base = await this.commitBase(hash);
    const oldText = base ? await this.blob(base, file) : '';
    const newText = await this.blob(hash, file);
    return { ok: true, path: file, oldText, newText };
  }

  private async upstream(): Promise<{ remote: string; merge: string }> {
    const branch = (await this.status()).branch;
    if (!branch)
      throw new GitOperationError('no-upstream', '当前 HEAD 未绑定分支，无法使用 upstream。');
    const config = async (key: string) => {
      try {
        return withoutNewline(await text(this.cwd, ['config', '--get', key]));
      } catch {
        return '';
      }
    };
    const remote = await config(`branch.${branch}.remote`);
    const merge = await config(`branch.${branch}.merge`);
    if (!remote || !merge)
      throw new GitOperationError(
        'no-upstream',
        '当前分支未配置 upstream，请先在外部 Git 工具中设置跟踪分支。'
      );
    if (remote.startsWith('-') || !merge.startsWith('refs/heads/'))
      throw new GitOperationError('no-upstream', '当前分支的 upstream 配置无效。');
    if (remote !== '.' && !(await text(this.cwd, ['remote'])).split(/\r?\n/).includes(remote)) {
      throw new GitOperationError('no-remote', 'upstream 对应的远端不存在。');
    }
    await run(this.cwd, ['check-ref-format', merge]);
    return { remote, merge };
  }

  async fetch(): Promise<void> {
    await this.assertWritable();
    const remotes = (await text(this.cwd, ['remote'])).trim();
    if (!remotes) throw new GitOperationError('no-remote', '仓库未配置远端。');
    await this.write(['fetch', '--all', '--no-recurse-submodules']);
  }

  async pull(): Promise<void> {
    const { remote, merge } = await this.upstream();
    await this.assertWritable();
    const status = await this.status();
    if (status.staged.length || status.unstaged.length)
      throw new GitOperationError('dirty', '请先提交或处理工作区改动，再拉取远端。');
    await this.write([
      '-c',
      'rebase.autoStash=false',
      '-c',
      'merge.autoStash=false',
      'pull',
      '--ff-only',
      '--no-rebase',
      '--no-autostash',
      '--no-recurse-submodules',
      '--',
      remote,
      merge,
    ]);
  }

  async push(): Promise<void> {
    const { remote, merge } = await this.upstream();
    await this.assertWritable();
    // 显式 refspec 且禁用 mirror，避免用户配置把普通推送升级为 force/mirror。
    await this.write([
      '-c',
      `remote.${remote}.mirror=false`,
      'push',
      '--no-force',
      '--no-mirror',
      '--recurse-submodules=no',
      '--',
      remote,
      `HEAD:${merge}`,
    ]);
  }
}
