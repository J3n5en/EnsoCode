import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScanAppId } from '@shared/types';

export interface AppLocation {
  /** 实际读取路径 */
  filePath: string;
  /** 展示用路径 */
  display: string;
}

const HOME = os.homedir();
const APP_DATA = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');

const isWin = process.platform === 'win32';

function homePath(relative: string): AppLocation {
  return { filePath: path.join(HOME, relative), display: `~/${relative}` };
}

function appDataPath(relative: string): AppLocation {
  if (isWin) {
    return {
      filePath: path.join(APP_DATA, relative),
      display: `%APPDATA%\\${relative.replaceAll('/', '\\')}`,
    };
  }
  return homePath(`Library/Application Support/${relative}`);
}

function displayFor(filePath: string): string {
  const relative = path.relative(HOME, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return filePath;
}

function expandUserPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(HOME, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(HOME, trimmed);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** CC Switch 桌面版可在 app_paths.json 中重定向配置目录 */
function ccSwitchLocation(): AppLocation {
  const configDirName = 'com.ccswitch.desktop';
  const appPathsFile = isWin
    ? path.join(APP_DATA, configDirName, 'app_paths.json')
    : process.platform === 'linux'
      ? path.join(
          process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
          configDirName,
          'app_paths.json'
        )
      : path.join(HOME, 'Library/Application Support', configDirName, 'app_paths.json');

  if (fs.existsSync(appPathsFile)) {
    const overrideDir = readJsonFile(appPathsFile)?.app_config_dir_override;
    if (typeof overrideDir === 'string' && overrideDir.trim()) {
      const dbPath = path.join(expandUserPath(overrideDir), 'cc-switch.db');
      if (fs.existsSync(dbPath)) {
        return { filePath: dbPath, display: displayFor(dbPath) };
      }
    }
  }

  return homePath('.cc-switch/cc-switch.db');
}

/** Cherry Studio 支持在 ~/.cherrystudio/config/config.json 中自定义数据目录 */
function cherryStudioLocation(): AppLocation {
  const leveldbRelative = 'Local Storage/leveldb';
  const config = readJsonFile(path.join(HOME, '.cherrystudio/config/config.json'));

  const dataDirs: string[] = [];
  const appDataPathValue = config?.appDataPath;
  if (typeof appDataPathValue === 'string') {
    dataDirs.push(appDataPathValue);
  } else if (Array.isArray(appDataPathValue)) {
    for (const entry of appDataPathValue) {
      const dataPath = (entry as Record<string, unknown>)?.dataPath;
      if (typeof dataPath === 'string' && dataPath.trim()) dataDirs.push(dataPath);
    }
  }

  for (const dir of dataDirs) {
    const dbPath = path.join(expandUserPath(dir), leveldbRelative);
    if (fs.existsSync(dbPath)) {
      return { filePath: dbPath, display: displayFor(dbPath) };
    }
  }

  return appDataPath(`CherryStudio/${leveldbRelative}`);
}

/** EnsoAI 设置文件：userData（enso-ai）与 ~/.ensoai 都可能存在，取较新的一份 */
function ensoAiLocation(): AppLocation {
  let userDataLocation: AppLocation;
  if (process.platform === 'linux') {
    const filePath = path.join(
      process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
      'enso-ai/settings.json'
    );
    userDataLocation = { filePath, display: displayFor(filePath) };
  } else {
    userDataLocation = appDataPath('enso-ai/settings.json');
  }
  const homeLocation = homePath('.ensoai/settings.json');

  const existing = [userDataLocation, homeLocation].flatMap((location) => {
    try {
      return [{ location, mtime: fs.statSync(location.filePath).mtimeMs }];
    } catch {
      return [];
    }
  });
  if (existing.length === 0) return userDataLocation;
  existing.sort((a, b) => b.mtime - a.mtime);
  return existing[0].location;
}

/** Cursor IDE 的用户级状态库（VSCode 派生的 state.vscdb） */
function cursorStateLocation(): AppLocation {
  const relative = 'Cursor/User/globalStorage/state.vscdb';
  if (isWin) {
    return appDataPath(relative);
  }
  if (process.platform === 'linux') {
    return homePath(`.config/${relative}`);
  }
  return homePath(`Library/Application Support/${relative}`);
}

export function locateApp(appId: ScanAppId): AppLocation {
  switch (appId) {
    case 'claude-code':
      return homePath('.claude/settings.json');
    case 'codex':
      return homePath('.codex/config.toml');
    case 'cc-switch':
      return ccSwitchLocation();
    case 'alma':
      return appDataPath('alma/chat_threads.db');
    case 'cherry-studio':
      return cherryStudioLocation();
    case 'hermes':
      return homePath('.hermes/config.yaml');
    case 'openclaw':
      return homePath('.openclaw/gateway.yaml');
    case 'grok':
      return homePath('.grok/auth.json');
    case 'cursor':
      return cursorStateLocation();
    case 'ensoai':
      return ensoAiLocation();
  }
}
