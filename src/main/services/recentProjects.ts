import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecentProject } from '@shared/types';
import Database from 'better-sqlite3';
import { encodeClaudeProjectDir } from './sessionImport/claudeCode';

const HOME = os.homedir();
const MAX_PER_SOURCE = 50;
const MAX_CODEX_ROLLOUTS = 200;
const SQLITE_TIMEOUT_MS = 3000;

interface Discovered {
  path: string;
  sourceName: string;
  lastUsed: number;
}

interface EditorConfig {
  name: string;
  configDir: string;
}

const EDITORS: EditorConfig[] = [
  { name: 'VS Code', configDir: 'Code' },
  { name: 'VS Code Insiders', configDir: 'Code - Insiders' },
  { name: 'VSCodium', configDir: 'VSCodium' },
  { name: 'Cursor', configDir: 'Cursor' },
  { name: 'Windsurf', configDir: 'Windsurf' },
];

function displayPath(target: string): string {
  const relative = path.relative(HOME, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return target;
}

function normalizeDedup(target: string): string {
  return process.platform === 'linux' ? target : target.toLowerCase();
}

function editorDbPath(configDir: string): string {
  const parts = [configDir, 'User', 'globalStorage', 'state.vscdb'];
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', ...parts);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, ...parts);
  }
  return path.join(HOME, '.config', ...parts);
}

function folderUriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.toLowerCase().startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function fileMtime(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

function newestJsonlMtime(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    newest = Math.max(newest, fileMtime(path.join(dir, name)));
  }
  return newest;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** workspaceStorage/{id}/workspace.json → 目录路径，时间取该工作区 sqlite 的真实 mtime */
function readEditorWorkspaceTimes(configDir: string): Map<string, number> {
  const times = new Map<string, number>();
  const dbPath = editorDbPath(configDir);
  const userRoot = path.dirname(path.dirname(dbPath));
  const storageRoot = path.join(userRoot, 'workspaceStorage');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(storageRoot, { withFileTypes: true });
  } catch {
    return times;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(storageRoot, entry.name);
    const meta = readJson(path.join(dir, 'workspace.json'));
    const folder = folderUriToPath(meta?.folder);
    if (!folder) continue;
    const lastUsed = Math.max(
      fileMtime(path.join(dir, 'state.vscdb')),
      fileMtime(path.join(dir, 'state.vscdb-wal'))
    );
    if (lastUsed <= 0) continue;
    const key = normalizeDedup(folder);
    const prev = times.get(key) ?? 0;
    if (lastUsed > prev) times.set(key, lastUsed);
  }
  return times;
}

function readEditorProjects(editor: EditorConfig): Discovered[] {
  const dbPath = editorDbPath(editor.configDir);
  if (!fs.existsSync(dbPath)) return [];

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: SQLITE_TIMEOUT_MS });
  } catch {
    return [];
  }

  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
      .get();
    if (!hasTable) return [];

    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('history.recentlyOpenedPathsList') as { value?: string } | undefined;
    if (!row?.value) return [];

    const data = JSON.parse(row.value) as { entries?: unknown[] };
    const entries = Array.isArray(data.entries) ? data.entries.slice(0, MAX_PER_SOURCE) : [];
    const times = readEditorWorkspaceTimes(editor.configDir);
    const found: Discovered[] = [];

    for (const entry of entries) {
      const uri =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? (entry as { folderUri?: unknown }).folderUri
            : null;
      const folder = folderUriToPath(uri);
      if (!folder) continue;
      found.push({
        path: folder,
        sourceName: editor.name,
        lastUsed: times.get(normalizeDedup(folder)) ?? 0,
      });
    }
    return found;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readClaudeProjects(): Discovered[] {
  const json = readJson(path.join(HOME, '.claude.json'));
  const projects = json?.projects;
  if (!projects || typeof projects !== 'object') return [];

  return Object.keys(projects as Record<string, unknown>).map((projectPath) => {
    const encodedDir = path.join(HOME, '.claude', 'projects', encodeClaudeProjectDir(projectPath));
    const lastUsed = newestJsonlMtime(encodedDir) || fileMtime(encodedDir);
    return { path: projectPath, sourceName: 'Claude Code', lastUsed };
  });
}

function cwdOfCodexRollout(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf-8', 0, bytes).split('\n', 1)[0];
    const entry = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    return typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function listCodexRollouts(sessionsDir: string): { path: string; mtime: number }[] {
  const results: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          results.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(sessionsDir, 0);
  return results.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CODEX_ROLLOUTS);
}

function parseIsoMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function readCodexProjects(): Discovered[] {
  const found: Discovered[] = [];
  const state = readJson(path.join(HOME, '.codex', '.codex-global-state.json'));
  const localProjects = state?.['local-projects'];
  const byId = new Map<string, string[]>();
  if (localProjects && typeof localProjects === 'object') {
    for (const [id, item] of Object.entries(localProjects as Record<string, unknown>)) {
      if (!item || typeof item !== 'object') continue;
      const roots = (item as { rootPaths?: unknown }).rootPaths;
      const paths = Array.isArray(roots)
        ? roots.filter((root): root is string => typeof root === 'string' && root.trim() !== '')
        : [];
      if (paths.length === 0) continue;
      byId.set(id, paths);
      for (const root of paths) found.push({ path: root, sourceName: 'Codex', lastUsed: 0 });
    }
  }
  const saved = state?.['electron-saved-workspace-roots'];
  if (Array.isArray(saved)) {
    for (const root of saved) {
      if (typeof root === 'string' && root.trim()) {
        found.push({ path: root, sourceName: 'Codex', lastUsed: 0 });
      }
    }
  }

  const assignments = state?.['thread-project-assignments'];
  const indexFile = path.join(HOME, '.codex', 'session_index.jsonl');
  if (assignments && typeof assignments === 'object' && fs.existsSync(indexFile)) {
    let content = '';
    try {
      content = fs.readFileSync(indexFile, 'utf8');
    } catch {
      content = '';
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id?: unknown; updated_at?: unknown };
        if (typeof row.id !== 'string') continue;
        const assignment = (assignments as Record<string, unknown>)[row.id];
        if (!assignment || typeof assignment !== 'object') continue;
        const projectId = (assignment as { projectId?: unknown }).projectId;
        if (typeof projectId !== 'string') continue;
        const lastUsed = parseIsoMs(row.updated_at);
        if (lastUsed <= 0) continue;
        for (const root of byId.get(projectId) ?? []) {
          found.push({ path: root, sourceName: 'Codex', lastUsed });
        }
      } catch {}
    }
  }

  for (const file of listCodexRollouts(path.join(HOME, '.codex', 'sessions'))) {
    const cwd = cwdOfCodexRollout(file.path);
    if (!cwd) continue;
    found.push({ path: cwd, sourceName: 'Codex', lastUsed: file.mtime });
  }
  return found;
}

function readGrokProjects(): Discovered[] {
  const dir = path.join(HOME, '.grok', 'sessions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: Discovered[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(entry.name);
    } catch {
      continue;
    }
    if (!path.isAbsolute(decoded)) continue;
    let lastUsed = 0;
    try {
      lastUsed = fs.statSync(path.join(dir, entry.name)).mtimeMs;
    } catch {}
    found.push({ path: decoded, sourceName: 'Grok Build', lastUsed });
  }
  return found;
}

function isUsableDir(target: string): boolean {
  try {
    const resolved = path.resolve(target);
    if (resolved === path.parse(resolved).root) return false;
    if (resolved.endsWith('.app')) return false;
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/** 从本机编辑器与编程应用读取最近打开过的目录 */
export function getRecentProjects(): RecentProject[] {
  const discovered = [
    ...EDITORS.flatMap(readEditorProjects),
    ...readClaudeProjects(),
    ...readCodexProjects(),
    ...readGrokProjects(),
  ];

  const best = new Map<string, Discovered>();
  for (const item of discovered) {
    const key = normalizeDedup(item.path);
    const prev = best.get(key);
    if (!prev || item.lastUsed > prev.lastUsed) best.set(key, item);
  }

  return [...best.values()]
    .filter((item) => isUsableDir(item.path))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.path.localeCompare(b.path))
    .map((item) => ({
      path: item.path,
      displayPath: displayPath(item.path),
      sourceName: item.sourceName,
    }));
}
