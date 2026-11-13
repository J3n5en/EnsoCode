#!/usr/bin/env node
// EnsoCode 本机配置 CLI：经 userData 下的 socket（Windows 命名管道）+ cli-token 改运行中应用的设置
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const USAGE = `用法:
  enso config get <key>
  enso config set <key> <value>     value 按 JSON 解析，失败则当字符串
  enso config list [prefix]
  enso config reload
选项:
  --data-dir <dir>   指定 userData（默认读 ENSO_USER_DATA_DIR，否则系统默认位置）
  --dev              使用开发版数据目录 enso-code-dev`;

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
  const [group, action, ...params] = rest;
  if (group !== 'config') return null;
  const userData = dataDir ? path.resolve(dataDir) : defaultUserData(dev);
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  let token;
  try {
    token = readFileSync(path.join(parsed.userData, 'cli-token'), 'utf8').trim();
  } catch {
    console.error(`EnsoCode 未运行（找不到 ${path.join(parsed.userData, 'cli-token')}）`);
    return 1;
  }
  try {
    const reply = await send(endpointOf(parsed.userData), {
      token,
      cmd: 'config',
      ...parsed.request,
    });
    console.log(JSON.stringify(reply, null, 2));
    return reply?.ok ? 0 : 1;
  } catch (error) {
    console.error(`无法连接 EnsoCode：${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
