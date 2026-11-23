import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectSettingsManager } from './projectCode';
import { listProjectCodeSources } from './projectCodeSources';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enso-project-code-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** 项目里放一个加载即写标记文件的扩展、一个技能和带包/npm 命令的 settings */
function hostileProject() {
  const cwd = tmp();
  const agentDir = tmp();
  const extMarker = join(tmp(), 'ext-loaded');
  const npmMarker = join(tmp(), 'npm-ran');
  write(
    join(cwd, '.pi/extensions/evil.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(extMarker)}, 'x');\nexport default function () {}\n`
  );
  write(
    join(cwd, '.pi/skills/demo/SKILL.md'),
    '---\nname: demo\ndescription: Demo skill for tests\n---\nBody\n'
  );
  write(
    join(cwd, '.agents/skills/shared/SKILL.md'),
    '---\nname: shared\ndescription: Shared\n---\n'
  );
  return { cwd, agentDir, extMarker, npmMarker };
}

function withPackages(cwd: string, npmMarker: string): void {
  write(
    join(cwd, '.pi/settings.json'),
    JSON.stringify({
      enableSkillCommands: true,
      packages: ['npm:@enso-test/definitely-missing-package'],
      extensions: ['./tools/extra.ts'],
      npmCommand: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(npmMarker)}, 'x')`],
    })
  );
}

async function load(cwd: string, agentDir: string, trusted: string[]) {
  const { settingsManager, blocked } = createProjectSettingsManager(cwd, agentDir, trusted);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noThemes: true });
  await loader.reload();
  return { loader, blocked };
}

describe('listProjectCodeSources', () => {
  it('没有 .pi 时没有代码来源', () => {
    expect(listProjectCodeSources(tmp())).toEqual([]);
  });

  it('列出项目扩展、包、扩展路径与可执行命令设置', () => {
    const { cwd, npmMarker } = hostileProject();
    withPackages(cwd, npmMarker);
    write(join(cwd, '.pi/extensions/.hidden.ts'), '');
    expect(listProjectCodeSources(cwd)).toEqual([
      '.pi/extensions/evil.ts',
      'extension:./tools/extra.ts',
      'package:npm:@enso-test/definitely-missing-package',
      'setting:npmCommand',
    ]);
  });

  it('坏的 settings.json 不抛错', () => {
    const cwd = tmp();
    write(join(cwd, '.pi/settings.json'), '{oops');
    expect(listProjectCodeSources(cwd)).toEqual([]);
  });
});

describe('createProjectSettingsManager', () => {
  it('未信任时不加载项目扩展、不装项目包，但项目技能照常加载', async () => {
    const { cwd, agentDir, extMarker, npmMarker } = hostileProject();
    withPackages(cwd, npmMarker);
    const { loader, blocked } = await load(cwd, agentDir, []);
    expect(blocked).toContain('.pi/extensions/evil.ts');
    expect(existsSync(extMarker)).toBe(false);
    expect(existsSync(npmMarker)).toBe(false);
    expect(loader.getExtensions().extensions).toHaveLength(0);
    const names = loader.getSkills().skills.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining(['demo', 'shared']));
  });

  it('来源全部已信任时照常加载项目扩展', async () => {
    const { cwd, agentDir, extMarker } = hostileProject();
    const { loader, blocked } = await load(cwd, agentDir, ['.pi/extensions/evil.ts']);
    expect(blocked).toEqual([]);
    expect(existsSync(extMarker)).toBe(true);
    expect(loader.getExtensions().extensions).toHaveLength(1);
  });

  it('信任后新增的来源会让整个项目重新被拦下', async () => {
    const { cwd, agentDir, extMarker } = hostileProject();
    write(join(cwd, '.pi/extensions/second.ts'), 'export default function () {}\n');
    const { loader, blocked } = await load(cwd, agentDir, ['.pi/extensions/evil.ts']);
    expect(blocked).toEqual(['.pi/extensions/second.ts']);
    expect(existsSync(extMarker)).toBe(false);
    expect(loader.getExtensions().extensions).toHaveLength(0);
  });

  it('没有项目代码时与默认行为一致', async () => {
    const cwd = tmp();
    write(join(cwd, '.pi/settings.json'), JSON.stringify({ enableSkillCommands: false }));
    const { settingsManager, blocked } = createProjectSettingsManager(cwd, tmp(), []);
    expect(blocked).toEqual([]);
    expect(settingsManager.getEnableSkillCommands()).toBe(false);
  });
});
