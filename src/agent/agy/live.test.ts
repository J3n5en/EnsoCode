// 真机核对：AGY_LIVE=1 pnpm vitest run src/agent/agy/live.test.ts
// 用本机已登录的 agy，一次一个会话，总共几条很短的 prompt。不调用 authenticate。
// 线上的原始 JSON-RPC 记在 $AGY_LIVE_OUT/wire-*.jsonl（默认 /tmp/agy-live），供写 Live findings。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgyPermissionRequest, TranslatorEffect } from '@shared/agy/types';
import { describe, expect, it } from 'vitest';
import { closeHostMcp, issueHostMcp } from './hostMcp';
import { agyChildEnv, agyCommandArgs, agyOnPath, resolveAgyBinary } from './launch';
import { startAgyProcess } from './process';
import { type AgySession, type AgyTurnInput, openAgySession } from './session';

const live = process.env.AGY_LIVE === '1';
const out = process.env.AGY_LIVE_OUT || path.join(os.tmpdir(), 'agy-live');
const tap = fileURLToPath(new URL('./fixtures/wireTap.mjs', import.meta.url));
const TIMEOUT = 240_000;

function agyBinary(): string {
  const binary = resolveAgyBinary({ pathHit: agyOnPath(), home: os.homedir(), exists: existsSync });
  if (!binary) throw new Error('agy not found');
  return binary;
}

export async function openLive(
  name: string,
  cwd: string,
  extra: { resumeSessionId?: string } = {}
): Promise<{ session: AgySession; wire: string }> {
  mkdirSync(out, { recursive: true });
  const wire = path.join(out, `wire-${name}.jsonl`);
  writeFileSync(wire, '');
  const session = await openAgySession({
    command: process.execPath,
    args: [tap, wire, agyBinary(), ...agyCommandArgs(false)],
    cwd,
    env: agyChildEnv(process.env),
    clientVersion: '0.3.14',
    readRoots: [cwd],
    timeoutMs: 90_000,
    ...extra,
  });
  return { session, wire };
}

export function wireMessages(
  wire: string
): { direction: string; message: Record<string, unknown> }[] {
  return readFileSync(wire, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; line: string })
    .filter((row) => row.direction !== 'stderr')
    .flatMap((row) => {
      try {
        return [{ direction: row.direction, message: JSON.parse(row.line) }];
      } catch {
        return [{ direction: row.direction, message: { raw: row.line } }];
      }
    });
}

export function baseTurn(
  cwd: string,
  text: string,
  extra: Partial<AgyTurnInput> = {}
): AgyTurnInput {
  return {
    messages: [{ role: 'user', content: text }],
    planMode: false,
    approvalMode: 'supervised',
    workspaceRoot: cwd,
    modelId: 'default',
    thinkingLevel: 'off',
    modelLabel: 'agy default',
    ask: async () => 'allow',
    ...extra,
  };
}

function record(name: string, value: unknown) {
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

describe.runIf(live)('agy live', () => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-live-cwd-')));
  writeFileSync(path.join(cwd, 'note.txt'), 'The secret word is marmalade.\n');
  let sessionId = '';

  it(
    'handshake, text, file read, permission, cancel',
    async () => {
      const { session, wire } = await openLive('main', cwd);
      sessionId = session.sessionId() ?? '';
      try {
        const effects: TranslatorEffect[] = [];
        const hello = await session.turn(
          baseTurn(cwd, 'Reply with the single word: pong', { onEvent: (e) => effects.push(e) })
        );
        record('turn-hello', { result: hello, effects });
        expect(hello.text.toLowerCase()).toContain('pong');

        const readEffects: TranslatorEffect[] = [];
        const read = await session.turn(
          baseTurn(cwd, 'Open note.txt in the current directory and tell me the secret word.', {
            onEvent: (e) => readEffects.push(e),
          })
        );
        record('turn-read', { result: read, effects: readEffects });

        const asked: AgyPermissionRequest[] = [];
        const shellEffects: TranslatorEffect[] = [];
        const shell = await session.turn(
          baseTurn(cwd, 'Run the shell command `echo agy-live-ok` and tell me its output.', {
            onEvent: (e) => shellEffects.push(e),
            ask: async (request) => {
              asked.push(request);
              return 'allow';
            },
          })
        );
        record('turn-permission', { result: shell, asked, effects: shellEffects });

        const controller = new AbortController();
        const cancelEffects: TranslatorEffect[] = [];
        const started = Date.now();
        const cancelled = await session.turn(
          baseTurn(cwd, 'Count from 1 to 300, one number per line, no other text.', {
            signal: controller.signal,
            onEvent: (e) => {
              cancelEffects.push(e);
              if (e.type === 'text' && !controller.signal.aborted) controller.abort();
            },
          })
        );
        record('turn-cancel', {
          result: cancelled,
          ms: Date.now() - started,
          effects: cancelEffects.length,
        });
        expect(cancelled.stopReason).toBe('aborted');
      } finally {
        await session.close();
        record('wire-main', wireMessages(wire));
      }
    },
    TIMEOUT * 2
  );

  it(
    'resumes the stored session in a new process and remembers context',
    async () => {
      expect(sessionId).not.toBe('');
      const { session, wire } = await openLive('resume', cwd, { resumeSessionId: sessionId });
      try {
        const recalled = await session.turn(
          baseTurn(cwd, 'What was the secret word you read earlier? Answer with only the word.')
        );
        record('turn-resume', { resumed: session.resumed, id: session.sessionId(), recalled });
        expect(session.resumed).toBe(true);
        expect(recalled.text.toLowerCase()).toContain('marmalade');
      } finally {
        await session.close();
        record('wire-resume', wireMessages(wire));
      }
    },
    TIMEOUT
  );

  it(
    'answers a second session/prompt sent mid-turn (raw wire)',
    async () => {
      const wire = path.join(out, 'wire-steer.jsonl');
      writeFileSync(wire, '');
      const proc = startAgyProcess({
        command: process.execPath,
        args: [tap, wire, agyBinary(), ...agyCommandArgs(false)],
        cwd,
        env: agyChildEnv(process.env),
      });
      const timeline: { at: number; what: string }[] = [];
      const t0 = Date.now();
      const note = (what: string) => timeline.push({ at: Date.now() - t0, what });
      let firstChunk: () => void = () => {};
      const sawChunk = new Promise<void>((resolve) => {
        firstChunk = resolve;
      });
      proc.rpc.setNotificationHandler((_method, params) => {
        const update = (params as { update?: Record<string, unknown> }).update ?? {};
        const kind = String(update.sessionUpdate);
        const text = (update.content as { text?: string } | undefined)?.text ?? '';
        note(kind === 'agent_message_chunk' ? `text:${text.slice(0, 40)}` : kind);
        if (kind === 'agent_message_chunk') firstChunk();
      });
      proc.rpc.setRequestHandler(async (method) => {
        note(`request:${method}`);
        throw new Error(`unexpected ${method}`);
      });
      try {
        await proc.rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'enso-code', title: 'EnsoCode', version: '0.3.14' },
        });
        const opened = (await proc.rpc.request('session/new', { cwd, mcpServers: [] })) as {
          sessionId: string;
        };
        const first = proc.rpc
          .request('session/prompt', {
            sessionId: opened.sessionId,
            prompt: [{ type: 'text', text: 'Write a 250-word story about a lighthouse keeper.' }],
          })
          .then((result) => {
            note(`first-result:${JSON.stringify(result)}`);
            return result;
          });
        await sawChunk;
        note('steer-sent');
        const second = proc.rpc
          .request('session/prompt', {
            sessionId: opened.sessionId,
            prompt: [{ type: 'text', text: 'Stop the story. Reply with only the word: steered' }],
          })
          .then((result) => {
            note(`second-result:${JSON.stringify(result)}`);
            return result;
          });
        await Promise.all([first, second]);
        record('turn-steer', timeline);
      } finally {
        await proc.kill();
        record('wire-steer', wireMessages(wire));
      }
    },
    TIMEOUT
  );

  it(
    'sees and calls a tool on an injected HTTP MCP server (raw wire)',
    async () => {
      const wire = path.join(out, 'wire-mcp.jsonl');
      writeFileSync(wire, '');
      const log: unknown[] = [];
      const issued = await issueHostMcp({
        tools: () => {
          log.push('tools/list');
          return [
            {
              name: 'enso_probe',
              description: 'Echo the given text back, prefixed with probe:.',
              inputSchema: {
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ];
        },
        call: async (name, args) => {
          log.push({ call: name, args });
          return { content: [{ type: 'text', text: `probe:${String(args.text)}` }] };
        },
      });
      const proc = startAgyProcess({
        command: process.execPath,
        args: [tap, wire, agyBinary(), ...agyCommandArgs(false)],
        cwd,
        env: agyChildEnv(process.env),
      });
      proc.rpc.setNotificationHandler(() => {});
      proc.rpc.setRequestHandler(async (method, params) => {
        log.push({ request: method, params });
        if (method === 'session/request_permission') {
          const options = (params as { options: { optionId: string; kind: string }[] }).options;
          const allow = options.find((option) => option.kind.startsWith('allow'));
          return { outcome: { outcome: 'selected', optionId: allow?.optionId } };
        }
        throw new Error(`unexpected ${method}`);
      });
      try {
        await proc.rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'enso-code', title: 'EnsoCode', version: '0.3.14' },
        });
        const opened = (await proc.rpc.request('session/new', {
          cwd,
          mcpServers: [issued.server],
        })) as { sessionId: string };
        const result = await proc.rpc.request('session/prompt', {
          sessionId: opened.sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Call the enso_probe tool with text "hello", then reply with exactly what it returned.',
            },
          ],
        });
        record('turn-mcp', { result, log });
      } finally {
        await proc.kill();
        issued.revoke();
        await closeHostMcp();
        record('wire-mcp', wireMessages(wire));
      }
    },
    TIMEOUT
  );
});
