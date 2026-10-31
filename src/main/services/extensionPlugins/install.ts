import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parsePluginInstallUrl, resolvePluginArchive } from '@shared/extensionPlugins/installUrl';
import {
  type ExtensionPluginManifest,
  parseExtensionPluginManifest,
} from '@shared/extensionPlugins/manifest';
import { type ArchiveFetch, downloadPluginArchive } from './download';
import { extractZip } from './zip';

export const MANIFEST_FILE = 'enso-plugin.json';
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SKIPPED = new Set(['.git', '.DS_Store']);

export interface StagedPlugin {
  token: string;
  /** 暂存区内的插件根目录（含清单） */
  pluginRoot: string;
  manifest: ExtensionPluginManifest;
  warnings: string[];
}

export type StageResult = { ok: true; staged: StagedPlugin } | { ok: false; error: string };

export type PluginInstallSource =
  | { kind: 'dir'; path: string }
  | { kind: 'zip'; path: string }
  | { kind: 'url'; url: string };

export interface StageDeps {
  fetch?: ArchiveFetch;
  timeoutMs?: number;
}

export const pluginPackagePath = (root: string, id: string, dir: string) =>
  join(root, 'packages', id, dir);
export const pluginDataPath = (root: string, id: string) => join(root, 'data', id);
const stagingPath = (root: string, token: string) => join(root, 'staging', token);
const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** 逐个复制普通文件；任何符号链接都拒绝，避免安装后经链接读到插件目录外 */
async function copyTree(
  src: string,
  dest: string,
  budget: { files: number; bytes: number }
): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(src)) {
    if (SKIPPED.has(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`插件目录不能包含符号链接：${name}`);
    if (info.isDirectory()) {
      await copyTree(from, to, budget);
      continue;
    }
    if (!info.isFile()) throw new Error(`插件目录包含不支持的文件类型：${name}`);
    budget.files += 1;
    budget.bytes += info.size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) throw new Error('插件过大');
    await copyFile(from, to);
  }
}

async function assertNoSymlinks(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`插件包不能包含符号链接：${name}`);
    if (info.isDirectory()) await assertNoSymlinks(path);
  }
}

async function exists(path: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const info = await stat(path);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

/** zip 若只有一个顶层目录且清单在其中，以该目录为插件根 */
async function locatePluginRoot(dir: string): Promise<string> {
  if (await exists(join(dir, MANIFEST_FILE), 'file')) return dir;
  const entries = (await readdir(dir)).filter((n) => !SKIPPED.has(n) && n !== '__MACOSX');
  if (
    entries.length === 1 &&
    entries[0] &&
    (await exists(join(dir, entries[0], MANIFEST_FILE), 'file'))
  )
    return join(dir, entries[0]);
  throw new Error(`找不到 ${MANIFEST_FILE}`);
}

/** GitHub zipball 外面还有一层仓库目录；subdir 相对这一层 */
async function pluginTreeRoot(tree: string, subdir: string | null): Promise<string> {
  if (!subdir) return tree;
  const entries = (await readdir(tree)).filter((name) => !SKIPPED.has(name) && name !== '__MACOSX');
  let base = tree;
  if (entries.length === 1 && entries[0] && (await exists(join(tree, entries[0]), 'dir'))) {
    base = join(tree, entries[0]);
  }
  const target = resolve(base, ...subdir.split('/'));
  if (!within(base, target)) throw new Error('仓库子目录不合法');
  if (!(await exists(target, 'dir'))) throw new Error('仓库里没有这个子目录');
  return target;
}

async function verifyReferences(
  pluginRoot: string,
  manifest: ExtensionPluginManifest
): Promise<void> {
  const files = [
    manifest.main,
    manifest.renderer,
    ...manifest.contributes.views.map((v) => v.entry),
  ].filter((p): p is string => typeof p === 'string');
  for (const rel of files) {
    if (!(await exists(resolve(pluginRoot, rel), 'file')))
      throw new Error(`清单引用的文件不存在：${rel}`);
  }
  for (const rel of manifest.contributes.skills) {
    if (!(await exists(resolve(pluginRoot, rel), 'dir')))
      throw new Error(`清单引用的 skill 目录不存在：${rel}`);
  }
  for (const preset of manifest.contributes.presets) {
    for (const rel of [
      preset.instruction,
      preset.systemPrompt,
      preset.systemPromptTail,
      preset.boostPrompt,
      preset.refusalRetryPrompt,
    ]) {
      if (rel && !(await exists(resolve(pluginRoot, rel), 'file')))
        throw new Error(`清单引用的文件不存在：${rel}`);
    }
  }
}

export async function stagePlugin(
  root: string,
  source: PluginInstallSource,
  hostVersion: string,
  deps: StageDeps = {}
): Promise<StageResult> {
  const token = randomUUID();
  const staging = stagingPath(root, token);
  try {
    let scanRoot = staging;
    if (source.kind === 'dir') {
      const real = resolve(source.path);
      if (within(root, real) || within(real, root))
        throw new Error('不能从插件数据目录或其上级目录安装');
      await copyTree(real, staging, { files: 0, bytes: 0 });
    } else if (source.kind === 'zip') {
      await mkdir(staging, { recursive: true });
      await extractZip(source.path, staging, { maxEntries: MAX_FILES, maxTotalBytes: MAX_BYTES });
      await assertNoSymlinks(staging);
    } else {
      const parsed = parsePluginInstallUrl(source.url);
      if (!parsed.ok) throw new Error(parsed.error);
      const resolved = resolvePluginArchive(parsed.url);
      if (!resolved.ok) throw new Error(resolved.error);
      await mkdir(staging, { recursive: true });
      const zipPath = join(staging, '.plugin.zip');
      const tree = join(staging, 'tree');
      await downloadPluginArchive(resolved.archive, zipPath, {
        fetch: deps.fetch ?? fetch,
        maxBytes: MAX_BYTES,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
      await extractZip(zipPath, tree, { maxEntries: MAX_FILES, maxTotalBytes: MAX_BYTES });
      await rm(zipPath, { force: true });
      await assertNoSymlinks(tree);
      scanRoot = await pluginTreeRoot(tree, resolved.subdir);
    }
    const pluginRoot = await locatePluginRoot(scanRoot);
    const manifestPath = join(pluginRoot, MANIFEST_FILE);
    if ((await stat(manifestPath)).size > MAX_MANIFEST_BYTES) throw new Error('清单过大');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error('清单不是合法 JSON');
    }
    const parsed = parseExtensionPluginManifest(raw, hostVersion);
    if (!parsed.ok) throw new Error(parsed.errors.join('；'));
    await verifyReferences(pluginRoot, parsed.manifest);
    return {
      ok: true,
      staged: { token, pluginRoot, manifest: parsed.manifest, warnings: parsed.warnings },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function discardStaged(root: string, staged: Pick<StagedPlugin, 'token'>): void {
  rmSync(stagingPath(root, staged.token), { recursive: true, force: true });
}

/** 移到 packages/<id>/<随机目录>，返回目录名；暂存区随之清空 */
export function commitStaged(root: string, staged: StagedPlugin): string {
  const dir = randomUUID();
  const target = pluginPackagePath(root, staged.manifest.id, dir);
  mkdirSync(join(root, 'packages', staged.manifest.id), { recursive: true });
  renameSync(staged.pluginRoot, target);
  discardStaged(root, staged);
  return dir;
}

export function removePackage(root: string, id: string, dir: string): void {
  rmSync(pluginPackagePath(root, id, dir), { recursive: true, force: true });
}
