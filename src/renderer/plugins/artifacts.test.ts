import { describe, expect, it } from 'vitest';
import { artifactPreviewKind } from './artifacts';

describe('产出文件预览', () => {
  it('按 mime 决定预览方式', () => {
    expect(artifactPreviewKind('text/plain')).toBe('text');
    expect(artifactPreviewKind('application/json')).toBe('text');
    expect(artifactPreviewKind('image/png')).toBe('image');
    expect(artifactPreviewKind('image/svg+xml')).toBe('image');
    expect(artifactPreviewKind('application/pdf')).toBe('file');
  });
});
