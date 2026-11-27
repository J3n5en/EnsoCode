#!/usr/bin/env node
// EnsoCode 本机配置与触发器 CLI：经 userData 下的 socket（Windows 命名管道）+ cli-token 操控运行中的应用
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const COMMANDS = [
  {
    name: 'get',
    usage: 'enso config get <key>',
    args: ['key'],
    description: 'Print the JSON value of a key; secret keys are hidden',
    examples: ['enso config get terminalFontSize', 'enso config get providers.<id>'],
  },
  {
    name: 'set',
    usage: 'enso config set <key> <value>',
    args: ['key', 'value'],
    description: 'Write a key and apply it live; value is parsed as JSON, else taken as a string',
    examples: [
      'enso config set theme dark',
      'enso config set terminalFontSize 15',
      'enso config set chatTypography.body.size 15',
      'enso config set mcpServers.<id>.callTimeoutSec 120',
      `enso config set defaultModel '{"providerId":"<id>","modelId":"gpt-5"}'`,
    ],
  },
  {
    name: 'list',
    usage: 'enso config list [prefix]',
    args: ['prefix?'],
    description: 'List keys and values; a dotted prefix shows only that subtree',
    examples: ['enso config list', 'enso config list terminal'],
  },
  {
    name: 'reload',
    usage: 'enso config reload',
    args: [],
    description: 'Make the running app re-read settings.json and broadcast',
    examples: ['enso config reload'],
  },
  {
    name: 'help',
    usage: 'enso config help [--json]',
    args: ['--json?'],
    description: 'Help text; --json (alias: schema) prints the schema of live settings',
    examples: ['enso config help', 'enso config help --json', 'enso config schema'],
  },
];

const TRIGGER_COMMANDS = [
  {
    name: 'list',
    usage: 'enso trigger list [--secretary <id|name>]',
    description: '列出秘书本机触发器（含 HTTP/WS 地址与服务状态，不含 token 明文）',
  },
  {
    name: 'create',
    usage:
      'enso trigger create --name <name> [--secretary <id|name>] [--instruction <text>] [--coalesce-ms <ms>] [--disabled]',
    description: '创建触发器并自动启动 127.0.0.1 监听，返回一次性 Bearer token 与 URL',
  },
  {
    name: 'update',
    usage:
      'enso trigger update <triggerId> [--secretary <id|name>] [--name <name>] [--enabled true|false] [--instruction <text>] [--coalesce-ms <ms>]',
    description: '更新触发器名称、开关、处理说明或合并窗口（--instruction "" 可清空）',
  },
  {
    name: 'remove',
    usage: 'enso trigger remove <triggerId> [--secretary <id|name>]',
    description: '删除触发器及其加密 token',
  },
  {
    name: 'rotate-token',
    usage: 'enso trigger rotate-token <triggerId> [--secretary <id|name>]',
    description: '重置并返回新的 Bearer token，旧 token 立即失效',
  },
  {
    name: 'port',
    usage: 'enso trigger port <port>',
    description: '设置本机触发监听端口（1024-65535，或 0 表示随机端口）',
  },
  {
    name: 'test',
    usage: 'enso trigger test <triggerId> [--secretary <id|name>] [--text <text>]',
    description: '立即入队一条测试触发事件以验证唤醒链路',
  },
  {
    name: 'help',
    usage: 'enso trigger help',
    description: '打印触发器 CLI 用法与 HTTP POST / WebSocket 接入协议',
  },
];

const OPTIONS = [
  {
    name: '--data-dir <dir>',
    description: 'userData dir (default: ENSO_USER_DATA_DIR or OS default)',
  },
  { name: '--dev', description: 'use the dev data dir enso-code-dev' },
];

const USAGE = `用法:
${COMMANDS.map((c) => `  ${c.usage.padEnd(32)}${c.description}`).join('\n')}
  ${'enso trigger <action> [args]'.padEnd(32)}管理秘书本机 HTTP/WS 触发器（见 enso trigger help）
选项:
${OPTIONS.map((o) => `  ${o.name.padEnd(32)}${o.description}`).join('\n')}`;

const HELP = `${USAGE}

键规则:
  键 = <设置字段>[.<子键>...]；数组段按元素 id 定位，找不到再按下标。
  已有值时新值 JSON 类型必须一致；proxyMode / customProxyUrl / language 另有取值校验。
黑名单:
  密钥（apiKey/secret/password/credential/authorization/cookie/*token/env）：不可读（显示 ***），不可写。
  路径/命令（path/dir/root/cwd/command/args、*Path/*Dir/*Root、worktreeRoot、terminalShell 等）：可读，不可写。
  plugins/skills/instructions 增删条目（装卸）被拒，条目内字段可写；projects/projectGroups 不可读写。
热生效:
  set 与设置页走同一写入路径，立即广播到窗口与 agent worker；部分键只对新会话生效。
  autoUpdate、autoRestartForUpdate、updateChannel 启动时读取：set 返回 requiresRestart 且不写入。
连接:
  仅本机 socket <userData>/cli/cli.sock（Windows 命名管道）+ 每次启动生成的 <userData>/cli-token。
完整键清单（含类型、是否可写/需重启/密钥）：enso config help --json（需应用在运行）
秘书触发器帮助：enso trigger help
示例:
${COMMANDS.filter((c) => c.name !== 'help')
  .flatMap((c) => c.examples)
  .map((e) => `  ${e}`)
  .join('\n')}`;

const TRIGGER_HELP = `秘书本机触发器（仅监听 127.0.0.1，同端口支持 HTTP POST 与 WebSocket）

命令:
${TRIGGER_COMMANDS.map((c) => `  ${c.usage}\n    ${c.description}`).join('\n')}

选项:
${OPTIONS.map((o) => `  ${o.name.padEnd(24)}${o.description}`).join('\n')}
  --secretary <id|name>   按秘书 id 或名字指定目标秘书（只有一个秘书时可省略）

接入协议:
  1) HTTP POST（适合脚本 / 旧 webhook 迁移）:
     POST http://127.0.0.1:<port>/v1/triggers/<triggerId>
     Headers: Authorization: Bearer <token>  （或 X-Enso-Token: <token>）
              Content-Type: application/json （也支持 text/plain）
     Body:    {"eventId":"唯一去重ID","source":"来源标签","text":"事件正文","data":{}}
     返回:    202 {"ok":true,"deliveryKey":"...","deduplicated":false}
     探活:    GET http://127.0.0.1:<port>/healthz  → 200 {"ok":true}

  2) WebSocket（适合常驻监听程序：实时断线感知 + ACK 确认 + 断线重推去重）:
     URL:     ws://127.0.0.1:<port>/v1/triggers/<triggerId>/ws
     鉴权:    握手 Header 带 Authorization: Bearer <token>，或连上后 5 秒内首帧发
              {"type":"auth","token":"<token>"}
     就绪:    服务端返回 {"type":"ready","triggerId":"..."}
     发事件:  {"type":"event","id":"req-1","eventId":"唯一去重ID","source":"来源","text":"正文"}
     回执:    {"type":"ack","id":"req-1","ok":true,"deliveryKey":"...","deduplicated":false}
     心跳:    {"type":"ping"} → {"type":"pong"}

安全与去重:
  - 仅监听 127.0.0.1，且拒绝任何带 Origin 头的浏览器跨站请求。
  - 提供稳定 eventId 可保证断线重推幂等去重；短时间连续消息按 coalesceMs（默认 3000ms）合并唤醒。
  - 仅当至少有 1 条启用中的触发器时启动监听；运行时端口写入 <userData>/secretary/trigger-server.runtime.json。`;

function defaultUserData(dev) {
  const name = dev ? 'enso-code-dev' : 'enso-code';
  if (process.platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), name);
}

// 与 src/main/services/configCli/server.ts 的 cliEndpoint 保持一致
function endpointOf(userData) {
  if (process.platform === 'win32') {
    const id = createHash('sha256').update(userData).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\enso-code-cli-${id}`;
  }
  return path.join(userData, 'cli', 'cli.sock');
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseFlagArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--disabled') {
      flags.disabled = true;
    } else if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = args[++i];
      if (next === undefined) return null;
      flags[key] = next;
    } else {
      positionals.push(item);
    }
  }
  return { flags, positionals };
}

function parseTriggerArgs(action, params, userData) {
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    return { userData, help: 'trigger' };
  }
  const parsed = parseFlagArgs(params);
  if (!parsed) return null;
  const { flags, positionals } = parsed;
  const secretary = flags.secretary;

  if (action === 'list' && positionals.length === 0) {
    return {
      userData,
      cmd: 'trigger',
      request: { action: 'list', ...(secretary ? { secretary } : {}) },
    };
  }
  if (action === 'port' && positionals.length === 1) {
    const port = Number(positionals[0]);
    if (!Number.isInteger(port)) return null;
    return { userData, cmd: 'trigger', request: { action: 'port', port } };
  }
  if (action === 'create' && positionals.length === 0) {
    if (!flags.name) return null;
    const draft = {
      name: flags.name,
      enabled: flags.disabled
        ? false
        : flags.enabled !== undefined
          ? flags.enabled !== 'false'
          : true,
    };
    if (flags.instruction !== undefined) draft.instruction = flags.instruction;
    if (flags['coalesce-ms'] !== undefined) {
      const ms = Number(flags['coalesce-ms']);
      if (!Number.isInteger(ms)) return null;
      draft.coalesceMs = ms;
    }
    return {
      userData,
      cmd: 'trigger',
      request: { action: 'create', draft, ...(secretary ? { secretary } : {}) },
    };
  }
  if (action === 'update' && positionals.length === 1) {
    const patch = {};
    if (flags.name !== undefined) patch.name = flags.name;
    if (flags.enabled !== undefined) {
      if (flags.enabled !== 'true' && flags.enabled !== 'false') return null;
      patch.enabled = flags.enabled === 'true';
    }
    if (flags.instruction !== undefined) {
      patch.instruction = flags.instruction.trim() === '' ? null : flags.instruction;
    }
    if (flags['coalesce-ms'] !== undefined) {
      const ms = Number(flags['coalesce-ms']);
      if (!Number.isInteger(ms)) return null;
      patch.coalesceMs = ms;
    }
    return {
      userData,
      cmd: 'trigger',
      request: {
        action: 'update',
        triggerId: positionals[0],
        patch,
        ...(secretary ? { secretary } : {}),
      },
    };
  }
  if ((action === 'remove' || action === 'rotate-token') && positionals.length === 1) {
    return {
      userData,
      cmd: 'trigger',
      request: { action, triggerId: positionals[0], ...(secretary ? { secretary } : {}) },
    };
  }
  if (action === 'test' && positionals.length === 1) {
    return {
      userData,
      cmd: 'trigger',
      request: {
        action: 'test',
        triggerId: positionals[0],
        ...(flags.text !== undefined ? { text: flags.text } : {}),
        ...(secretary ? { secretary } : {}),
      },
    };
  }
  return null;
}

function parseArgs(argv) {
  const rest = [];
  let dataDir = process.env.ENSO_USER_DATA_DIR?.trim() || '';
  let dev = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') dataDir = argv[++i] ?? '';
    else if (argv[i] === '--dev') dev = true;
    else rest.push(argv[i]);
  }
  const userData = dataDir ? path.resolve(dataDir) : defaultUserData(dev);
  const json = rest.includes('--json');
  const words = rest.filter((arg) => arg !== '--json');
  const [group, action, ...params] = words;

  if (group === 'trigger') {
    if (json) return null;
    return parseTriggerArgs(action, params, userData);
  }

  if (words.some((arg) => arg === '--help' || arg === '-h') || words[0] === 'help')
    return { userData, help: json ? 'json' : 'text' };
  if (group !== 'config') return null;
  if ((action === 'help' && params.length === 0) || (action === 'schema' && params.length === 0))
    return { userData, help: json || action === 'schema' ? 'json' : 'text' };
  if (json) return null;
  if (action === 'get' && params.length === 1)
    return { userData, cmd: 'config', request: { action, key: params[0] } };
  if (action === 'set' && params.length === 2)
    return {
      userData,
      cmd: 'config',
      request: { action, key: params[0], value: parseValue(params[1]) },
    };
  if (action === 'list' && params.length <= 1)
    return { userData, cmd: 'config', request: { action, prefix: params[0] } };
  if (action === 'reload' && params.length === 0)
    return { userData, cmd: 'config', request: { action } };
  return null;
}

function send(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer));
      } catch {
        reject(new Error('invalid reply'));
      }
    });
    socket.on('error', reject);
  });
}

async function request(userData, cmd, body) {
  const tokenPath = path.join(userData, 'cli-token');
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    throw new Error(`EnsoCode 未运行（找不到 ${tokenPath}）`);
  }
  try {
    return await send(endpointOf(userData), { token, cmd, ...body });
  } catch (error) {
    throw new Error(`无法连接 EnsoCode：${error.message}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  if (parsed.help === 'text') {
    console.log(HELP);
    return 0;
  }
  if (parsed.help === 'trigger') {
    console.log(TRIGGER_HELP);
    return 0;
  }
  try {
    if (parsed.help === 'json') {
      const schema = await request(parsed.userData, 'config', { action: 'schema' });
      if (!schema?.ok) throw new Error(schema?.error ?? 'schema request failed');
      delete schema.ok;
      console.log(JSON.stringify({ commands: COMMANDS, options: OPTIONS, ...schema }, null, 2));
      return 0;
    }
    const reply = await request(parsed.userData, parsed.cmd, parsed.request);
    console.log(JSON.stringify(reply, null, 2));
    return reply?.ok ? 0 : 1;
  } catch (error) {
    const hint =
      parsed.help === 'json' ? '；help --json 的键清单由运行中的应用生成，请先启动 EnsoCode' : '';
    console.error(`${error.message}${hint}`);
    return 1;
  }
}

process.exitCode = await main();
