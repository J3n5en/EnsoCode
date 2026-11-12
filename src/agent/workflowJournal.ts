import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * workflow 运行日志（借鉴 qwen-code workflow-journal / workflow-checkpoint）：
 * 每次 agent() 成功的结果按“滚动前缀 + 派发参数”哈希落盘，resume 时最长不变前缀直接复用；
 * 进程中途退出的运行没有收尾行，下次打开会话时认领并告诉模型可以续跑。
 */
export interface WorkflowLaunch {
  runId: string;
  sessionId: string;
  name: string;
  description: string;
  script: string;
  args: Record<string, unknown>;
  model?: string;
  /** 沙箱里 Date.now() 固定为此值，续跑时脚本派生的提示保持一致 */
  startedAt: number;
}

type Lifecycle = 'launched' | 'resumed' | 'settled';
type Line =
  | ({ t: 'launched' } & WorkflowLaunch)
  | { t: 'resumed'; at: number }
  | { t: 'result'; key: string; value: unknown }
  | { t: 'settled'; status: string };

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const RETENTION_MS = 7 * 24 * 3600_000;

export function workflowJournalFile(dir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid workflow runId: ${runId}`);
  return path.join(dir, `${runId}.jsonl`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  return value;
}

/** 只取影响派发结果的参数；label / phase 等展示字段不参与 */
export function agentCallKey(prevKey: string, payload: Record<string, unknown>): string {
  const opts = canonical({
    model: payload.model,
    agentType: payload.agentType,
    schema: payload.schema,
  });
  return createHash('sha256')
    .update(prevKey)
    .update('\0')
    .update(String(payload.prompt ?? ''))
    .update('\0')
    .update(JSON.stringify(opts))
    .digest('hex');
}

export class WorkflowJournal {
  readonly file: string;

  constructor(
    private readonly dir: string,
    runId: string
  ) {
    this.file = workflowJournalFile(dir, runId);
  }

  private append(line: Line): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch (error) {
      console.warn(`[workflow] journal write failed for ${this.file}:`, error);
    }
  }

  private lines(): Line[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    return raw.split('\n').flatMap((text) => {
      if (!text.trim()) return [];
      try {
        const line = JSON.parse(text) as Line;
        return line && typeof line === 'object' && typeof line.t === 'string' ? [line] : [];
      } catch {
        return [];
      }
    });
  }

  launch(launch: WorkflowLaunch): void {
    this.append({ t: 'launched', ...launch });
  }

  resumed(): void {
    this.append({ t: 'resumed', at: Date.now() });
  }

  readLaunch(): WorkflowLaunch | undefined {
    const line = this.lines().find((entry) => entry.t === 'launched');
    if (line?.t !== 'launched') return undefined;
    const { t: _t, ...launch } = line;
    return launch;
  }

  results(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const line of this.lines()) if (line.t === 'result') out.set(line.key, line.value);
    return out;
  }

  recordResult(key: string, value: unknown): void {
    this.append({ t: 'result', key, value });
  }

  isSettled(): boolean {
    const lifecycle = this.lines().filter((line) =>
      (['launched', 'resumed', 'settled'] as Lifecycle[]).includes(line.t as Lifecycle)
    );
    return lifecycle.at(-1)?.t === 'settled';
  }

  /** 被显式停止的运行不再续跑，删掉日志；完成（可能有失败成员）、失败与中断保留，可 resume 补跑 */
  settle(status: 'completed' | 'cancelled' | 'failed' | 'interrupted'): void {
    if (status === 'cancelled') {
      rmSync(this.file, { force: true });
      return;
    }
    this.append({ t: 'settled', status });
  }
}

/**
 * 认领本会话被进程退出打断的运行：有启动行、没收尾、也不在本进程运行表里。
 * 认领即写收尾行，同一运行只告知一次；顺带清理超期日志。
 */
export function claimInterruptedWorkflowRuns(
  dir: string,
  sessionId: string,
  activeRunIds: ReadonlySet<string>
): WorkflowLaunch[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const claimed: WorkflowLaunch[] = [];
  for (const name of names) {
    const runId = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
    if (!RUN_ID.test(runId) || activeRunIds.has(runId)) continue;
    const journal = new WorkflowJournal(dir, runId);
    try {
      if (Date.now() - statSync(journal.file).mtimeMs > RETENTION_MS) {
        rmSync(journal.file, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    const launch = journal.readLaunch();
    if (!launch || launch.sessionId !== sessionId || journal.isSettled()) continue;
    journal.settle('interrupted');
    claimed.push(launch);
  }
  return claimed;
}
