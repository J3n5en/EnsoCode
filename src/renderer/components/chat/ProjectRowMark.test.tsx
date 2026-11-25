import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROW_ICON_SIZE, ProjectRowMark } from './ProjectRowMark';

const html = (folded: boolean) =>
  renderToStaticMarkup(
    createElement(ProjectRowMark, { projectId: 'p1', displayName: 'Alpha', folded })
  );

describe('ProjectRowMark', () => {
  it('头像顶到行首，箭头只在悬停时盖上来，折叠时不带 data-expanded', () => {
    const markup = html(true);
    expect(PROJECT_ROW_ICON_SIZE).toBe(20);
    expect(markup).toContain('data-enso="project-icon"');
    expect(markup).toContain('width:20px');
    expect(markup).toContain('data-enso="tree-chevron"');
    expect(markup).not.toContain('data-expanded');
    expect(markup).toContain('group-hover:flex');
    expect(markup).toContain('hidden');
    expect(markup).not.toContain('size-4');
  });

  it('展开时箭头带 data-expanded，并旋转', () => {
    const markup = html(false);
    expect(markup).toContain('data-expanded="true"');
    expect(markup).toContain('rotate-90');
  });
});
