import { describe, expect, it } from 'vitest';
import { catalogHiddenProjectIds, catalogListedProject } from './pairCatalogVisibility';

const projects = [
  { id: 'local', kind: 'local' },
  { id: 'scratch', kind: 'scratch' },
  { id: 'secretary', kind: 'secretary' },
];

describe('pairCatalog 可见性', () => {
  it('秘书项目不作为可选项目下发，临时会话也不', () => {
    expect(catalogListedProject('secretary')).toBe(false);
    expect(catalogListedProject('scratch')).toBe(false);
    expect(catalogListedProject('local')).toBe(true);
    expect(catalogListedProject(undefined)).toBe(true);
  });

  it('秘书项目的会话始终不进手机目录，临时会话只受开关控制', () => {
    expect([...catalogHiddenProjectIds(projects, false)]).toEqual(['scratch', 'secretary']);
    expect([...catalogHiddenProjectIds(projects, true)]).toEqual(['secretary']);
  });
});
