import type { LucideIcon } from 'lucide-react';
import {
  Braces,
  Code,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Settings,
  Terminal,
} from 'lucide-react';

const byExt: Record<string, LucideIcon> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  json: FileJson,
  html: Code,
  css: Braces,
  scss: Braces,
  md: FileText,
  sh: Terminal,
  bash: Terminal,
  yml: Settings,
  yaml: Settings,
  toml: Settings,
};

const byExtColor: Record<string, string> = {
  ts: 'text-blue-500',
  tsx: 'text-blue-500',
  js: 'text-yellow-500',
  jsx: 'text-yellow-500',
  mjs: 'text-yellow-500',
  json: 'text-yellow-600',
  html: 'text-orange-500',
  css: 'text-pink-500',
  scss: 'text-pink-500',
  md: 'text-sky-500',
  sh: 'text-muted-foreground',
};

export function fileTypeIcon(name: string, isDir: boolean, expanded = false): LucideIcon {
  if (isDir) return expanded ? FolderOpen : Folder;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return byExt[ext] ?? File;
}

export function fileTypeIconClass(name: string, isDir: boolean): string {
  if (isDir) return 'text-amber-500';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return byExtColor[ext] ?? 'text-muted-foreground';
}
