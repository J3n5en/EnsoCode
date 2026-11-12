import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPluginId, parseExtensionPluginManifest } from '@shared/extensionPlugins/manifest';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
  RegistryNotice,
} from '@shared/extensionPlugins/types';
import { version } from '../../package.json';
import type { PluginControlCommand } from './control';
import { packPlugin } from './pluginPack';
import { PLUGIN_TESTING_SOURCE } from './pluginTesting';

export const PLUGIN_USAGE = `用法: enso-server plugin <action>

  list                         已安装插件与状态
  notice-dismiss               确认并清除登记表问题提示
  install <目录|zip|url> [--yes] 安装或更新。url 可以是 zip，或 GitHub 仓库。先展示权限，确认后落盘（新装默认停用）
  enable <id> / disable <id>   启用 / 停用
  approve <id> / reject <id>   更新扩大了授权时：同意新版本 / 保留旧版本
  reload <id> [--yes]          从上次安装的来源（目录、zip 或链接）重新安装；开发时改完代码用它更新
  dev <id> / dev-off <id>      开发模式：从目录安装的插件改动后自动重装（授权扩大时停下，需要 reload 同意）
  uninstall <id>               卸载并删除插件数据
  inject-anywhere <id>         允许插件向任意运行中的会话发消息（默认只能发到发起调用的会话）
  inject-current <id>          恢复为只能发到发起调用的会话
  check                        检查 GitHub 安装的插件有没有新版本
  logs <id>                    插件进程日志末尾（console 输出与异常）
  config <id>                  查看配置项（密钥只显示是否已设置）
  config <id> key=value ...    设置；key= 留空则在终端里输入（不进 shell 历史）
           [--unset key]       清除某项
  validate <目录>              校验 enso-plugin.json，并确认 main / renderer 入口存在
  init <目录> [--id <id>]      生成最小插件（清单、main.mjs、ui.js、类型引用）
  pack <目录> [--out <zip>]    校验后打成确定性 zip（排除隐藏文件、node_modules、test/），输出 sha256
  testing <目录>               写入 enso-testing.mjs 与 test/main.test.mjs，用 node --test 测 main.mjs`;

type Reply = Record<string, unknown> & { ok?: boolean; error?: string };

export interface PluginCliDeps {
  call(command: PluginControlCommand): Promise<Reply>;
  confirm(question: string): Promise<boolean>;
  ask(question: string): Promise<string>;
  log(line: string): void;
  cwd: string;
  interactive: boolean;
}

const list = (items: readonly string[]) => (items.length ? items.join(', ') : '无');

export function formatInstallPreview(p: ExtensionPluginInstallPreview): string {
  const lines = [
    `${p.name} ${p.version}（${p.id}）${p.existingVersion ? `，替换已安装的 ${p.existingVersion}` : ''}`,
    p.description,
    '',
    '插件代码会以本机用户身份运行，下列权限只约束它经 EnsoCode 调用的能力。',
    ...(p.permissions.length > 0 || !p.styles ? [`  权限：${list(p.permissions)}`] : []),
    `  可读：${list(p.fsRead)}`,
    `  可写：${list(p.fsWrite)}`,
    `  网络：${list(p.netDomains)}`,
    `  工具：${list(p.tools.map((t) => `${t.name}（${t.description}）`))}`,
    `  MCP：${list(p.mcpServers.map((m) => `${m.name}: ${[m.command, ...m.args].join(' ')}`))}`,
    `  可调用的宿主 MCP 工具：${list(p.mcpTools)}`,
    `  环境变量：${list(p.env)}`,
    `  可调用插件：${list(p.interop)}`,
    `  常驻：${p.resident ? '是' : '否'}`,
    `  事件：${list(p.events.map((event) => `${event.event}（${event.mode}${event.failClosed ? '，失败即拒绝' : ''}）`))}`,
    `  定时任务：${list(p.schedules.map((schedule) => `${schedule.id}（${schedule.intervalSeconds}s）`))}`,
    `  界面模块：${p.hasRenderer ? '有（运行在主界面里）' : '无'}`,
    ...(p.styles ? ['  修改界面样式：主题 CSS 可以改变应用的任意界面'] : []),
  ];
  if (p.existingVersion && !p.expands) lines.push('', '授权没有扩大，确认后直接替换。');
  if (p.existingVersion && p.expands)
    lines.push('', '授权扩大了：新版本装好后需要 `enso-server plugin approve` 才会生效。');
  for (const warning of p.warnings) lines.push(`  ⚠ ${warning}`);
  return lines.filter((line, i) => line !== '' || i > 0).join('\n');
}

export function formatPluginList(plugins: readonly ExtensionPluginSummary[]): string {
  if (plugins.length === 0) return '  （无）用 `enso-server plugin install <目录|zip|url>` 安装';
  return plugins
    .map((p) => {
      const pending = p.pendingVersion ? `  待同意更新 ${p.pendingVersion}` : '';
      const update = p.availableVersion ? `  有新版本 ${p.availableVersion}` : '';
      const error = p.lastError ? `\n      最近错误：${p.lastError.message.split('\n')[0]}` : '';
      return `  ${p.id}  ${p.name} ${p.version}  ${p.state}${pending}${update}${error}`;
    })
    .join('\n');
}

function ensureOk(reply: Reply): Reply {
  if (reply.ok === false) throw new Error(String(reply.error ?? 'failed'));
  return reply;
}

export function formatConfig(fields: readonly ExtensionPluginConfigField[]): string {
  if (fields.length === 0) return '  （这个插件没有配置项）';
  return fields
    .map((f) => {
      const value = f.secret ? (f.set ? '已设置' : '未设置') : f.set ? f.value : '未设置';
      return `  ${f.key}  ${f.title}：${value}${f.description ? `\n      ${f.description}` : ''}`;
    })
    .join('\n');
}

async function runConfig(id: string, rest: string[], deps: PluginCliDeps): Promise<void> {
  if (rest.length === 0) {
    const reply = ensureOk(await deps.call({ cmd: 'plugin', action: 'config-get', id }));
    deps.log(formatConfig((reply.fields as ExtensionPluginConfigField[]) ?? []));
    return;
  }
  const values: Record<string, string | null> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--unset') {
      const key = rest[++i];
      if (!key) throw new Error(PLUGIN_USAGE);
      values[key] = null;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq <= 0) throw new Error(PLUGIN_USAGE);
    const key = arg.slice(0, eq);
    let value = arg.slice(eq + 1);
    if (value === '') {
      if (!deps.interactive) throw new Error(`${key}= 留空需要在交互终端里输入`);
      value = await deps.ask(key);
    }
    values[key] = value;
  }
  ensureOk(await deps.call({ cmd: 'plugin', action: 'config-set', id, values }));
  deps.log('已保存，新的调用即生效');
}

export async function runPluginCommand(args: string[], deps: PluginCliDeps): Promise<void> {
  const [action, target, ...flags] = args;
  if (action === 'list') {
    const reply = ensureOk(await deps.call({ cmd: 'plugin', action: 'list' }));
    deps.log(formatPluginList((reply.plugins as ExtensionPluginSummary[]) ?? []));
    const notice = reply.notice as RegistryNotice | null | undefined;
    if (notice) {
      if (notice.unreadable)
        deps.log(
          '⚠ 插件登记表曾读取失败，列表可能不全；插件文件未删除，原文在数据目录 extension-plugins/registry.json.unreadable'
        );
      if (notice.discarded.length > 0)
        deps.log(
          `⚠ 以下插件的登记记录格式已变更，已丢弃并清理，请重新安装：${notice.discarded.join(', ')}`
        );
      deps.log('  处理完后运行 enso-server plugin notice-dismiss 不再提示');
    }
    return;
  }
  if (action === 'notice-dismiss') {
    ensureOk(await deps.call({ cmd: 'plugin', action: 'notice-dismiss' }));
    deps.log('完成');
    return;
  }
  if (action === 'check') {
    const reply = ensureOk(await deps.call({ cmd: 'plugin', action: 'check' }));
    const plugins = (reply.plugins as ExtensionPluginSummary[]) ?? [];
    deps.log(`已检查 ${Number(reply.checked ?? 0)} 个插件（只支持 GitHub 安装的）`);
    for (const p of plugins) {
      if (p.availableVersion)
        deps.log(
          `  ${p.id} ${p.version} → ${p.availableVersion}，更新：enso-server plugin reload ${p.id}`
        );
      else if (p.updateCheckError) deps.log(`  ${p.id} 检查失败：${p.updateCheckError}`);
    }
    if (!Number(reply.available ?? 0)) deps.log('没有可用更新');
    return;
  }
  if (action === 'logs' && target) {
    const reply = ensureOk(await deps.call({ cmd: 'plugin', action: 'logs', id: target }));
    deps.log(String(reply.text ?? '') || '（暂无日志）');
    return;
  }
  if (action === 'config' && target) {
    await runConfig(target, flags, deps);
    return;
  }
  if ((action === 'install' || action === 'reload') && target) {
    const stage: PluginControlCommand =
      action === 'reload'
        ? { cmd: 'plugin', action: 'restage', id: target }
        : /^https?:\/\//i.test(target)
          ? { cmd: 'plugin', action: 'stage', url: target }
          : { cmd: 'plugin', action: 'stage', path: resolve(deps.cwd, target) };
    const reply = ensureOk(await deps.call(stage));
    const preview = reply.preview as ExtensionPluginInstallPreview;
    deps.log(formatInstallPreview(preview));
    const yes = flags.includes('--yes') || flags.includes('-y');
    let accepted = yes;
    if (!yes) {
      if (!deps.interactive) {
        await deps.call({ cmd: 'plugin', action: 'discard', token: preview.token });
        throw new Error('非交互终端需要加 --yes 确认安装');
      }
      accepted = await deps.confirm('确认安装？(y/N)');
    }
    if (!accepted) {
      await deps.call({ cmd: 'plugin', action: 'discard', token: preview.token });
      deps.log('已取消');
      return;
    }
    ensureOk(await deps.call({ cmd: 'plugin', action: 'commit', token: preview.token }));
    deps.log(
      preview.existingVersion
        ? '已更新'
        : `已安装（停用中），启用：enso-server plugin enable ${preview.id}`
    );
    return;
  }
  if (
    (action === 'enable' ||
      action === 'disable' ||
      action === 'approve' ||
      action === 'reject' ||
      action === 'uninstall' ||
      action === 'inject-anywhere' ||
      action === 'inject-current') &&
    target
  ) {
    ensureOk(await deps.call({ cmd: 'plugin', action, id: target }));
    deps.log('完成');
    return;
  }
  if ((action === 'dev' || action === 'dev-off') && target) {
    ensureOk(
      await deps.call({
        cmd: 'plugin',
        action: action === 'dev' ? 'dev-on' : 'dev-off',
        id: target,
      })
    );
    deps.log(action === 'dev' ? '开发模式已开，目录改动后自动重装' : '开发模式已关');
    return;
  }
  if (action === 'validate') {
    if (!target || flags.length > 0) throw new Error(PLUGIN_USAGE);
    runValidate(target, deps);
    return;
  }
  if (action === 'init') {
    if (!target) throw new Error(PLUGIN_USAGE);
    runInit(target, flags, deps);
    return;
  }
  if (action === 'pack') {
    if (!target) throw new Error(PLUGIN_USAGE);
    const out = flags[0] === '--out' && flags[1] && flags.length === 2 ? flags[1] : undefined;
    if (flags.length > 0 && !out) throw new Error(PLUGIN_USAGE);
    const packed = packPlugin(pluginDir(target, deps.cwd), {
      hostVersion: version,
      ...(out ? { out: resolve(deps.cwd, out) } : {}),
    });
    deps.log(`${packed.id} ${packed.version} → ${packed.file}`);
    deps.log(`  大小 ${packed.size} 字节，sha256 ${packed.sha256}`);
    return;
  }
  if (action === 'testing') {
    if (!target || flags.length > 0) throw new Error(PLUGIN_USAGE);
    runTesting(target, deps);
    return;
  }
  throw new Error(PLUGIN_USAGE);
}

const TEST_SAMPLE = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountMain } from '../enso-testing.mjs';
import { activate } from '../main.mjs';

test('main.mjs 能挂载', async () => {
  const plugin = await mountMain(activate);
  assert.ok(plugin.enso);
});
`;

function runTesting(target: string, deps: PluginCliDeps): void {
  const dir = pluginDir(target, deps.cwd);
  if (!existsSync(join(dir, 'enso-plugin.json'))) throw new Error('找不到 enso-plugin.json');
  writeFileSync(join(dir, 'enso-testing.mjs'), PLUGIN_TESTING_SOURCE);
  const sample = join(dir, 'test', 'main.test.mjs');
  if (!existsSync(sample)) {
    mkdirSync(dirname(sample), { recursive: true });
    writeFileSync(sample, TEST_SAMPLE);
  }
  deps.log(`已写入 enso-testing.mjs，运行：cd ${dir} && node --test`);
}

const SCAFFOLD_FILES = ['enso-plugin.json', 'main.mjs', 'ui.js', 'jsconfig.json'] as const;

function pluginDir(target: string, cwd: string): string {
  return resolve(cwd, target);
}

function readManifestFile(dir: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(dir, 'enso-plugin.json'), 'utf8');
  } catch {
    throw new Error('找不到 enso-plugin.json');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('enso-plugin.json 不是合法 JSON');
  }
}

function entryErrors(dir: string, main?: string, renderer?: string): string[] {
  const errors: string[] = [];
  const check = (label: 'main' | 'renderer', rel: string | undefined) => {
    if (!rel) return;
    const abs = resolve(dir, rel);
    const relTo = relative(dir, abs);
    if (relTo.startsWith('..') || isAbsolute(relTo)) {
      errors.push(`${label} 路径不合法`);
      return;
    }
    try {
      if (!statSync(abs).isFile()) errors.push(`入口不是文件：${label}（${rel}）`);
    } catch {
      errors.push(`入口不存在：${label}（${rel}）`);
    }
  };
  check('main', main);
  check('renderer', renderer);
  return errors;
}

function runValidate(target: string, deps: PluginCliDeps): void {
  const dir = pluginDir(target, deps.cwd);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(dir);
  } catch {
    throw new Error('找不到插件目录');
  }
  if (!info.isDirectory()) throw new Error('找不到插件目录');
  const parsed = parseExtensionPluginManifest(readManifestFile(dir), version);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  for (const warning of parsed.warnings) deps.log(warning);
  const missing = entryErrors(dir, parsed.manifest.main, parsed.manifest.renderer);
  if (missing.length > 0) throw new Error(missing.join('\n'));
  deps.log('通过');
}

function typesDeclaration(): string | null {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'types', 'enso-plugin.d.ts');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function parseInitId(flags: string[]): string | undefined {
  let id: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    if (flag !== '--id') throw new Error(PLUGIN_USAGE);
    const value = flags[++i];
    if (!value || value.startsWith('--') || id !== undefined) throw new Error(PLUGIN_USAGE);
    id = value;
  }
  return id;
}

function defaultPluginId(dir: string): string {
  const slug = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[0-9]+/, '');
  const id = `enso.plugin.${slug || 'plugin'}`.slice(0, 40);
  if (!isPluginId(id)) throw new Error('id 不合法');
  return id;
}

function displayName(id: string): string {
  const last = id.split('.').pop() ?? 'plugin';
  return (last.charAt(0).toUpperCase() + last.slice(1)).slice(0, 60);
}

function jsconfig(typesPath: string) {
  return {
    compilerOptions: {
      checkJs: true,
      allowJs: true,
      noEmit: true,
      module: 'ESNext',
      moduleResolution: 'bundler',
      target: 'ESNext',
      strict: true,
      lib: ['ESNext', 'DOM'],
      jsx: 'react-jsx',
      skipLibCheck: true,
      types: [],
      paths: { 'enso-plugin': [typesPath] },
    },
    include: ['main.mjs', 'ui.js'],
  };
}

const MAIN_SOURCE = `/**
 * @param {import('enso-plugin').EnsoMain} enso
 */
export function activate(enso) {
  enso.tools.register('hello', async (args) => {
    const name = typeof args.name === 'string' ? args.name : 'world';
    return \`hello \${name}\`;
  });
}
`;

const UI_SOURCE = `/**
 * @param {import('enso-plugin').EnsoUi} enso
 */
export function onLoad(enso) {
  enso.slots.register({
    slot: 'composer.right',
    component: () => enso.React.createElement('span', null, 'hello'),
  });
}
`;

function runInit(target: string, flags: string[], deps: PluginCliDeps): void {
  const dir = pluginDir(target, deps.cwd);
  const id = parseInitId(flags) ?? defaultPluginId(dir);
  if (!isPluginId(id)) throw new Error('id 不合法');
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error('找不到插件目录');
    const clash = SCAFFOLD_FILES.find((name) => existsSync(join(dir, name)));
    if (clash) throw new Error(`目录里已经有 ${clash}`);
  } else mkdirSync(dir, { recursive: true });
  const types = typesDeclaration();
  const typesPath = types ? relative(dir, types).split('\\').join('/') : 'enso-plugin.d.ts';
  const manifest = {
    schemaVersion: 1,
    id,
    name: displayName(id),
    version: '0.1.0',
    description: '',
    main: 'main.mjs',
    renderer: 'ui.js',
    permissions: ['agent.tool', 'ui.slot'],
    contributes: {
      agentTools: [
        {
          name: 'hello',
          description: 'Say hello',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      ],
    },
  };
  writeFileSync(join(dir, 'enso-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'main.mjs'), MAIN_SOURCE);
  writeFileSync(join(dir, 'ui.js'), UI_SOURCE);
  writeFileSync(join(dir, 'jsconfig.json'), `${JSON.stringify(jsconfig(typesPath), null, 2)}\n`);
  deps.log(`已生成 ${dir}`);
}
