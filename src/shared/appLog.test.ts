import { describe, expect, it } from 'vitest';
import {
  classifyWorkerExitLevel,
  formatAppLogLine,
  inferLogSource,
  parseAppLogLines,
  parseLogExportHours,
  parseLogSummaryLevel,
  parsePluginLogLines,
  parseStampedLog,
  redactSecrets,
  summarizeErrors,
} from './appLog';

describe('redactSecrets', () => {
  it.each([
    ['OpenAI key', 'using key sk-proj-AbCdEf1234567890xyz now'],
    ['Anthropic key', 'key=sk-ant-api03-AbCdEf_1234567890-xyz'],
    ['Bearer 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'],
    ['Authorization JSON 字段', '{"authorization":"Basic dXNlcjpwYXNz"}'],
    ['api_key=', 'GET /v1?api_key=abcdef123456&x=1'],
    ['apiKey JSON', '{"apiKey": "my-secret-value-1"}'],
    ['token=', 'refresh token=abc.def.ghi failed'],
    ['access_token 查询串', 'https://x.com/cb?access_token=zzzzzzzz'],
    ['password=', 'login password=hunter2 rejected'],
    ['password JSON', '{"password":"hunter2"}'],
    ['x-api-key 头', 'x-api-key: AKSECRETVALUE99'],
    ['client_secret', "client_secret: 'shhh-123'"],
    ['GitHub token', 'push with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['GitHub PAT', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['Google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['Telegram bot token', 'bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe'],
    [
      'JWT',
      'id eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpM',
    ],
    ['URL 内嵌凭据', 'clone https://user:p4ssw0rd@github.com/a/b.git'],
    ['URL 单段 token 凭据', 'clone https://mysecretpat999@github.com/a/b.git'],
    ['cookie 头', 'Cookie: session=abc123def456'],
    ['多项 Cookie 头', 'Cookie: session=abc123def456; sid=SECRET_SID_999; csrftoken=CSRF_888'],
    ['Set-Cookie 头', 'Set-Cookie: sid=SET_COOKIE_SECRET; HttpOnly; Path=/'],
    ['小写 bearer', 'auth: bearer lowercase_bearer_token_12345'],
    ['Stripe key', 'stripe sk_live_51HqABCDEFGHIJKLMNOP and rk_test_99ZzABCDEFGHIJKLMNOP'],
    ['HuggingFace token', 'hf hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ12'],
    ['xAI key', 'xai xai-AbCdEf1234567890GhIjKlMn'],
    ['Groq key', 'groq gsk_AbCdEf1234567890GhIjKlMnOp'],
    ['Perplexity key', 'pplx pplx-AbCdEf1234567890GhIjKlMnOp'],
    ['Google OAuth', 'oauth ya29.a0AfB_byC1234567890abcdef'],
    ['npm token', 'npm npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['PyPI token', 'pypi pypi-AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTA'],
    [
      'SendGrid key',
      `sg ${['SG', 'AbCdEf1234567890GhIjKl', 'MnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrS'].join('.')}`,
    ],
    [
      '转义 JSON 里的密钥',
      '{"m":"failed: {\\"api_key\\":\\"ESCAPED_SECRET_1\\",\\"password\\":\\"ESCAPED_PASS_2\\"}"}',
    ],
  ])('%s 被脱敏', (_name, input) => {
    const out = redactSecrets(input);
    expect(out).toContain('***');
    for (const secret of [
      'AbCdEf1234567890xyz',
      'AbCdEf_1234567890',
      'payload.sig',
      'dXNlcjpwYXNz',
      'abcdef123456',
      'my-secret-value-1',
      'abc.def.ghi',
      'zzzzzzzz',
      'hunter2',
      'AKSECRETVALUE99',
      'shhh-123',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'abcdefghijklmnop',
      'abcdefghijkl',
      '1234567890abcdefghijklmnopqrstuv',
      'IOSFODNN7EXAMPLE',
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      'SflKxwRJSMeKKF2QT4fwpM',
      'p4ssw0rd',
      'mysecretpat999',
      'abc123def456',
      'SECRET_SID_999',
      'CSRF_888',
      'SET_COOKIE_SECRET',
      'lowercase_bearer_token_12345',
      '51HqABCDEFGHIJKLMNOP',
      '99ZzABCDEFGHIJKLMNOP',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ12',
      'AbCdEf1234567890GhIjKlMn',
      'a0AfB_byC1234567890abcdef',
      'AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTA',
      'MnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrS',
      'ESCAPED_SECRET_1',
      'ESCAPED_PASS_2',
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it('私钥块整段脱敏', () => {
    const out = redactSecrets(
      'k=-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY----- done'
    );
    expect(out).not.toContain('MIIEow');
    expect(out).toContain('done');
  });

  it('本机用户路径、邮箱与手机号脱敏，且不误伤 npm 包名、版本号和时间戳', () => {
    const input = [
      'at /Users/alice/work/app.ts:10',
      'cfg=/home/bob/.config/enso',
      'win=C:\\Users\\carol\\AppData\\Local\\enso',
      'winJson="C:\\\\Users\\\\dave\\\\Desktop"',
      'email=alice.smith@company.com',
      'phone=+86 13812345678 mobile=13987654321',
      'pkg=@anthropic-ai/sdk@1.2.3 ts=1735689600000 port=8080',
    ].join('\n');
    const out = redactSecrets(input);
    for (const leaked of [
      'alice',
      'bob',
      'carol',
      'dave',
      'alice.smith@company.com',
      '13812345678',
      '13987654321',
    ]) {
      expect(out, leaked).not.toContain(leaked);
    }
    expect(out).toContain('/Users/<user>/work/app.ts:10');
    expect(out).toContain('/home/<user>/.config/enso');
    expect(out).toContain('C:\\Users\\<user>\\AppData\\Local\\enso');
    expect(out).toContain('C:\\\\Users\\\\<user>\\\\Desktop');
    expect(out).toContain('@anthropic-ai/sdk@1.2.3');
    expect(out).toContain('ts=1735689600000');
    expect(out).toContain('port=8080');
  });

  it('超长连续字符线性处理，不发生 O(n²) 正则回溯', () => {
    const run = 'a'.repeat(200_000);
    const start = Date.now();
    const out = redactSecrets(`${run} https://u:p4ss@h sk-proj-AbCdEf1234567890`);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(out).not.toContain('p4ss');
    expect(out).not.toContain('AbCdEf1234567890');
  });

  it('普通文本保持不变', () => {
    const text =
      '[agent] turn finished in 120ms, tokens: 42, session=abc, {"token":false,"auth":{"token":null}}';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('inferLogSource', () => {
  it('IPC 入参收窄', () => {
    expect(parseLogSummaryLevel('warn')).toBe('warn');
    expect(parseLogSummaryLevel('info')).toBe('error');
    expect(parseLogSummaryLevel({})).toBe('error');
    expect(parseLogExportHours(24)).toBe(24);
    expect(parseLogExportHours(5)).toBeNull();
    expect(parseLogExportHours('24')).toBeNull();
  });

  it('按模块前缀区分来源', () => {
    expect(inferLogSource('[mcp] connect failed', 'agent')).toBe('mcp');
    expect(inferLogSource('[mcp:github] boom', 'main')).toBe('mcp');
    expect(inferLogSource('[plugins] event failed', 'main')).toBe('plugin');
    expect(inferLogSource('[extension-plugins] x', 'main')).toBe('plugin');
    expect(inferLogSource('[bots] send failed', 'main')).toBe('main');
    expect(inferLogSource('plain', 'agent')).toBe('agent');
  });
});

describe('结构化日志行', () => {
  it('写出时脱敏，读回保留级别、来源、时间与完整堆栈', () => {
    const t = Date.UTC(2025, 0, 1);
    const line = formatAppLogLine({
      time: t,
      level: 'error',
      source: 'main',
      text: 'Error: boom key=sk-abcdefghijklmnop1234\n    at foo (a.ts:1)',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toContain('sk-abcdefghijklmnop1234');
    const [entry] = parseAppLogLines(`${line}not json\n`);
    expect(entry).toMatchObject({ time: t, level: 'error', source: 'main' });
    expect(entry.message).toBe('Error: boom key=***');
    expect(entry.detail).toContain('at foo (a.ts:1)');
  });

  it('超长文本截断', () => {
    const line = formatAppLogLine({
      time: 0,
      level: 'info',
      source: 'main',
      text: 'x'.repeat(50_000),
    });
    expect(line.length).toBeLessThan(20_000);
  });
});

describe('summarizeErrors', () => {
  const pluginText = [
    '2025-01-01T00:00:01.000Z [info] started',
    '2025-01-01T00:00:02.000Z [error] crashed token=abc',
    '2025-01-01T00:00:03.000Z [warn] slow',
  ].join('\n');
  const stamped =
    '[2025-01-01T00:00:04.000Z] worker exited code=1\nstderr tail\n[2025-01-01T00:00:05.000Z] again\n';
  const jsonl = [
    formatAppLogLine({
      time: Date.parse('2025-01-01T00:00:06Z'),
      level: 'info',
      source: 'main',
      text: 'hello',
    }),
    formatAppLogLine({
      time: Date.parse('2025-01-01T00:00:07Z'),
      level: 'error',
      source: 'mcp',
      text: '[mcp] connect failed',
    }),
    formatAppLogLine({
      time: Date.parse('2025-01-01T00:00:08Z'),
      level: 'warn',
      source: 'agent',
      text: 'retrying',
    }),
  ].join('');
  const entries = [
    ...parsePluginLogLines(pluginText, 'demo.x'),
    ...parseStampedLog(stamped, 'agent', 'error'),
    ...parseAppLogLines(jsonl),
  ];

  it('默认只出 error，按时间倒序，来源正确', () => {
    const out = summarizeErrors(entries, { minLevel: 'error', limit: 10 });
    expect(out.map((e) => [e.source, e.level])).toEqual([
      ['mcp', 'error'],
      ['agent', 'error'],
      ['agent', 'error'],
      ['plugin', 'error'],
    ]);
    expect(out[3].message).toBe('[demo.x] crashed token=***');
    expect(out[2].detail).toContain('stderr tail');
  });

  it('warn 筛选包含 warn，不含 info；limit 生效', () => {
    const out = summarizeErrors(entries, { minLevel: 'warn', limit: 3 });
    expect(out.map((e) => e.level)).toEqual(['warn', 'error', 'error']);
    expect(
      summarizeErrors(entries, { minLevel: 'warn', limit: 100 }).some((e) => e.level === 'info')
    ).toBe(false);
  });

  it('debug 行能读回（导出可见），但不进汇总', () => {
    const debug = [
      formatAppLogLine({ time: 1, level: 'debug', source: 'agent', text: '[abort] stale' }),
    ].join('');
    const plugin = '2025-01-01T00:00:09.000Z [debug] renderer.call 失败： 调用已取消';
    const parsed = [...parseAppLogLines(debug), ...parsePluginLogLines(plugin, 'demo.x')];
    expect(parsed.map((e) => e.level)).toEqual(['debug', 'debug']);
    expect(summarizeErrors(parsed, { minLevel: 'warn', limit: 10 })).toEqual([]);
  });
});

describe('classifyWorkerExitLevel', () => {
  it('退出行：code=0、优雅重启记 info，非 0 与崩溃记 error', () => {
    expect(classifyWorkerExitLevel('exit pid=1 code=0')).toBe('info');
    expect(classifyWorkerExitLevel('exit pid=1 code=15 (graceful restart)')).toBe('info');
    expect(classifyWorkerExitLevel('exit pid=1 code=15 (expected stop)')).toBe('info');
    expect(classifyWorkerExitLevel('exit pid=1 code=1')).toBe('error');
    expect(
      classifyWorkerExitLevel('exit pid=1 uncaughtException: boom (code=1) (expected stop)')
    ).toBe('error');
  });

  it('正常退出的输出尾部记 info；尾部带错误行或非正常退出记 warn', () => {
    expect(classifyWorkerExitLevel('output tail pid=1 (normal exit)\n[agent] ready\nbye')).toBe(
      'info'
    );
    expect(
      classifyWorkerExitLevel(
        'output tail pid=1 (normal exit)\n[agent] ready\nError: ENOSPC no space left'
      )
    ).toBe('warn');
    expect(classifyWorkerExitLevel('output tail pid=1\n[agent] ready')).toBe('warn');
  });
});
