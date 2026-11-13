/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude plugin placeholders are literal text */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginEntry } from '../../shared/types/plugins';
import {
  expandPluginVars,
  listInstalledPluginInfo,
  listInstalledPlugins,
  readPluginComponents,
  resolvePluginsForSpawn,
  summarizeComponents,
} from './claudePlugins';

let dir: string;

function write(file: string, content: string | object): void {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
}

function installed(plugins: Record<string, Array<Record<string, unknown>>>): void {
  write('installed_plugins.json', { version: 2, plugins });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugins-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('expandPluginVars', () => {
  it('expands plugin dirs, env vars with defaults and drops user_config', () => {
    const vars = { root: '/p', data: '/d', env: { KEY: 'k' } };
    expect(expandPluginVars('${CLAUDE_PLUGIN_ROOT}/bin ${CLAUDE_PLUGIN_DATA}', vars)).toBe(
      '/p/bin /d'
    );
    expect(expandPluginVars('${KEY} ${MISSING:-fallback} ${MISSING}|', vars)).toBe('k fallback |');
    expect(expandPluginVars('${user_config.token}', vars)).toBe('');
  });
});

describe('listInstalledPlugins', () => {
  it('reads installed plugins, preferring the user-scope install that exists', () => {
    fs.mkdirSync(path.join(dir, 'cache/mkt/demo/2.0.0'), { recursive: true });
    installed({
      'demo@mkt': [
        { scope: 'project', installPath: path.join(dir, 'cache/mkt/demo/1.0.0'), version: '1.0.0' },
        { scope: 'user', installPath: path.join(dir, 'cache/mkt/demo/2.0.0'), version: '2.0.0' },
      ],
      'gone@mkt': [{ scope: 'user', installPath: path.join(dir, 'missing') }],
    });
    expect(listInstalledPlugins(dir)).toEqual([
      {
        key: 'demo@mkt',
        name: 'demo',
        marketplace: 'mkt',
        version: '2.0.0',
        root: path.join(dir, 'cache/mkt/demo/2.0.0'),
      },
    ]);
  });

  it('returns nothing for a missing or broken file', () => {
    expect(listInstalledPlugins(dir)).toEqual([]);
    write('installed_plugins.json', '{broken');
    expect(listInstalledPlugins(dir)).toEqual([]);
  });
});

describe('readPluginComponents', () => {
  const root = () => path.join(dir, 'cache/mkt/demo/1.0.0');
  const plugin = () => ({ key: 'demo@mkt', name: 'demo', marketplace: 'mkt', root: root() });
  const read = () => readPluginComponents(plugin(), { pluginsDir: dir, env: { TOKEN: 't' } });

  it('maps skills, commands, agents, MCP servers and hooks', () => {
    const base = 'cache/mkt/demo/1.0.0';
    write(`${base}/.claude-plugin/plugin.json`, { name: 'demo', description: 'Demo plugin' });
    write(`${base}/skills/tdd/SKILL.md`, '---\nname: tdd\ndescription: Test first\n---\nbody');
    write(
      `${base}/commands/review.md`,
      '---\ndescription: Review code\nargument-hint: "[focus]"\n---\nRun ${CLAUDE_PLUGIN_ROOT}/x $ARGUMENTS'
    );
    write(`${base}/commands/git/sync.md`, 'Sync the branch\n\nmore');
    write(
      `${base}/agents/scout.md`,
      '---\nname: scout\ndescription: |\n  Looks around\ntools: Read, Grep, Glob\nskills: [tdd]\n---\nYou scout.'
    );
    write(
      `${base}/agents/fixer.md`,
      '---\ndescription: Fixes\ntools: Read, Bash(git:*)\n---\nFix.'
    );
    write(`${base}/.mcp.json`, {
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: '${TOKEN}', 'X-Empty': '${NOPE:-}' },
        },
        local: {
          command: '${CLAUDE_PLUGIN_ROOT}/server',
          args: ['--data', '${CLAUDE_PLUGIN_DATA}'],
        },
      },
    });
    write(`${base}/hooks/hooks.json`, {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }],
          },
        ],
        Notification: [{ hooks: [{ type: 'command', command: 'say' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'check' }] }],
      },
    });

    const components = read();
    const dataDir = path.join(dir, 'data', 'demo-mkt');
    expect(components.skills).toEqual([{ name: 'tdd', path: path.join(root(), 'skills/tdd') }]);
    expect(components.commands).toEqual([
      {
        name: 'demo:git:sync',
        description: 'Sync the branch',
        content: 'Sync the branch\n\nmore',
        filePath: path.join(root(), 'commands/git/sync.md'),
      },
      {
        name: 'demo:review',
        description: 'Review code',
        argumentHint: '[focus]',
        content: `Run ${root()}/x $ARGUMENTS`,
        filePath: path.join(root(), 'commands/review.md'),
      },
    ]);
    expect(components.agents).toEqual([
      {
        name: 'demo:fixer',
        description: 'Fixes',
        systemPrompt: 'Fix.',
        tools: 'all',
        skillPaths: [],
      },
      {
        name: 'demo:scout',
        description: 'Looks around',
        systemPrompt: 'You scout.',
        tools: 'readonly',
        skillPaths: [path.join(root(), 'skills/tdd')],
      },
    ]);
    expect(components.mcpServers).toEqual([
      {
        id: 'plugin:demo@mkt:docs',
        name: 'docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        headers: { Authorization: 't' },
      },
      {
        id: 'plugin:demo@mkt:local',
        name: 'local',
        transport: 'stdio',
        command: path.join(root(), 'server'),
        args: ['--data', dataDir],
      },
    ]);
    expect(components.hooks).toEqual([
      {
        plugin: 'demo',
        root: root(),
        dataDir,
        event: 'SessionStart',
        matcher: 'startup|resume',
        command: 'echo hi',
        timeoutSec: 5,
      },
    ]);
    expect(components.unsupported).toEqual(['hooks:Notification', 'hooks:prompt']);
  });

  it('treats a root SKILL.md as the only skill and reads manifest paths', () => {
    const base = 'cache/mkt/demo/1.0.0';
    write(`${base}/SKILL.md`, '---\nname: creator\n---\n');
    expect(read().skills).toEqual([{ name: 'creator', path: root() }]);

    write(`${base}/.claude-plugin/plugin.json`, {
      name: 'demo',
      skills: ['./.claude/skills/pro'],
      mcpServers: { inline: { url: 'https://x.example/sse', type: 'sse' } },
      lspServers: { ts: { command: 'tsls' } },
    });
    write(`${base}/.claude/skills/pro/SKILL.md`, '---\nname: pro\n---\n');
    const components = read();
    expect(components.skills).toEqual([
      { name: 'pro', path: path.join(root(), '.claude/skills/pro') },
    ]);
    expect(components.mcpServers).toEqual([
      {
        id: 'plugin:demo@mkt:inline',
        name: 'inline',
        transport: 'sse',
        url: 'https://x.example/sse',
      },
    ]);
    expect(components.unsupported).toEqual(['lspServers']);
  });

  it('uses a non-strict marketplace entry as the manifest', () => {
    write('marketplaces/mkt/.claude-plugin/marketplace.json', {
      plugins: [
        {
          name: 'demo',
          description: 'Go LSP',
          strict: false,
          lspServers: { gopls: { command: 'gopls' } },
        },
      ],
    });
    fs.mkdirSync(root(), { recursive: true });
    const components = read();
    expect(components.description).toBe('Go LSP');
    expect(components.unsupported).toEqual(['lspServers']);
  });

  it('ignores broken files instead of failing', () => {
    const base = 'cache/mkt/demo/1.0.0';
    write(`${base}/.claude-plugin/plugin.json`, '{bad');
    write(`${base}/.mcp.json`, '{bad');
    write(`${base}/hooks/hooks.json`, '[1,2]');
    write(`${base}/agents/x.md`, '---\n: bad: yaml\n---\nbody');
    const components = read();
    expect(components.mcpServers).toEqual([]);
    expect(components.hooks).toEqual([]);
    expect(components.agents.map((agent) => agent.name)).toEqual(['demo:x']);
  });
});

describe('summarizeComponents', () => {
  it('lists names and the commands MCP servers and hooks will run', () => {
    const summary = summarizeComponents({
      description: '',
      skills: [{ name: 'tdd', path: '/p/skills/tdd' }],
      commands: [{ name: 'demo:review', description: '', content: 'x', filePath: '/p/c.md' }],
      agents: [
        { name: 'demo:scout', description: '', systemPrompt: '', tools: 'all', skillPaths: [] },
      ],
      mcpServers: [
        { id: 'a', name: 'local', transport: 'stdio', command: 'node', args: ['s.js'] },
        { id: 'b', name: 'docs', transport: 'http', url: 'https://d' },
      ],
      hooks: [{ plugin: 'demo', root: '/p', dataDir: '/d', event: 'Stop', command: 'echo done' }],
      unsupported: ['lspServers'],
    });
    expect(summary).toEqual({
      skills: ['tdd'],
      commands: ['demo:review'],
      agents: ['demo:scout'],
      mcpServers: [
        { name: 'local', target: 'node s.js' },
        { name: 'docs', target: 'https://d' },
      ],
      hooks: [{ event: 'Stop', command: 'echo done' }],
      unsupported: ['lspServers'],
    });
  });
});

describe('listInstalledPluginInfo', () => {
  const base = 'cache/mkt/demo/1.0.0';
  const root = () => path.join(dir, base);
  beforeEach(() => {
    installed({ 'demo@mkt': [{ scope: 'user', installPath: root() }] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 摘要经 PLUGINS_LIST_INSTALLED 发给界面（远端/手机也能拿到）；.mcp.json 引用的环境变量可能是密钥，值只能留在 Main
  it('设置页摘要不带 Main 环境变量的值，插件目录照常展开', () => {
    vi.stubEnv('ENSO_TEST_DB_URL', 'postgres://user:secret@db');
    vi.stubEnv('ENSO_TEST_API_KEY', 'sk-secret');
    write(`${base}/.mcp.json`, {
      mcpServers: {
        db: { command: '${CLAUDE_PLUGIN_ROOT}/bin/db', args: ['--url', '${ENSO_TEST_DB_URL}'] },
        api: { type: 'http', url: 'https://api.example/mcp?key=${ENSO_TEST_API_KEY}' },
      },
    });
    const [info] = listInstalledPluginInfo(dir);
    expect(info.components.mcpServers).toEqual([
      { name: 'db', target: `${root()}/bin/db --url \${ENSO_TEST_DB_URL}` },
      { name: 'api', target: 'https://api.example/mcp?key=${ENSO_TEST_API_KEY}' },
    ]);
  });

  // Claude Code 文档里的写法：地址整段来自带缺省值的变量。摘要不能因为不展开变量就把会启动的服务漏掉
  it('未设置的变量与真正启动时一样取缺省值，服务不会从摘要里消失', () => {
    vi.stubEnv('ENSO_TEST_BASE_URL', '');
    write(`${base}/.mcp.json`, {
      mcpServers: { api: { type: 'http', url: '${ENSO_TEST_BASE_URL:-https://api.example}/mcp' } },
    });
    const [info] = listInstalledPluginInfo(dir);
    expect(info.components.mcpServers).toEqual([
      { name: 'api', target: 'https://api.example/mcp' },
    ]);
  });
});

describe('resolvePluginsForSpawn', () => {
  it('merges only enabled entries whose plugin is still installed', () => {
    const make = (name: string) => {
      write(`cache/mkt/${name}/1/skills/${name}-skill/SKILL.md`, `---\nname: ${name}-skill\n---\n`);
      return { scope: 'user', installPath: path.join(dir, `cache/mkt/${name}/1`) };
    };
    installed({ 'a@mkt': [make('a')], 'b@mkt': [make('b')] });
    const entry = (key: string, enabled: boolean): PluginEntry => ({
      id: key,
      key,
      name: key,
      description: '',
      source: 'Claude Code',
      enabled,
    });
    const resolved = resolvePluginsForSpawn(
      [entry('a@mkt', true), entry('b@mkt', false), entry('gone@mkt', true)],
      { pluginsDir: dir, env: {} }
    );
    expect(resolved.skillPaths).toEqual([path.join(dir, 'cache/mkt/a/1/skills/a-skill')]);
    expect(resolved.commands).toEqual([]);
    expect(resolved.agents).toEqual([]);
    expect(resolved.mcpServers).toEqual([]);
    expect(resolved.hooks).toEqual([]);
  });
});
