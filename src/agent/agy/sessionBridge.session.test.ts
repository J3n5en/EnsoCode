import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../approval';
import { registerAgyProvider, streamAgy } from './provider';
import { closeAllAgySessions } from './registry';
import { setAgySessionOpener } from './runtimeHost';
import type { AgySession, AgyTurnInput, AgyTurnResult } from './session';
import { attachAgyBridgeToSession } from './sessionBridge';

const cleanups: Array<() => void> = [];
afterEach(async () => {
  setAgySessionOpener(undefined);
  await closeAllAgySessions();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Turn = (input: AgyTurnInput) => Promise<AgyTurnResult>;

function fakeAgy(turn: Turn, onClose?: () => void): AgySession {
  return {
    phase: () => ({ phase: 'closed' }),
    sessionId: () => 'agy-1',
    resumed: false,
    turn,
    close: async () => onClose?.(),
  };
}

function result(text: string): AgyTurnResult {
  return {
    stopReason: 'stop',
    text,
    thinking: '',
    tools: [],
    sessionId: 'agy-1',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  };
}

async function setup(ensoSessionId = 'enso-1') {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-bridge-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  registerAgyProvider(runtime, []);
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  vi.spyOn(runtime, 'streamSimple').mockImplementation(
    (model, context, options) =>
      streamAgy(model as never, context as never, options as never) as never
  );
  const model = runtime.getModel(AGY_PROVIDER_ID, 'default');
  if (!model) throw new Error('agy model missing');
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'agy bridge test',
  });
  await resourceLoader.reload();
  const sessionDir = path.join(root, 'sessions');
  const manager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    resourceLoader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    noTools: 'builtin',
    customTools: [],
  });
  attachAgyBridgeToSession(session, {
    ensoSessionId,
    cwd,
    sessionDir,
    clientVersion: '0.0.0',
    gate: new ApprovalGate(
      'full',
      () => {},
      () => {}
    ),
    planActive: () => false,
    readRoots: () => [cwd],
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
  };
  cleanups.push(() => {
    dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { session, manager, dispose };
}

function readTurn(input: AgyTurnInput): Promise<AgyTurnResult> {
  input.onEvent?.({ type: 'text', delta: 'Reading.' });
  input.onEvent?.({
    type: 'tool',
    id: 'read-1',
    name: 'read_file',
    status: 'in_progress',
    args: { path: '/w/a.ts' },
  });
  input.onEvent?.({
    type: 'tool',
    id: 'read-1',
    name: 'read_file',
    status: 'completed',
    args: { path: '/w/a.ts' },
    output: 'file body',
  });
  input.onEvent?.({ type: 'text', delta: 'Done.' });
  return Promise.resolve(result('Reading.Done.'));
}

it('closes its agy session when the pi session is disposed', async () => {
  let closed = 0;
  setAgySessionOpener(async () => fakeAgy(readTurn, () => (closed += 1)));
  const { session, dispose } = await setup('enso-child-a');
  await session.prompt('read a.ts');
  await session.waitForIdle();
  dispose();
  await vi.waitFor(() => expect(closed).toBe(1));
});
