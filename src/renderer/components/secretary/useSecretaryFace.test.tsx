import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  secretary: {
    secretaryId: 's-248c5247' as string | null,
    enabled: true,
    profile: { name: 'Ken', avatar: { color: '#654321', imageVersion: 5, imageHash: 'bbbb' } },
  },
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => undefined }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => undefined }));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: unknown) => unknown) =>
    select({ secretary: harness.secretary }),
}));

const { useSecretaryFace } = await import('./useSecretaryFace');

function Probe() {
  return createElement('i', { 'data-src': useSecretaryFace()?.image ?? '' });
}

const image = () => /data-src="([^"]*)"/u.exec(renderToStaticMarkup(createElement(Probe)))?.[1];

describe('useSecretaryFace', () => {
  it('头像地址带上这张脸所属秘书的 s=，多秘书时 Main 才认得出', () => {
    expect(image()).toBe(
      'local-image://secretary-avatar/avatar.png?v=5&amp;h=bbbb&amp;s=s-248c5247'
    );
  });

  it('状态没有秘书 id 时不带 s=，单秘书时 Main 接受省略', () => {
    harness.secretary.secretaryId = null;
    expect(image()).toBe('local-image://secretary-avatar/avatar.png?v=5&amp;h=bbbb');
  });
});
