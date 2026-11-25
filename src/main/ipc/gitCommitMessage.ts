import { app, ipcMain } from '@platform';
import { DEFAULT_GIT_COMMIT_PROMPT, parseGitCommitPromptWrite } from '@shared/gitCommitMessage';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { titleSummaryTimeoutMs } from '../../agent/titleSummary';
import { completeText, isAgentWorkerReady, resolveModelSelection } from '../services/agentHost';
import {
  createCommitMessageGenerator,
  readGitCommitPrompt,
  resetGitCommitPrompt,
  writeGitCommitPrompt,
} from '../services/gitCommitMessage';
import { GitRepository } from '../services/gitVersionControl';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { isMainRenderer } from '../services/renderers';
import { readSettings } from './settings';
import { withSessionGitWorkspace } from './worktree';

function settingsState(): Record<string, unknown> | undefined {
  return (readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined)
    ?.state;
}

const dataDir = () => app.getPath('userData');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerGitCommitMessageHandlers(): void {
  const generator = createCommitMessageGenerator({
    settingsState,
    resolveModel: async (ref) => {
      if (!isAgentWorkerReady()) return { ok: false, error: 'Agent worker is not running.' };
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const resolved = resolveModelSelection(ref.providerId, ref.modelId, credentialKeys);
      return resolved.ok ? { ok: true, config: resolved.selection.config } : resolved;
    },
    readDiffs: (request) =>
      withSessionGitWorkspace(request, false, async (cwd, assertCurrent) => {
        const diffs = await (await GitRepository.open(cwd, assertCurrent)).changeDiffs();
        assertCurrent();
        return diffs;
      }),
    readPrompt: () =>
      settingsState()?.gitCommitPromptCustomized === true
        ? readGitCommitPrompt(dataDir()).text
        : DEFAULT_GIT_COMMIT_PROMPT,
    complete: ({ signal, ...input }) =>
      completeText({ ...input, timeoutMs: titleSummaryTimeoutMs(1), reasoning: 'off', signal }),
  });

  ipcMain.handle(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE, (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) {
      return { ok: false, code: 'unavailable', error: 'not authorized' };
    }
    return generator.generate(request);
  });
  ipcMain.handle(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE_ABORT, (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'not authorized' };
    return generator.abort(request);
  });
  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_PROMPT_READ, (event) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'not authorized' };
    return { ok: true, ...readGitCommitPrompt(dataDir()) };
  });
  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_PROMPT_WRITE, (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'not authorized' };
    const parsed = parseGitCommitPromptWrite(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    try {
      writeGitCommitPrompt(dataDir(), parsed.text);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_PROMPT_RESET, (event) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'not authorized' };
    try {
      resetGitCommitPrompt(dataDir());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  });
}
