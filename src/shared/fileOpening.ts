export interface FileOpenRule {
  extension: string;
  target: 'internal' | 'reveal' | 'system' | 'application';
  applicationPath?: string;
}

export type ContextMenuOpenTarget =
  | { target: 'reveal' }
  | { target: 'vscode' }
  | { target: 'application'; applicationPath: string };

export type ContextMenuOpenItem = ContextMenuOpenTarget & { id: string; enabled: boolean };
export type ContextMenuOpen = ContextMenuOpenItem[];

export function contextMenuApplicationIdentity(applicationPath: string): string {
  const normalized = applicationPath.replace(/\\/g, '/');
  return /^[a-z]:\/|^\/\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function parseContextMenuOpen(value: unknown): ContextMenuOpen | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const items: ContextMenuOpen = [];
  const ids = new Set<string>();
  const applications = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const config = item as Record<string, unknown>;
    if (
      Object.keys(config).some((key) => !['id', 'target', 'enabled', 'applicationPath'].includes(key))
    )
      return null;
    const { id, enabled, target } = config;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || ids.has(id)) return null;
    if (typeof enabled !== 'boolean') return null;
    if (target === 'application') {
      if (id === 'reveal' || id === 'vscode' || !isFileOpenApplicationPath(config.applicationPath))
        return null;
      const applicationPath = config.applicationPath;
      const identity = contextMenuApplicationIdentity(applicationPath);
      if (applications.has(identity)) return null;
      applications.add(identity);
      items.push({ id, enabled, target, applicationPath });
    } else {
      if ((target !== 'reveal' && target !== 'vscode') || id !== target || 'applicationPath' in config)
        return null;
      items.push({ id, enabled, target });
    }
    ids.add(id);
  }
  return items;
}

export function normalizeContextMenuOpen(value: unknown): ContextMenuOpen {
  return parseContextMenuOpen(value) ?? [];
}

const TEXT_EXTENSIONS = new Set(
  'txt text log csv tsv json jsonl yaml yml toml xml html htm ini conf config env properties ts tsx js jsx mjs cjs mts cts py pyi rb go rs java kt kts swift c h cpp hpp cc cxx cs fs fsx php sh bash zsh fish ps1 psm1 psd1 bat cmd sql css scss sass less vue svelte lua dart diff patch r pl pm ex exs erl hrl clj cljs edn scala gradle groovy tex rst adoc asm s cmake make graphql gql proto ipynb'.split(
    ' '
  )
);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const TEXT_NAMES = new Set(
  'readme license licence copying notice authors changelog dockerfile containerfile makefile gemfile rakefile procfile justfile .gitignore .gitattributes .gitmodules .editorconfig .npmrc .yarnrc .bashrc .zshrc .profile .env'.split(
    ' '
  )
);
const ALWAYS_REVEAL_EXTENSIONS = new Set(
  'exe msi msp msix appx appxbundle msixbundle msu pif com app lnk scr cpl dll sys ocx hta msc reg inf jar pkg mpkg dmg appimage desktop run application gadget workflow action terminal webloc inetloc url fileloc'.split(
    ' '
  )
);
const SCRIPT_EXTENSIONS = new Set(
  'command tool sh bash zsh csh fish bat cmd ps1 psm1 psd1 vbs vbe wsf wsh jse scpt applescript py pyw rb pl pm php js jsx mjs cjs ts tsx mts cts jxa'.split(
    ' '
  )
);

function extensionOf(rel: string): string {
  const name = (rel.split('/').at(-1) ?? '').replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * 从相对路径提取规范扩展名；与目标解析共用，避免 Main 查找应用规则时采用不同的后缀定义。
 *
 * Extract the canonical extension from a relative path, sharing target resolution's suffix definition
 * so Main does not use a different definition when looking up application rules.
 */
export function fileOpenExtension(rel: string): string {
  const extension = extensionOf(rel);
  return extension ? `.${extension}` : '';
}

/**
 * 应用路径只能是单个绝对路径，不能含命令、参数或控制字符；Main 还会检查本机存在性及文件类型。
 *
 * An application path must be one absolute path without commands, arguments, or control characters;
 * Main additionally checks its local existence and file type.
 */
export function isFileOpenApplicationPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim())
    return false;
  if (/[\p{Cc}"'`|;&<>]/u.test(value) || /\s+-/.test(value)) return false;
  const absolute =
    /^\/(?!\/)/.test(value) || /^[a-z]:[/\\]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  return absolute && !value.split(/[/\\]/).some((part) => part === '..' || part === '.');
}

/**
 * 严格校验整组规则：任一脏字段、重复扩展名或不合法应用路径都会拒绝整组，避免部分生效。
 *
 * Validate the entire rule set strictly: dirty fields, duplicate extensions, or invalid application
 * paths reject the whole set rather than applying only some rules.
 */
export function parseFileOpenRules(value: unknown): FileOpenRule[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const result: FileOpenRule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !['extension', 'target', 'applicationPath'].includes(key)))
      return null;
    if (typeof rule.extension !== 'string') return null;
    const suffix = rule.extension
      .trim()
      .toLowerCase()
      .replace(/^(?:\*\.|\.)/, '');
    if (!/^[a-z0-9][a-z0-9_+-]{0,31}$/.test(suffix)) return null;
    const extension = `.${suffix}`;
    if (seen.has(extension)) return null;
    const target = rule.target;
    if (
      target !== 'internal' &&
      target !== 'reveal' &&
      target !== 'system' &&
      target !== 'application'
    )
      return null;
    if (target === 'application') {
      if (!isFileOpenApplicationPath(rule.applicationPath)) return null;
      result.push({ extension, target, applicationPath: rule.applicationPath });
    } else {
      if ('applicationPath' in rule) return null;
      result.push({ extension, target });
    }
    seen.add(extension);
  }
  return result;
}

/**
 * 读取不可信持久化规则时规范化为安全列表；无效配置回退到默认打开行为。
 *
 * Normalize untrusted persisted rules to a safe list; invalid configuration falls back to defaults.
 */
export function normalizeFileOpenRules(value: unknown): FileOpenRule[] {
  return parseFileOpenRules(value) ?? [];
}

/**
 * 可执行文件、安装包和脚本不能外部打开；此扩展名守卫还必须由 Main 的执行位和真实路径检查补足。
 *
 * Executables, installers, and scripts cannot open externally; Main must supplement this extension
 * guard with executable-mode and real-path checks.
 */
export function isExternalFileOpenBlocked(rel: string): boolean {
  const extension = extensionOf(rel);
  return ALWAYS_REVEAL_EXTENSIONS.has(extension) || SCRIPT_EXTENSIONS.has(extension);
}

/**
 * 返回已知格式的内部查看器类型；PDF 由 Main 独立只读预览窗口处理，不支持的格式返回 null。
 *
 * Return the internal viewer type for known formats; Main handles PDFs in a separate read-only
 * preview window, and unsupported formats return null.
 */
export function fileOpenViewer(rel: string): 'text' | 'markdown' | 'image' | 'pdf' | null {
  const name = (rel.split('/').at(-1) ?? '').toLowerCase();
  if (TEXT_NAMES.has(name)) return 'text';
  const extension = extensionOf(rel);
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  return TEXT_EXTENSIONS.has(extension) ? 'text' : null;
}

/**
 * 规则可以覆盖默认查看行为，但永远不能把可执行文件改为执行，也不能把脚本交给外部应用。
 *
 * Rules may override default viewing behavior, but can never execute executable files or pass
 * scripts to external applications.
 */
export function resolveFileOpenTarget(rel: string, rules: unknown): FileOpenRule['target'] {
  const extension = extensionOf(rel);
  if (ALWAYS_REVEAL_EXTENSIONS.has(extension)) return 'reveal';
  const rule = normalizeFileOpenRules(rules).find((item) => item.extension === `.${extension}`);
  if (rule) {
    if (
      (rule.target === 'system' || rule.target === 'application') &&
      isExternalFileOpenBlocked(rel)
    )
      return 'reveal';
    return rule.target;
  }
  return fileOpenViewer(rel) ? 'internal' : 'reveal';
}
