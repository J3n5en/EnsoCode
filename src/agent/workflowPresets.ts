import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isWorkflowPresetId,
  type WorkflowPresetArg,
  type WorkflowPresetDraft,
  type WorkflowPresetSaveResult,
  type WorkflowPresetSource,
  type WorkflowPresetSummary,
} from '@shared/types/workflow';
import { generateWorkflowScript, parseWorkflowDesign } from '@shared/workflowDesign';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface WorkflowPreset extends WorkflowPresetSummary {
  script: string;
}

export interface WorkflowPresetRoot {
  dir: string;
  source: Exclude<WorkflowPresetSource, 'builtin'>;
  /** 只认这些 id（插件清单逐个列出文件）；缺省为目录下全部 */
  ids?: readonly string[];
}

const ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const HEADER_RE = /^\/\*---\r?\n([\s\S]*?)\r?\n---\*\//;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ARGS = 8;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function parseArgs(value: unknown): WorkflowPresetArg[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) return null;
  const args: WorkflowPresetArg[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key : '';
    if (!ARG_KEY_RE.test(key) || args.some((arg) => arg.key === key)) return null;
    const label = record.label === undefined ? key : text(record.label, 80);
    if (!label) return null;
    const arg: WorkflowPresetArg = { key, label };
    if (record.default !== undefined) {
      if (typeof record.default !== 'string' || record.default.length > 2000) return null;
      arg.default = record.default;
    }
    if (record.required === true) arg.required = true;
    args.push(arg);
  }
  return args;
}

/** 文件格式：开头 `/*--- YAML ---*\/` 注释头（name/description/args），整份文件即脚本。 */
export function parseWorkflowPreset(
  id: string,
  source: WorkflowPresetSource,
  raw: string
): WorkflowPreset | null {
  if (!isWorkflowPresetId(id)) return null;
  const match = HEADER_RE.exec(raw);
  if (!match || !raw.slice(match[0].length).trim()) return null;
  let meta: unknown;
  try {
    meta = parseYaml(match[1] ?? '');
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const name = text(record.name, 80);
  const description = text(record.description, 240);
  const args = parseArgs(record.args);
  if (!name || !description || !args) return null;
  return { id, source, name, description, args, script: raw };
}

export function workflowPresetRoots(
  localCwd: string | undefined,
  {
    customDir,
    home = os.homedir(),
    pluginFiles = [],
  }: { customDir?: string; home?: string; pluginFiles?: readonly string[] } = {}
): WorkflowPresetRoot[] {
  const pluginIds = new Map<string, string[]>();
  for (const file of pluginFiles) {
    if (path.extname(file) !== '.js') continue;
    const dir = path.dirname(file);
    pluginIds.set(dir, [...(pluginIds.get(dir) ?? []), path.basename(file, '.js')]);
  }
  return [
    ...(localCwd
      ? [{ dir: path.join(localCwd, '.agents', 'workflows'), source: 'project' as const }]
      : []),
    ...(customDir ? [{ dir: customDir, source: 'custom' as const }] : []),
    { dir: path.join(home, '.agents', 'workflows'), source: 'global' as const },
    ...[...pluginIds].map(([dir, ids]) => ({ dir, source: 'plugin' as const, ids })),
  ];
}

function readPresetFile(root: WorkflowPresetRoot, id: string): WorkflowPreset | null {
  if (root.ids && !root.ids.includes(id)) return null;
  try {
    const file = path.join(root.dir, `${id}.js`);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return parseWorkflowPreset(id, root.source, fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function rootIds(root: WorkflowPresetRoot): string[] {
  if (root.ids) return root.ids.filter(isWorkflowPresetId);
  try {
    return fs
      .readdirSync(root.dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.slice(0, -3))
      .filter(isWorkflowPresetId)
      .sort();
  } catch {
    return [];
  }
}

export function loadWorkflowPreset(
  id: string,
  roots: readonly WorkflowPresetRoot[],
  disabledBuiltins: readonly string[] = []
): WorkflowPreset | null {
  if (!isWorkflowPresetId(id)) return null;
  for (const root of roots) {
    const preset = readPresetFile(root, id);
    if (preset) return preset;
  }
  if (disabledBuiltins.includes(id)) return null;
  return builtinPresets().find((preset) => preset.id === id) ?? null;
}

export function listWorkflowPresets(
  roots: readonly WorkflowPresetRoot[],
  disabledBuiltins: readonly string[] = []
): WorkflowPresetSummary[] {
  const seen = new Set<string>();
  const list: WorkflowPresetSummary[] = [];
  const add = (preset: WorkflowPreset | null) => {
    if (!preset || seen.has(preset.id)) return;
    seen.add(preset.id);
    list.push(summary(preset));
  };
  for (const root of roots) for (const id of rootIds(root)) add(readPresetFile(root, id));
  for (const preset of builtinPresets()) if (!disabledBuiltins.includes(preset.id)) add(preset);
  return list;
}

/** 设置页展示内置预设（含已禁用的），不带脚本正文 */
export function listBuiltinWorkflowPresets(): WorkflowPresetSummary[] {
  return builtinPresets().map(summary);
}

function summary(preset: WorkflowPreset): WorkflowPresetSummary {
  const { script: _script, ...rest } = preset;
  return rest;
}

/** 设置页新增的预设：应用托管目录 userData/agent/workflows，Main 写、worker 读。 */
export function listCustomWorkflowPresets(dir: string): WorkflowPresetSummary[] {
  const root: WorkflowPresetRoot = { dir, source: 'custom' };
  return rootIds(root)
    .map((id) => readPresetFile(root, id))
    .filter((preset): preset is WorkflowPreset => preset !== null)
    .map(summary);
}

const hasCommentEnd = (value: string | undefined): boolean => value?.includes('*/') ?? false;

/** IPC 入参收窄；注释头里出现 `*\/` 会提前闭合注释，直接拒绝。有设计时脚本以设计生成为准。 */
export function parseWorkflowPresetDraft(raw: unknown): WorkflowPresetDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = text(record.name, 80);
  const description = text(record.description, 240);
  const args = parseArgs(record.args);
  const design = record.design === undefined ? undefined : parseWorkflowDesign(record.design);
  if (design === null) return null;
  const script = design
    ? generateWorkflowScript(design)
    : typeof record.script === 'string'
      ? record.script
      : '';
  if (!name || !description || !args || !script.trim()) return null;
  const designStrings = (design?.phases ?? []).flatMap((phase) => [
    phase.title,
    ...phase.steps.flatMap((step) => [step.label, step.agentType, step.prompt]),
  ]);
  const strings = [
    name,
    description,
    ...args.flatMap((arg) => [arg.key, arg.label, arg.default]),
    ...designStrings,
  ];
  if (strings.some(hasCommentEnd)) return null;
  return { name, description, args, script, ...(design ? { design } : {}) };
}

export function serializeWorkflowPreset(draft: WorkflowPresetDraft): string {
  const meta = {
    name: draft.name,
    description: draft.description,
    ...(draft.args.length > 0 ? { args: draft.args } : {}),
    ...(draft.design ? { design: draft.design } : {}),
  };
  return `/*---\n${stringifyYaml(meta).trimEnd()}\n---*/\n${draft.script}`;
}

function nextCustomId(dir: string, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'workflow';
  const taken = new Set([
    ...rootIds({ dir, source: 'custom' }),
    ...builtinPresets().map((preset) => preset.id),
  ]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** 不传 id 为新建（按名称生成 id）；传 id 只允许改已存在的文件，id 一经生成不再变。 */
export function saveCustomWorkflowPreset(
  dir: string,
  draft: WorkflowPresetDraft,
  id?: string
): WorkflowPresetSaveResult {
  if (id !== undefined) {
    if (!isWorkflowPresetId(id) || !fs.existsSync(path.join(dir, `${id}.js`))) {
      return { ok: false, error: 'Workflow preset not found' };
    }
  }
  const target = id ?? nextCustomId(dir, draft.name);
  const raw = serializeWorkflowPreset(draft);
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, error: 'Workflow preset is larger than 64 KB' };
  }
  if (!parseWorkflowPreset(target, 'custom', raw)) {
    return { ok: false, error: 'Invalid workflow preset' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${target}.js`), raw, 'utf8');
    return { ok: true, id: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readCustomWorkflowPreset(
  dir: string,
  id: string
): (WorkflowPresetDraft & { id: string }) | null {
  if (!isWorkflowPresetId(id)) return null;
  const preset = readPresetFile({ dir, source: 'custom' }, id);
  const header = preset ? HEADER_RE.exec(preset.script) : null;
  if (!preset || !header) return null;
  const script = preset.script.slice(header[0].length).replace(/^\r?\n/, '');
  const design = headerDesign(header[1] ?? '');
  return {
    id,
    name: preset.name,
    description: preset.description,
    args: preset.args,
    script,
    // 脚本被手改过就不再是设计产物，按纯代码预设打开
    ...(design && generateWorkflowScript(design) === script ? { design } : {}),
  };
}

function headerDesign(yaml: string) {
  try {
    const meta: unknown = parseYaml(yaml);
    return meta && typeof meta === 'object' && 'design' in meta
      ? parseWorkflowDesign(meta.design)
      : null;
  } catch {
    return null;
  }
}

export function deleteCustomWorkflowPreset(dir: string, id: string): boolean {
  if (!isWorkflowPresetId(id)) return false;
  const file = path.join(dir, `${id}.js`);
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkflowPresetArgs(
  preset: WorkflowPreset,
  input: Record<string, unknown>
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = { ...input };
  for (const arg of preset.args) {
    if (args[arg.key] === undefined && arg.default !== undefined) args[arg.key] = arg.default;
    const value = args[arg.key];
    if (arg.required && (value === undefined || (typeof value === 'string' && !value.trim()))) {
      return { ok: false, error: `workflow preset "${preset.id}" requires arg "${arg.key}"` };
    }
  }
  return { ok: true, args };
}

const BUILTIN_SOURCES: Record<string, string> = {
  'parallel-review': `/*---
name: Parallel review
description: Review a change set in parallel along several dimensions with read-only reviewers.
args:
  - key: target
    label: Review scope
    default: the uncommitted changes in the working tree
  - key: dimensions
    label: Dimensions (comma separated)
    default: correctness, security, performance
---*/
const dims = String(args.dimensions || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
if (dims.length === 0) return { error: 'no review dimensions given' };
await phase('review');
const findings = await parallel(dims.map((dim) => () => agent(
  'Review ' + args.target + '. Focus only on ' + dim + '. Report concrete issues with file:line, ' +
  'severity (high/medium/low) and a suggested fix. Do not edit any file. Say "no issues" if none.',
  { label: dim, agentType: 'reviewer' }
)));
return dims.map((dimension, i) => ({ dimension, findings: findings[i] }));
`,
  'multi-angle-investigation': `/*---
name: Multi-angle investigation
description: Investigate one question from implementation, tests and docs in parallel with read-only scouts.
args:
  - key: question
    label: Question
    required: true
---*/
const angles = [
  ['implementation', 'the source code that implements it and its call chain'],
  ['tests', 'the tests that cover it and the gaps in coverage'],
  ['docs', 'the docs, comments and design notes that describe it'],
];
await phase('investigate');
const notes = await parallel(angles.map(([label, focus]) => () => agent(
  'Question: ' + args.question + '\\nInvestigate ' + focus + '. Cite file paths with line numbers. ' +
  'Do not edit any file. Keep the answer under 300 words.',
  { label, agentType: 'scout' }
)));
return angles.map(([angle], i) => ({ angle, notes: notes[i] }));
`,
  arena: `/*---
name: Arena
description: Run N independent attempts at one task in separate worktrees, let a judge pick the base, then graft the best parts of the others into it.
args:
  - key: task
    label: Task
    required: true
  - key: candidates
    label: Number of candidates (1-6)
    default: "2"
  - key: models
    label: Candidate models (comma separated, rotated)
    default: ""
  - key: rubric
    label: Rubric for the judge (hidden from candidates)
    default: ""
---*/
const list = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const json = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };
const models = list(args.models);
const n = Math.min(6, Math.max(1, parseInt(args.candidates, 10) || models.length || 2));
const seat = (i) => (models.length ? { model: models[i % models.length] } : {});
const root = '/tmp/arena-' + Date.now().toString(36);
const copy = (path) => 'Work only in your own copy at ' + path + '. In a git repo create it with ' +
  '\\\`git worktree add --detach ' + path + ' HEAD\\\`, carry over uncommitted changes with ' +
  '\\\`git diff HEAD --binary | git -C ' + path + ' apply\\\`, and copy any untracked files the task needs. ' +
  'Never edit the main working tree.';
const reportSchema = { type: 'object', required: ['path', 'summary', 'rationale'], properties: {
  path: { type: 'string' }, summary: { type: 'string' }, rationale: { type: 'string' } } };
await phase('fan out');
const raw = await parallel(Array.from({ length: n }, (_, i) => () => agent(
  'Task: ' + args.task + '\\n\\nYou are one of ' + n + ' candidates doing this task independently. ' +
  copy(root + '/candidate-' + (i + 1)) + ' Produce the complete artifact there, then report its path, ' +
  'a short summary, and a rationale naming the alternatives you considered and why you rejected them.',
  { label: 'candidate ' + (i + 1), schema: reportSchema, ...seat(i) }
)));
const all = raw.map((text, i) => ({ candidate: i + 1, ...seat(i), ...(json(text) || {}) }));
const ok = all.filter((c) => typeof c.path === 'string' && c.path);
const dropped = all.filter((c) => !ok.includes(c)).map((c) => c.candidate);
if (ok.length === 0) return { error: 'every candidate failed', dropped };
const describe = (c) => 'Candidate ' + c.candidate + ' at ' + c.path + '\\nSummary: ' + c.summary +
  '\\nRationale: ' + c.rationale;
let base = ok[0];
let judge = null;
if (ok.length > 1) {
  await phase('judge');
  const rubric = String(args.rubric || '').trim();
  judge = json(await agent(
    'Task the candidates were given: ' + args.task + '\\n\\n' +
    (rubric ? 'Rubric:\\n' + rubric : 'First derive 3-6 concrete, gradeable criteria for success on this task.') +
    '\\n\\n' + ok.map(describe).join('\\n\\n') + '\\n\\nRead every candidate end to end ' +
    '(git -C <path> diff HEAD, then the files). Score each criterion per candidate, not on overall feel. ' +
    'Recommend as base the candidate a future maintainer can extend most easily without breaking invariants; ' +
    'on a tie prefer the cleaner boundary or smaller API. Do not edit any file.',
    { label: 'judge', schema: { type: 'object', required: ['base', 'reason'], properties: {
      base: { type: 'integer' }, scores: { type: 'string' }, reason: { type: 'string' } } }, ...seat(n) }
  ));
  base = ok.find((c) => judge && c.candidate === judge.base) || base;
}
const others = ok.filter((c) => c !== base);
let synthesis = null;
if (others.length > 0) {
  await phase('graft');
  synthesis = await agent(
    'Task: ' + args.task + '\\n\\nThe arena picked candidate ' + base.candidate + ' at ' + base.path +
    ' as the base' + (judge && judge.reason ? ' because: ' + judge.reason : '') + '.\\n\\nOther candidates:\\n\\n' +
    others.map(describe).join('\\n\\n') + '\\n\\nWork in the base copy only. Walk each other candidate once ' +
    'for the one or two parts worth porting and fold each in by hand so the result stays coherent under one ' +
    'design; do not paste mechanically. If the candidates converge on one shape, say so and graft nothing. ' +
    'Then prove the result works with the checks that fit and include each command with its output. Report ' +
    'the base path, each graft with its source candidate, what you rejected and why, and the verification ' +
    'result. Never edit the main working tree.',
    { label: 'graft', ...seat(base.candidate - 1) }
  );
}
return { task: args.task, base: base.candidate, path: base.path, judge, candidates: ok, dropped, synthesis,
  note: 'Candidate copies stay under ' + root + '; remove them with git worktree remove once applied.' };
`,
  interrogate: `/*---
name: Interrogate
description: Adversaries try to break a change in their own worktrees; only findings a verifier reproduces by rerunning the command survive. Reports, never fixes.
args:
  - key: target
    label: Scope
    default: the branch diff from its merge base with the default branch, plus uncommitted changes
  - key: intent
    label: Intent of the change (derived when empty)
    default: ""
  - key: adversaries
    label: Number of adversaries (1-6)
    default: "2"
  - key: models
    label: Adversary models (comma separated, rotated)
    default: ""
---*/
const list = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const json = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };
const models = list(args.models);
const n = Math.min(6, Math.max(1, parseInt(args.adversaries, 10) || models.length || 2));
const seat = (i) => (models.length ? { model: models[i % models.length] } : {});
const root = '/tmp/interrogate-' + Date.now().toString(36);
const scope = 'Scope: ' + args.target;
let intent = String(args.intent || '').trim();
if (!intent) {
  await phase('frame');
  intent = String(await agent(
    scope + '\\n\\nRestate in your own words what this change is meant to do and which behavior it must keep, ' +
    'from the diff, the commit messages and any PR description. Do not edit any file. Answer in under 150 words.',
    { label: 'intent', ...seat(0) }
  ) || '').trim();
  if (!intent) return { error: 'could not establish the intent of the change' };
}
const str = { type: 'string' };
const claimSchema = { type: 'object', required: ['worktree', 'findings'], properties: {
  worktree: str,
  findings: { type: 'array', items: { type: 'object', required: ['title', 'command', 'output', 'expected'],
    properties: { title: str, command: str, output: str, expected: str } } } } };
await phase('attack');
const raw = await parallel(Array.from({ length: n }, (_, i) => () => {
  const path = root + '/adversary-' + (i + 1);
  return agent(
    scope + '\\nIntent: ' + intent + '\\n\\nBreak this change. Work only in your own copy at ' + path +
    ': in a git repo create it with \\\`git worktree add --detach ' + path + ' HEAD\\\`, carry over uncommitted ' +
    'changes with \\\`git diff HEAD --binary | git -C ' + path + ' apply\\\`, and copy untracked files in scope. ' +
    'Never edit the main working tree. Prove each finding with a run against the real code, such as a failing ' +
    'test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a ' +
    'prototype or probe the current tree. Keep repros in your copy and leave it in place. Report the copy path ' +
    'as worktree, and each finding with a title, the exact command run from the worktree root, the output it ' +
    'printed, and the output the intent requires. Leave out anything you did not run: style, naming, structure, ' +
    'and risks that need a future change to matter. An empty findings list is a valid result.',
    { label: 'adversary ' + (i + 1), schema: claimSchema, ...seat(i) }
  );
}));
const reports = raw.map((text, i) => ({ adversary: i + 1, ...(json(text) || {}) }));
const failed = reports.filter((r) => !Array.isArray(r.findings)).map((r) => r.adversary);
const claimed = reports.filter((r) => Array.isArray(r.findings) && r.findings.length > 0);
if (claimed.length === 0) return { intent, findings: [], failed, note: 'no verified findings' };
await phase('verify');
const verdict = json(await agent(
  'Intent: ' + intent + '\\n\\nAdversaries claim these findings against the change; each lists the copy it ran in:\\n' +
  JSON.stringify(claimed, null, 2) + '\\n\\nFor each finding, rerun its exact command from its worktree. Keep a ' +
  'finding only when the output you get shows the failure and that failure breaks the intent; drop the rest. ' +
  'Merge kept findings that share a root cause and list every adversary that found them. For each adversary, ' +
  'count what you dropped and why. Do not fix anything and do not edit files outside those copies.',
  { label: 'verify', schema: { type: 'object', required: ['findings', 'dropped'], properties: {
    findings: { type: 'array', items: { type: 'object', required: ['title', 'command', 'output', 'breaks', 'foundBy'],
      properties: { title: str, command: str, output: str, breaks: str, foundBy: { type: 'array', items: { type: 'integer' } } } } },
    dropped: { type: 'array', items: { type: 'object', required: ['adversary', 'count', 'reason'],
      properties: { adversary: { type: 'integer' }, count: { type: 'integer' }, reason: str } } } } }, ...seat(n) }
));
if (!verdict) return { intent, error: 'verification failed', unverified: claimed, failed };
return { intent, findings: verdict.findings, dropped: verdict.dropped, failed,
  note: 'Adversary copies stay under ' + root + '; remove them with git worktree remove when done.' };
`,
};

let builtinCache: WorkflowPreset[] | undefined;

function builtinPresets(): WorkflowPreset[] {
  builtinCache ??= Object.entries(BUILTIN_SOURCES)
    .map(([id, raw]) => parseWorkflowPreset(id, 'builtin', raw))
    .filter((preset): preset is WorkflowPreset => preset !== null);
  return builtinCache;
}
