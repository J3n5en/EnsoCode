import { spawn, spawnSync } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import type { PairStatus } from '@shared/types/pair';
import type { UpdaterState } from '@shared/types/updater';
import QRCode from 'qrcode';
import {
  CONFIG_ENV_KEYS,
  CONFIG_FILE,
  readServerConfig,
  type ServerConfig,
  writeServerConfig,
} from './config';
import type { ControlCommand } from './control';
import { runPluginCommand } from './pluginCli';
import { serviceUnit } from './service';
import { type Prompt, runConfigWizard, type SetupSystem } from './setup/wizard';
import { DEFAULT_WEB_PORT, parseWebConfig } from './web/config';

export const USAGE = `EnsoCode Server — 无界面宿主，手机 / 浏览器配对后远程使用

用法: enso-server <command>

  config                     问答式配置连接方式（公共中继 / 内置 web + 反代 / Caddy 自动 https）
  start [web 参数]            前台运行（Ctrl+C 退出）
  pair                       生成配对二维码与链接，等待设备配对
  devices                    列出已配对设备
  revoke <pairId>            撤销设备
  plugin <action>            管理 Enso 插件（list / install / enable / disable / approve / reject / uninstall / config）
  status                     运行状态、版本与更新
  update                     检查并安装新版本后重启（npm 全局安装时）
  service install [web 参数]  注册 systemd 服务（开机自启、崩溃拉起）；web 参数写入配置文件
  service uninstall          移除 systemd 服务
  logs                       跟随 systemd 服务日志
  run [选项]                 无界面跑一轮真实会话（enso-server run --help）

内置 web（默认关闭；开启后手机直接访问本机，不经公共中继）:
  --web                      开启
  --web-host <addr>          监听地址，默认 127.0.0.1（由反向代理对外提供 https）
  --web-port <port>          监听端口，默认 ${DEFAULT_WEB_PORT}
  --public-url <url>         手机访问的地址（反代后的 https 根地址）
  给出任一 web 参数即视为开启

配置文件: $ENSO_DATA_DIR/${CONFIG_FILE}（\`enso-server config\` 生成，可手改）
环境变量: ENSO_DATA_DIR（默认 ~/.enso-server）  ENSO_RELAY_URL（自建中继）
          ENSO_WEB=1  ENSO_WEB_HOST  ENSO_WEB_PORT  ENSO_PUBLIC_URL（同上）
优先级: 命令行参数 > 环境变量 > 配置文件`;

type Reply = Record<string, unknown> & { ok?: boolean; error?: string };

/** 经控制 socket 发一条命令；宿主未运行时 reject */
export function request(socketPath: string, command: ControlCommand): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    // readline 会转发 socket 的 error，两处都要接住
    lines.once('error', reject);
    socket.once('error', reject);
    socket.end(`${JSON.stringify(command)}\n`);
    lines.once('line', (line) => resolve(JSON.parse(line) as Reply));
  });
}

export const isRunning = (socketPath: string): Promise<boolean> =>
  request(socketPath, { cmd: 'status' }).then(
    () => true,
    () => false
  );

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function call(socketPath: string, command: ControlCommand): Promise<Reply> {
  const reply = await request(socketPath, command).catch(() =>
    fail('enso-server 没在运行：先 `enso-server start`，或 `enso-server service install` 后台常驻')
  );
  if (reply.ok === false) fail(String(reply.error ?? 'failed'));
  return reply;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function printDevices(status: PairStatus): void {
  if (!status.devices.length) {
    console.log('  （无）运行 `enso-server pair` 配对');
    return;
  }
  for (const d of status.devices) {
    const online = d.phoneOnline
      ? `在线·${d.transport === 'direct' ? '直连' : '中继'}${d.rttMs != null ? ` ${d.rttMs}ms` : ''}`
      : '离线';
    const at = new Date(d.pairedAt).toLocaleString();
    console.log(`  ${d.pairId}  ${d.deviceName}  ${online}  配对于 ${at}`);
  }
}

const devicesOf = async (socketPath: string) =>
  (await call(socketPath, { cmd: 'devices' })).status as PairStatus;

async function pair(socketPath: string): Promise<void> {
  const known = new Set((await devicesOf(socketPath)).devices.map((d) => d.pairId));
  const uri = String((await call(socketPath, { cmd: 'pair' })).inviteUri ?? '');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`用手机扫码，或在浏览器打开:\n${uri}\n\n等待配对…（Ctrl+C 退出）`);
  for (;;) {
    await sleep(2_000);
    const status = await devicesOf(socketPath);
    const added = status.devices.find((d) => !known.has(d.pairId));
    if (added) {
      console.log(`已配对: ${added.deviceName} (${added.pairId})`);
      return;
    }
    if (!status.pairing) fail('配对码已过期，重新运行 `enso-server pair`');
  }
}

async function status(socketPath: string): Promise<void> {
  const reply = await request(socketPath, { cmd: 'status' }).catch(() => null);
  if (!reply) {
    console.log('状态: 未运行');
    process.exitCode = 3;
    return;
  }
  const pairStatus = reply.pair as PairStatus;
  const updater = reply.update as UpdaterState;
  const s = updater.status;
  const updateText =
    updater.mode !== 'npm'
      ? '手动（npm i -g @ensocode/server@latest）'
      : s?.status === 'available' || s?.status === 'downloaded'
        ? `有新版本 ${s.info?.version}，运行 \`enso-server update\``
        : s?.status === 'error'
          ? `检查失败: ${s.error}`
          : '自动';
  console.log(`状态: 运行中 (pid ${reply.pid})`);
  console.log(`版本: ${reply.version}`);
  console.log(`数据: ${reply.dataDir}`);
  const configFile = path.join(String(reply.dataDir), CONFIG_FILE);
  if (existsSync(configFile)) console.log(`配置: ${configFile}`);
  const web = reply.web as { listen: string; publicUrl: string } | null | undefined;
  console.log(`中继: ${pairStatus.relayUrl}${web ? '（内置）' : ''}`);
  if (web) console.log(`Web: 监听 ${web.listen} → ${web.publicUrl}`);
  console.log(`更新: ${updateText}`);
  console.log('设备:');
  printDevices(pairStatus);
}

async function update(socketPath: string): Promise<void> {
  console.log('检查更新…');
  const reply = await call(socketPath, { cmd: 'update' });
  const s = reply.status as UpdaterState['status'];
  if (reply.applying) console.log(`正在安装 ${s?.info?.version}，完成后服务自动重启`);
  else if (s?.status === 'not-available') console.log(`已是最新 (${s.info?.version})`);
  else if (s?.status === 'available')
    console.log(`有新版本 ${s.info?.version}：执行 npm i -g @ensocode/server@latest 后重启`);
  else console.log(JSON.stringify(s));
}

function unitLocation() {
  const root = process.getuid?.() === 0;
  const unitDir = root ? '/etc/systemd/system' : path.join(homedir(), '.config/systemd/user');
  return { root, unitDir, unitFile: path.join(unitDir, 'enso-server.service') };
}

function systemctl(user: boolean, ...args: string[]): void {
  const result = spawnSync('systemctl', user ? ['--user', ...args] : args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`systemctl ${args.join(' ')} 失败`);
}

async function service(
  action: string | undefined,
  flags: string[],
  dataDir: string,
  socketPath: string
): Promise<void> {
  if (action !== 'install' && action !== 'uninstall') fail(USAGE);
  const parsed = parseWebConfig(flags, process.env);
  if (!parsed.ok) fail(`${parsed.error}\n\n${USAGE}`);
  if (spawnSync('systemctl', ['--version']).status !== 0) fail('需要 systemd');
  const { root, unitDir, unitFile } = unitLocation();
  if (action === 'uninstall') {
    if (existsSync(unitFile)) systemctl(!root, 'disable', '--now', 'enso-server');
    rmSync(unitFile, { force: true });
    systemctl(!root, 'daemon-reload');
    console.log(`已移除 enso-server 服务（数据保留在 ${dataDir}）`);
    return;
  }
  if (!existsSync(unitFile) && (await isRunning(socketPath)))
    fail('enso-server 正在前台运行，先停掉它（Ctrl+C）再注册服务');
  const env: Record<string, string> = { ENSO_DATA_DIR: dataDir, PATH: process.env.PATH ?? '' };
  // 设置写进配置文件而不写死在单元里，之后改配置或重跑 config 才能生效
  const patch: ServerConfig = {};
  const relayUrl = process.env.ENSO_RELAY_URL?.trim();
  const npmRegistry = process.env.ENSO_NPM_REGISTRY?.trim();
  if (relayUrl) patch.relayUrl = relayUrl;
  if (npmRegistry) patch.npmRegistry = npmRegistry;
  if (parsed.web) {
    const { host, port, localUrl, publicUrl } = parsed.web;
    patch.web = { enabled: true, host, port, ...(publicUrl !== localUrl ? { publicUrl } : {}) };
  }
  if (Object.keys(patch).length) {
    const current = readServerConfig(dataDir);
    if (!current.ok) fail(current.error);
    console.log(`设置已写入 ${writeServerConfig(dataDir, { ...current.config, ...patch })}`);
  }
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    unitFile,
    serviceUnit({
      node: process.execPath,
      script: realpathSync(process.argv[1]),
      ...(root ? { user: userInfo().username } : {}),
      env,
    })
  );
  systemctl(!root, 'daemon-reload');
  systemctl(!root, 'enable', 'enso-server');
  // 已在运行时 enable --now 不会重启，新的单元 / 配置不生效
  systemctl(!root, 'restart', 'enso-server');
  console.log(`已注册并启动 enso-server 服务（${unitFile}）`);
  if (!root) console.log('用户级服务：退出登录后仍要运行，执行 `loginctl enable-linger`');
  console.log('下一步: enso-server pair');
}

function terminalPrompt(): Prompt {
  return {
    async ask(question, fallback) {
      const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => {
        process.stdout.write('\n');
        process.exit(130);
      });
      try {
        const answer = await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `);
        return answer.trim() || fallback || '';
      } catch {
        // stdin 关闭（Ctrl+D）
        process.stdout.write('\n');
        process.exit(130);
      } finally {
        rl.close();
      }
    },
    say: (text) => console.log(text),
  };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostSystem(dataDir: string, socketPath: string): SetupSystem {
  const { root, unitFile } = unitLocation();
  const timeout = () => AbortSignal.timeout(5_000);
  return {
    linux: process.platform === 'linux',
    root,
    has: (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0,
    exec: (cmd, args) =>
      spawnSync(cmd, args, {
        stdio: 'inherit',
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      }).status === 0,
    readFile: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    async publicIp() {
      for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
        const ip = await fetch(url, { signal: timeout() })
          .then((res) => (res.ok ? res.text() : ''))
          .catch(() => '');
        if (IPV4.test(ip.trim())) return ip.trim();
      }
      return null;
    },
    resolve4: (host) => resolve4(host),
    probe: (url) =>
      fetch(url, { signal: timeout() }).then(
        (res) => res.ok,
        () => false
      ),
    sleep,
    serviceInstalled: () => existsSync(unitFile),
    serverRunning: () => isRunning(socketPath),
    currentRelayUrl: () =>
      request(socketPath, { cmd: 'status' }).then(
        (reply) => (reply.pair as PairStatus | undefined)?.relayUrl ?? null,
        () => null
      ),
    serviceOverrides: () => {
      let unit = '';
      try {
        unit = readFileSync(unitFile, 'utf8');
      } catch {
        return [];
      }
      return CONFIG_ENV_KEYS.filter((key) => unit.includes(`Environment="${key}=`));
    },
    installService: () => service('install', [], dataDir, socketPath),
    restartService: () =>
      spawnSync(
        'systemctl',
        root ? ['restart', 'enso-server'] : ['--user', 'restart', 'enso-server'],
        {
          stdio: 'inherit',
        }
      ).status === 0,
  };
}

function logs(): void {
  const root = process.getuid?.() === 0;
  const args = [root ? '-u' : '--user-unit', 'enso-server', '-f', '-n', '200'];
  spawn('journalctl', args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
}

/** start 以外的子命令；返回 false 表示不认识 */
export async function runCommand(
  argv: string[],
  ctx: { socketPath: string; dataDir: string; version: string }
): Promise<boolean> {
  const [cmd, arg, ...rest] = argv;
  switch (cmd) {
    case 'config':
      if (!process.stdin.isTTY) fail('config 需要在交互式终端里运行');
      await runConfigWizard(terminalPrompt(), hostSystem(ctx.dataDir, ctx.socketPath), ctx);
      return true;
    case 'pair':
      await pair(ctx.socketPath);
      return true;
    case 'devices':
      printDevices(await devicesOf(ctx.socketPath));
      return true;
    case 'revoke':
      if (!arg) fail('用法: enso-server revoke <pairId>');
      await call(ctx.socketPath, { cmd: 'revoke', id: arg });
      console.log(`已撤销 ${arg}`);
      return true;
    case 'plugin': {
      const prompt = process.stdin.isTTY ? terminalPrompt() : null;
      await runPluginCommand(arg ? [arg, ...rest] : [], {
        call: (command) =>
          request(ctx.socketPath, command).catch(() =>
            fail(
              'enso-server 没在运行：先 `enso-server start`，或 `enso-server service install` 后台常驻'
            )
          ),
        confirm: async (question) => /^y(es)?$/i.test(((await prompt?.ask(question)) ?? '').trim()),
        ask: async (question) => (await prompt?.ask(question)) ?? '',
        log: (line) => console.log(line),
        cwd: process.cwd(),
        interactive: prompt !== null,
      }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
      return true;
    }
    case 'status':
      await status(ctx.socketPath);
      return true;
    case 'update':
      await update(ctx.socketPath);
      return true;
    case 'service':
      await service(arg, rest, ctx.dataDir, ctx.socketPath);
      return true;
    case 'logs':
      logs();
      return true;
    case '-v':
    case '--version':
      console.log(ctx.version);
      return true;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return true;
    default:
      return false;
  }
}
