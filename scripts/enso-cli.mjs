#!/usr/bin/env node
// EnsoCode 本机配置 CLI：经 userData 下的 socket（Windows 命名管道）+ cli-token 改运行中应用的设置
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

const OPTIONS = [
  {
    name: '--data-dir <dir>',
    description: 'userData dir (default: ENSO_USER_DATA_DIR or OS default)',
  },
  { name: '--dev', description: 'use the dev data dir enso-code-dev' },
];

const USAGE = `用法:
${COMMANDS.map((c) => `  ${c.usage.padEnd(32)}${c.description}`).join('\n')}
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
  autoUpdate、autoRestartWhenIdle 启动时读取：set 返回 requiresRestart 且不写入。
连接:
  仅本机 socket <userData>/cli/cli.sock（Windows 命名管道）+ 每次启动生成的 <userData>/cli-token。
完整键清单（含类型、是否可写/需重启/密钥）：enso config help --json（需应用在运行）
示例:
${COMMANDS.filter((c) => c.name !== 'help')
  .flatMap((c) => c.examples)
  .map((e) => `  ${e}`)
  .join('\n')}`;

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
  if (words.some((arg) => arg === '--help' || arg === '-h') || words[0] === 'help')
    return { userData, help: json ? 'json' : 'text' };
  const [group, action, ...params] = words;
  if (group !== 'config') return null;
  if ((action === 'help' && params.length === 0) || (action === 'schema' && params.length === 0))
    return { userData, help: json || action === 'schema' ? 'json' : 'text' };
  if (json) return null;
  if (action === 'get' && params.length === 1)
    return { userData, request: { action, key: params[0] } };
  if (action === 'set' && params.length === 2)
    return { userData, request: { action, key: params[0], value: parseValue(params[1]) } };
  if (action === 'list' && params.length <= 1)
    return { userData, request: { action, prefix: params[0] } };
  if (action === 'reload' && params.length === 0) return { userData, request: { action } };
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

async function request(userData, body) {
  const tokenPath = path.join(userData, 'cli-token');
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    throw new Error(`EnsoCode 未运行（找不到 ${tokenPath}）`);
  }
  try {
    return await send(endpointOf(userData), { token, cmd: 'config', ...body });
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
  try {
    if (parsed.help === 'json') {
      const schema = await request(parsed.userData, { action: 'schema' });
      if (!schema?.ok) throw new Error(schema?.error ?? 'schema request failed');
      delete schema.ok;
      console.log(JSON.stringify({ commands: COMMANDS, options: OPTIONS, ...schema }, null, 2));
      return 0;
    }
    const reply = await request(parsed.userData, parsed.request);
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
