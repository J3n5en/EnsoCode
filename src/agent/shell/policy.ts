import { SHELL_LIMITS, type ShellLimits } from '@shared/shellLimits';

/**
 * 命令分类：决定前台让位时长。只用于「等多久」，不决定杀不杀（杀只看模型显式 timeout）。
 * 判定顺序 server > build > default；输入是模型给的原命令（rtk 改写之前）。
 */
export type CommandClass = 'server' | 'build' | 'default';

export interface ShellPolicy {
  class: CommandClass;
  /** 前台到点让位：转后台继续跑，工具立即回执 */
  yieldMs: number;
  /** 连续无输出多久算静默 */
  quietMs: number;
}

/** 引号内的文本不参与 shell 语法判断（避免误伤 echo "a & b"） */
const QUOTED_SEGMENT = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
/** heredoc 正文同样不参与（写脚本时正文里常有 & 或命令名） */
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

const PKG = '(?:npm|pnpm|yarn|bun)';
/** 包管理器全局选项：--filter x / -C dir / -r 等夹在脚本名前面 */
const PKG_OPTS = String.raw`(?:\s+(?:--filter\s+\S+|-F\s+\S+|-C\s+\S+|--dir\s+\S+|--prefix\s+\S+|--workspace\s+\S+|-w\s+\S+|-\S+))*`;
const SCRIPT_END = String.raw`(?:[:\-]\S*)?(?=\s|$)`;

const SERVER_PATTERNS: RegExp[] = [
  new RegExp(`^${PKG}${PKG_OPTS}\\s+(?:run\\s+)?(?:dev|start|serve|watch|preview)${SCRIPT_END}`),
  /^vite(?!\s+(?:build|optimize)\b)(?:\s|$)/,
  /^(?:next|nuxt|nuxi|astro|remix|ng|gatsby|hugo|jekyll|eleventy|expo)\s+(?:dev|start|serve|server|develop)\b/,
  /(?:^|\s)--watch(?:All)?(?:[\s=]|$)/,
  /^tsc\b.*\s-w(?:\s|$)/,
  /^(?:nodemon|webpack-dev-server|http-server|live-server|serve|browser-sync|watchexec|entr|gunicorn|uvicorn|hypercorn|daphne|air|reflex)\b/,
  /^webpack\s+serve\b/,
  /^tail\b(?:.*\s)?(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow\S*)(?:\s|$)/,
  /^(?:journalctl|kubectl\s+logs|docker\s+logs|docker\s+compose\s+logs|docker-compose\s+logs)\b.*\s(?:-f|--follow)(?:\s|$)/,
  /^python[\d.]*\s+(?:-m\s+(?:http\.server|flask\s+run|uvicorn|django\s+runserver)\b|\S*manage\.py\s+runserver\b)/,
  /^flask\s+run\b/,
  /^(?:rails|bin\/rails)\s+(?:s|server)\b/,
  /^php\s+(?:artisan\s+serve\b|-S\b)/,
  /^(?:docker\s+compose|docker-compose)\s+up\b(?!.*\s(?:-d|--detach)(?:\s|$))/,
  /^(?:cargo\s+watch|dotnet\s+watch)\b/,
];

const BUILD_PATTERNS: RegExp[] = [
  new RegExp(
    `^${PKG}${PKG_OPTS}\\s+(?:run\\s+)?(?:build|test|lint|typecheck|type-check|check|ci|install|i|add|e2e|coverage|tsc|compile|verify)${SCRIPT_END}`
  ),
  /^vite\s+build\b/,
  /^(?:tsc|vitest|jest|mocha|playwright|cypress|eslint|biome|webpack|rollup|esbuild|turbo|nx|lerna|electron-builder|electron-vite)\b/,
  /^cargo\s+(?:build|test|check|clippy|bench|doc|install|nextest)\b/,
  /^go\s+(?:build|test|vet|install|generate|mod\s+download)\b/,
  /^(?:make|gmake|ninja|cmake|meson|bazel|bazelisk|buck2?)\b/,
  /^(?:mvn|\.\/mvnw|mvnw|gradle|\.\/gradlew|gradlew)\b/,
  /^dotnet\s+(?:build|test|restore|publish|pack)\b/,
  /^(?:pytest|tox|nox)\b/,
  /^python[\d.]*\s+-m\s+(?:pytest|unittest|pip\s+install|build|tox)\b/,
  /^(?:pip[\d.]*|uv\s+pip)\s+install\b/,
  /^uv\s+(?:sync|lock|build)\b/,
  /^poetry\s+(?:install|build|lock)\b/,
  /^(?:bundle\s+install|rspec|rake)\b/,
  /^(?:xcodebuild|swift\s+(?:build|test)|pod\s+install)\b/,
  /^mix\s+(?:test|compile|deps\.get)\b/,
  /^docker\s+(?:build|buildx\s+build)\b/,
  /^(?:docker\s+compose|docker-compose)\s+(?:build|up|pull)\b/,
  /^(?:composer\s+install|deno\s+(?:test|compile)|flutter\s+(?:build|test))\b/,
];

/** 去掉 shell 前缀（环境变量赋值、sudo/time/env 等包装、npx 等转发器），露出真正的程序 */
function normalizeSegment(segment: string): string {
  let rest = segment.trim().replace(/^[({]\s*/, '');
  for (;;) {
    const next = rest
      .replace(/^[A-Za-z_]\w*=\S*\s+/, '')
      .replace(/^(?:sudo|time|nice|env|exec|command|stdbuf\s+\S+|timeout\s+\S+)\s+/, '')
      .replace(
        /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run)\s+(?:-\S+\s+)*/,
        ''
      );
    if (next === rest) return rest;
    rest = next;
  }
}

/** --help / --version 一秒内结束，不按 server 处理 */
const INFO_FLAG = /(?:^|\s)(?:--help|-h|--version|-V)(?:\s|$)/;

function segmentClass(segment: string): CommandClass {
  const program = normalizeSegment(segment);
  if (!program || INFO_FLAG.test(program)) return 'default';
  if (SERVER_PATTERNS.some((pattern) => pattern.test(program))) return 'server';
  if (BUILD_PATTERNS.some((pattern) => pattern.test(program))) return 'build';
  return 'default';
}

export function classifyCommand(command: string, limits: ShellLimits = SHELL_LIMITS): ShellPolicy {
  let cls: CommandClass = 'default';
  if (typeof command === 'string' && command) {
    const bare = command.replace(HEREDOC_BODY, ' ').replace(QUOTED_SEGMENT, ' ');
    for (const segment of bare.split(/&&|\|\||[;|\n]/)) {
      const next = segmentClass(segment);
      if (next === 'server') {
        cls = 'server';
        break;
      }
      if (next === 'build') cls = 'build';
    }
  }
  const yieldMs =
    cls === 'server'
      ? limits.yieldServerMs
      : cls === 'build'
        ? limits.yieldBuildMs
        : limits.yieldDefaultMs;
  return { class: cls, yieldMs, quietMs: limits.quietMs };
}
