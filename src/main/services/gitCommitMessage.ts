/** AI 生成 Git 提交信息（Main 侧）：配置校验 → 读 diff → 复用 worker 一次性补全 → 清洗。依赖注入便于单测。 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DefaultModelRef } from '@shared/defaultModel';
import {
  cleanCommitMessage,
  DEFAULT_GIT_COMMIT_PROMPT,
  type GenerateCommitMessageResult,
  type GitCommitConfigIssue,
  parseGenerateCommitMessageAbort,
  parseGenerateCommitMessageRequest,
  redactSensitiveDiff,
  selectCommitDiff,
  truncateCommitDiff,
} from '@shared/gitCommitMessage';
import type { SpawnModelConfig } from '@shared/types/agent';
import type { GitRequest } from '@shared/types/git';

export const GIT_COMMIT_PROMPT_FILE = 'git-commit-prompt.txt';

export interface CommitMessageDeps {
  settingsState: () => Record<string, unknown> | undefined;
  resolveModel: (
    ref: DefaultModelRef
  ) => Promise<{ ok: true; config: SpawnModelConfig } | { ok: false; error: string }>;
  readDiffs: (request: GitRequest) => Promise<{ staged: string; unstaged: string }>;
  readPrompt: () => string;
  complete: (input: {
    systemPrompt: string;
    userText: string;
    candidates: SpawnModelConfig[];
    signal: AbortSignal;
  }) => Promise<string>;
}

const NOT_CONFIGURED: Record<GitCommitConfigIssue, string> = {
  provider: 'Git commit generation has no provider configured.',
  model: 'Git commit generation has no model configured.',
};

const notConfigured = (missing: GitCommitConfigIssue): GenerateCommitMessageResult => ({
  ok: false,
  code: 'not-configured',
  missing,
  error: NOT_CONFIGURED[missing],
});

const aborted: GenerateCommitMessageResult = { ok: false, code: 'aborted', error: 'aborted' };

function configuredRef(
  state: Record<string, unknown> | undefined
): DefaultModelRef | GitCommitConfigIssue {
  const value = state?.gitCommitModel;
  if (!value || typeof value !== 'object') return 'provider';
  const { providerId, modelId } = value as { providerId?: unknown; modelId?: unknown };
  if (typeof providerId !== 'string' || !providerId) return 'provider';
  if (typeof modelId !== 'string' || !modelId) return 'model';
  return { providerId, modelId };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCommitMessageGenerator(deps: CommitMessageDeps) {
  const inflight = new Map<string, AbortController>();

  async function run(
    request: GitRequest,
    ref: DefaultModelRef,
    signal: AbortSignal
  ): Promise<GenerateCommitMessageResult> {
    const model = await deps.resolveModel(ref);
    if (signal.aborted) return aborted;
    if (!model.ok) {
      if (model.error === 'Model provider is unavailable.') return notConfigured('provider');
      if (model.error.startsWith('Model is unavailable')) return notConfigured('model');
      return { ok: false, code: 'model-error', error: model.error };
    }
    let diffs: { staged: string; unstaged: string };
    try {
      diffs = await deps.readDiffs(request);
    } catch (error) {
      return { ok: false, code: 'git-error', error: errorText(error) };
    }
    if (signal.aborted) return aborted;
    const selected = selectCommitDiff({
      staged: redactSensitiveDiff(diffs.staged),
      unstaged: redactSensitiveDiff(diffs.unstaged),
    });
    if (!selected) return { ok: false, code: 'no-changes', error: 'No changes to commit.' };
    const { text, truncated } = truncateCommitDiff(selected.diff);
    let output: string;
    try {
      output = await deps.complete({
        systemPrompt: deps.readPrompt(),
        userText: text,
        candidates: [model.config],
        signal,
      });
    } catch (error) {
      return signal.aborted ? aborted : { ok: false, code: 'model-error', error: errorText(error) };
    }
    if (signal.aborted) return aborted;
    const message = cleanCommitMessage(output);
    if (!message)
      return { ok: false, code: 'empty-output', error: 'Model returned an empty commit message.' };
    return { ok: true, message, source: selected.source, truncated };
  }

  return {
    async generate(value: unknown): Promise<GenerateCommitMessageResult> {
      const parsed = parseGenerateCommitMessageRequest(value);
      if (!parsed || inflight.has(parsed.requestId)) {
        return { ok: false, code: 'invalid-request', error: 'Invalid request.' };
      }
      const ref = configuredRef(deps.settingsState());
      if (typeof ref === 'string') return notConfigured(ref);
      // 同步登记，紧随其后的取消请求一定能对上
      const controller = new AbortController();
      inflight.set(parsed.requestId, controller);
      try {
        return await run(
          { conversationId: parsed.conversationId, projectId: parsed.projectId },
          ref,
          controller.signal
        );
      } finally {
        inflight.delete(parsed.requestId);
      }
    },
    abort(value: unknown): { ok: boolean; error?: string } {
      const parsed = parseGenerateCommitMessageAbort(value);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const controller = inflight.get(parsed.requestId);
      if (!controller) return { ok: false, error: 'not running' };
      inflight.delete(parsed.requestId);
      controller.abort();
      return { ok: true };
    },
  };
}

/** 自定义提示词存独立文件（不进 settings.json）；路径只由 Main 按 userData 推导 */
export function readGitCommitPrompt(dir: string): { text: string; custom: boolean } {
  try {
    const text = readFileSync(path.join(dir, GIT_COMMIT_PROMPT_FILE), 'utf8');
    if (text.trim()) return { text, custom: true };
  } catch {
    // 无文件或读失败一律回退默认
  }
  return { text: DEFAULT_GIT_COMMIT_PROMPT, custom: false };
}

export function writeGitCommitPrompt(dir: string, text: string): void {
  const file = path.join(dir, GIT_COMMIT_PROMPT_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

export function resetGitCommitPrompt(dir: string): void {
  const file = path.join(dir, GIT_COMMIT_PROMPT_FILE);
  if (existsSync(file)) rmSync(file, { force: true });
}
