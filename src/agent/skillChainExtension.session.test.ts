import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { prependTurnNote } from '@shared/turnNotes';
import { afterEach, expect, it, vi } from 'vitest';
import { skillChainExtension } from './skillChainExtension';
import { UNATTENDED_ON_NOTE } from './unattended';

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const prefixPlugin: InlineExtension = {
  name: 'prefix-plugin',
  factory: (pi) => {
    pi.on('input', (event) => ({ action: 'transform', text: `/skill:alpha ${event.text}` }));
  },
};

it('插件追加的 /skill: 与用户选的 /skill: 在真实 pi 会话里都被展开', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-skill-chain-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  for (const name of ['alpha', 'beta']) {
    mkdirSync(path.join(skillsDir, name), { recursive: true });
    writeFileSync(
      path.join(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBODY-${name}\n`
    );
  }
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  vi.spyOn(runtime, 'streamSimple').mockImplementation(() => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  });
  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: [skillsDir],
    systemPrompt: 'Skill chain test.',
    extensionFactories: [prefixPlugin, skillChainExtension(() => loader.getSkills().skills)],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    noTools: 'builtin',
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  await session.prompt(prependTurnNote(UNATTENDED_ON_NOTE, '/skill:beta 做事'));

  const user = session.messages.find((message) => message.role === 'user');
  const text =
    typeof user?.content === 'string'
      ? user.content
      : (user?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  expect(text).toMatch(
    /^<skill name="alpha" [^>]*>\n[\s\S]*BODY-alpha\n<\/skill>\n\n<skill name="beta" [^>]*>\n[\s\S]*BODY-beta\n<\/skill>\n\n<unattended>\n[\s\S]*<\/unattended>\n\n做事$/
  );
});
