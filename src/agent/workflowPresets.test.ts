import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWorkflowScript } from '@shared/workflowDesign';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCustomWorkflowPreset,
  listBuiltinWorkflowPresets,
  listCustomWorkflowPresets,
  listWorkflowPresets,
  loadWorkflowPreset,
  parseWorkflowPreset,
  parseWorkflowPresetDraft,
  readCustomWorkflowPreset,
  resolveWorkflowPresetArgs,
  saveCustomWorkflowPreset,
  workflowPresetRoots,
} from './workflowPresets';

const preset = (name: string, extra = '') =>
  `/*---\nname: ${name}\ndescription: ${name} description\n${extra}---*/\nreturn args;\n`;

let tmp: string;
let cwd: string;
let home: string;
let customDir: string;

function write(root: string, file: string, content: string): void {
  const dir = path.join(root, '.agents', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-workflow-presets-'));
  cwd = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  customDir = path.join(tmp, 'userData', 'agent', 'workflows');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseWorkflowPreset', () => {
  it('读取注释头的元数据和参数，整份文件作为脚本', () => {
    const raw = preset(
      'Review',
      'args:\n  - key: target\n    label: Target\n    default: HEAD\n  - key: focus\n    label: Focus\n    required: true\n'
    );
    expect(parseWorkflowPreset('review', 'project', raw)).toEqual({
      id: 'review',
      source: 'project',
      name: 'Review',
      description: 'Review description',
      args: [
        { key: 'target', label: 'Target', default: 'HEAD' },
        { key: 'focus', label: 'Focus', required: true },
      ],
      script: raw,
    });
  });

  it('缺注释头、缺描述、坏参数名或空脚本都拒绝', () => {
    expect(parseWorkflowPreset('a', 'global', 'return 1;')).toBeNull();
    expect(parseWorkflowPreset('a', 'global', '/*---\nname: A\n---*/\nreturn 1;')).toBeNull();
    expect(
      parseWorkflowPreset('a', 'global', preset('A', 'args:\n  - key: "bad key"\n    label: X\n'))
    ).toBeNull();
    expect(
      parseWorkflowPreset('a', 'global', preset('A', 'args:\n  - key: x\n  - key: x\n'))
    ).toBeNull();
    expect(
      parseWorkflowPreset('a', 'global', '/*---\nname: A\ndescription: d\n---*/\n')
    ).toBeNull();
  });
});

describe('listWorkflowPresets', () => {
  it('项目 > 设置 > 全局 > 内置按 id 去重，坏文件和非法文件名不阻断其它预设', () => {
    write(cwd, 'shared.js', preset('Project shared'));
    write(home, 'shared.js', preset('Global shared'));
    write(home, 'global-only.js', preset('Global only'));
    write(cwd, 'broken.js', 'no header');
    write(cwd, 'Bad Name.js', preset('Bad'));
    write(cwd, 'notes.md', preset('Markdown'));
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'shared.js'), preset('Custom shared'));
    fs.writeFileSync(path.join(customDir, 'global-only.js'), preset('Custom over global'));
    const list = listWorkflowPresets(workflowPresetRoots(cwd, { customDir, home }));
    const byId = new Map(list.map((item) => [item.id, item]));
    expect(byId.get('shared')).toMatchObject({ name: 'Project shared', source: 'project' });
    expect(byId.get('global-only')).toMatchObject({ name: 'Custom over global', source: 'custom' });
    expect(byId.has('broken')).toBe(false);
    expect(byId.has('notes')).toBe(false);
    expect([...byId.keys()].some((id) => id.includes(' '))).toBe(false);
    expect(list.some((item) => item.source === 'builtin')).toBe(true);
    expect(list.every((item) => !('script' in item))).toBe(true);
  });

  it('远程会话没有本地项目根时只列全局和内置', () => {
    write(home, 'g.js', preset('G'));
    expect(workflowPresetRoots(undefined, { home }).map((root) => root.source)).toEqual(['global']);
    expect(workflowPresetRoots(undefined, { customDir, home }).map((r) => r.source)).toEqual([
      'custom',
      'global',
    ]);
    const sources = new Set(
      listWorkflowPresets(workflowPresetRoots(undefined, { home })).map((p) => p.source)
    );
    expect(sources.has('project')).toBe(false);
  });

  it('插件预设只认清单列出的文件，排在全局之后、内置之前', () => {
    const pluginDir = path.join(tmp, 'plugin', 'workflows');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'triage.js'), preset('Plugin triage'));
    fs.writeFileSync(path.join(pluginDir, 'unlisted.js'), preset('Unlisted'));
    fs.writeFileSync(path.join(pluginDir, 'shared.js'), preset('Plugin shared'));
    write(home, 'shared.js', preset('Global shared'));
    const pluginFiles = [path.join(pluginDir, 'triage.js'), path.join(pluginDir, 'shared.js')];
    const roots = workflowPresetRoots(undefined, { home, pluginFiles });
    expect(roots.map((root) => root.source)).toEqual(['global', 'plugin']);
    const byId = new Map(listWorkflowPresets(roots).map((item) => [item.id, item]));
    expect(byId.get('triage')).toMatchObject({ name: 'Plugin triage', source: 'plugin' });
    expect(byId.get('shared')).toMatchObject({ source: 'global' });
    expect(byId.has('unlisted')).toBe(false);
    expect(loadWorkflowPreset('unlisted', roots)).toBeNull();
    expect(loadWorkflowPreset('triage', roots)?.name).toBe('Plugin triage');
  });

  it('内置预设全部可解析', () => {
    const builtin = listWorkflowPresets([]).filter((item) => item.source === 'builtin');
    expect(builtin.length).toBeGreaterThan(0);
    for (const item of builtin) expect(loadWorkflowPreset(item.id, [])?.script).toBeTruthy();
  });

  it('禁用的内置预设不列出也不能加载，同 id 的项目预设不受影响', () => {
    const [first, second] = listBuiltinWorkflowPresets();
    expect(first?.source).toBe('builtin');
    const disabled = [first?.id ?? ''];
    const ids = listWorkflowPresets([], disabled).map((item) => item.id);
    expect(ids).not.toContain(first?.id);
    expect(ids).toContain(second?.id);
    expect(loadWorkflowPreset(first?.id ?? '', [], disabled)).toBeNull();
    write(cwd, `${first?.id}.js`, preset('Project override'));
    const roots = workflowPresetRoots(cwd, { home });
    expect(loadWorkflowPreset(first?.id ?? '', roots, disabled)?.name).toBe('Project override');
    expect(listWorkflowPresets(roots, disabled).find((item) => item.id === first?.id)?.source).toBe(
      'project'
    );
  });
});

describe('loadWorkflowPreset', () => {
  it('按优先级加载，非法 id 不触碰文件系统路径', () => {
    write(home, 'x.js', preset('Global x'));
    write(cwd, 'x.js', preset('Project x'));
    const roots = workflowPresetRoots(cwd, { home });
    expect(loadWorkflowPreset('x', roots)?.name).toBe('Project x');
    fs.writeFileSync(path.join(tmp, 'escape.js'), preset('Escape'));
    expect(loadWorkflowPreset('../../escape', roots)).toBeNull();
    expect(loadWorkflowPreset('missing', roots)).toBeNull();
  });
});

describe('resolveWorkflowPresetArgs', () => {
  const parsed = parseWorkflowPreset(
    'p',
    'builtin',
    preset(
      'P',
      'args:\n  - key: target\n    label: T\n    default: HEAD\n  - key: focus\n    label: F\n    required: true\n'
    )
  );
  if (!parsed) throw new Error('fixture must parse');

  it('补默认值，显式值优先，额外键原样保留', () => {
    expect(resolveWorkflowPresetArgs(parsed, { focus: 'perf', extra: 1 })).toEqual({
      ok: true,
      args: { target: 'HEAD', focus: 'perf', extra: 1 },
    });
    expect(resolveWorkflowPresetArgs(parsed, { focus: 'x', target: 'main' })).toMatchObject({
      ok: true,
      args: { target: 'main' },
    });
  });

  it('必填参数缺失或为空白时拒绝', () => {
    expect(resolveWorkflowPresetArgs(parsed, {}).ok).toBe(false);
    expect(resolveWorkflowPresetArgs(parsed, { focus: '  ' }).ok).toBe(false);
  });
});

const draft = (overrides: Record<string, unknown> = {}) => ({
  name: 'Release check',
  description: 'Check release notes: "quotes" and #hash',
  args: [
    { key: 'version', label: 'Version', required: true },
    { key: 'scope', label: 'Scope', default: 'all packages' },
  ],
  script: 'await log(args.version);\nreturn { ok: true };',
  ...overrides,
});

describe('parseWorkflowPresetDraft', () => {
  it('收窄 IPC 入参：只保留声明字段', () => {
    expect(parseWorkflowPresetDraft({ ...draft(), extra: 1 })).toEqual(draft());
  });

  it('坏形状、缺名称、空脚本、坏参数和注释终止符都拒绝', () => {
    expect(parseWorkflowPresetDraft(null)).toBeNull();
    expect(parseWorkflowPresetDraft('x')).toBeNull();
    expect(parseWorkflowPresetDraft(draft({ name: '  ' }))).toBeNull();
    expect(parseWorkflowPresetDraft(draft({ script: ' \n ' }))).toBeNull();
    expect(parseWorkflowPresetDraft(draft({ args: [{ key: 'bad key', label: 'x' }] }))).toBeNull();
    expect(parseWorkflowPresetDraft(draft({ args: 'x' }))).toBeNull();
    expect(parseWorkflowPresetDraft(draft({ description: 'ends */ here' }))).toBeNull();
    expect(
      parseWorkflowPresetDraft(draft({ args: [{ key: 'a', label: 'A', default: '*/' }] }))
    ).toBeNull();
  });
});

describe('custom workflow presets', () => {
  const design = {
    phases: [
      {
        title: 'Check',
        steps: [{ label: 'notes', agentType: 'scout', prompt: 'Check {{args.version}}\nnotes' }],
      },
    ],
  };

  it('带设计的草稿：脚本由设计重新生成，读回时设计与脚本一致', () => {
    const parsed = parseWorkflowPresetDraft(draft({ design, script: 'tampered' }));
    expect(parsed?.script).toBe(generateWorkflowScript(design));
    expect(parseWorkflowPresetDraft(draft({ design: { phases: [] } }))).toBeNull();
    const withEnd = {
      phases: [{ title: 'a', steps: [{ label: 'b', agentType: '', prompt: '*/' }] }],
    };
    expect(parseWorkflowPresetDraft(draft({ design: withEnd }))).toBeNull();

    const saved = saveCustomWorkflowPreset(customDir, parsed!);
    expect(saved.ok).toBe(true);
    expect(readCustomWorkflowPreset(customDir, 'release-check')).toEqual({
      id: 'release-check',
      ...draft({ design, script: generateWorkflowScript(design) }),
    });
    expect(
      loadWorkflowPreset('release-check', [{ dir: customDir, source: 'custom' }])?.script
    ).toContain(generateWorkflowScript(design));
  });

  it('脚本被手改（与设计不一致）时读回为纯代码预设', () => {
    saveCustomWorkflowPreset(customDir, parseWorkflowPresetDraft(draft({ design }))!);
    const file = path.join(customDir, 'release-check.js');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}// edited\n`);
    const read = readCustomWorkflowPreset(customDir, 'release-check');
    expect(read).not.toHaveProperty('design');
    expect(read?.script.endsWith('// edited\n')).toBe(true);
  });

  it('新建按名称生成 id，写成可解析、可执行的预设文件', () => {
    const saved = saveCustomWorkflowPreset(customDir, draft());
    expect(saved).toEqual({ ok: true, id: 'release-check' });
    const loaded = loadWorkflowPreset('release-check', [{ dir: customDir, source: 'custom' }]);
    expect(loaded).toMatchObject({
      source: 'custom',
      name: 'Release check',
      description: 'Check release notes: "quotes" and #hash',
      args: draft().args,
    });
    expect(loaded?.script.endsWith(draft().script)).toBe(true);
    expect(readCustomWorkflowPreset(customDir, 'release-check')).toEqual({
      id: 'release-check',
      ...draft(),
    });
  });

  it('id 冲突时加后缀，避开内置 id，非 ASCII 名称有兜底 id', () => {
    expect(saveCustomWorkflowPreset(customDir, draft())).toEqual({ ok: true, id: 'release-check' });
    expect(saveCustomWorkflowPreset(customDir, draft())).toEqual({
      ok: true,
      id: 'release-check-2',
    });
    expect(saveCustomWorkflowPreset(customDir, draft({ name: 'Parallel review' }))).toEqual({
      ok: true,
      id: 'parallel-review-2',
    });
    const cjk = saveCustomWorkflowPreset(customDir, draft({ name: '发布检查' }));
    expect(cjk.ok && /^workflow(-\d+)?$/.test(cjk.id)).toBe(true);
    expect(listCustomWorkflowPresets(customDir).map((item) => item.id)).toHaveLength(4);
  });

  it('按 id 编辑原文件，不存在或非法 id 拒绝', () => {
    saveCustomWorkflowPreset(customDir, draft());
    expect(
      saveCustomWorkflowPreset(customDir, draft({ name: 'Renamed' }), 'release-check')
    ).toEqual({ ok: true, id: 'release-check' });
    expect(readCustomWorkflowPreset(customDir, 'release-check')?.name).toBe('Renamed');
    expect(saveCustomWorkflowPreset(customDir, draft(), 'missing').ok).toBe(false);
    expect(saveCustomWorkflowPreset(customDir, draft(), '../escape').ok).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'userData', 'agent', 'escape.js'))).toBe(false);
  });

  it('超出大小上限拒绝保存', () => {
    const result = saveCustomWorkflowPreset(customDir, draft({ script: 'x'.repeat(70 * 1024) }));
    expect(result.ok).toBe(false);
    expect(listCustomWorkflowPresets(customDir)).toEqual([]);
  });

  it('列表只含设置来源，删除移除文件，非法 id 不触碰文件系统', () => {
    saveCustomWorkflowPreset(customDir, draft());
    fs.writeFileSync(path.join(customDir, 'broken.js'), 'no header');
    expect(listCustomWorkflowPresets(customDir)).toEqual([
      {
        id: 'release-check',
        source: 'custom',
        name: 'Release check',
        description: draft().description,
        args: draft().args,
      },
    ]);
    expect(listCustomWorkflowPresets(path.join(tmp, 'nope'))).toEqual([]);
    expect(deleteCustomWorkflowPreset(customDir, '../project')).toBe(false);
    expect(fs.existsSync(cwd)).toBe(true);
    expect(deleteCustomWorkflowPreset(customDir, 'release-check')).toBe(true);
    expect(readCustomWorkflowPreset(customDir, 'release-check')).toBeNull();
  });
});
