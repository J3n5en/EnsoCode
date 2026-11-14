import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarColorField } from './AvatarColorField';
import { avatarColorSelection, secretaryAvatarUploadError } from './avatarColor';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe('avatarColorSelection', () => {
  it('非预设色选中自定义入口，预设色只选中对应色块', () => {
    expect(avatarColorSelection('#FF00AA')).toEqual({ preset: null, customSelected: true });
    expect(avatarColorSelection('#7C5CFF')).toEqual({ preset: '#7c5cff', customSelected: false });
    expect(avatarColorSelection('red')).toEqual({ preset: null, customSelected: false });
  });

  it('只接受 png、jpeg、webp、gif，并限制大小', () => {
    expect(secretaryAvatarUploadError({ type: '', name: 'face.gif', size: 20 }, 100)).toBeNull();
    expect(
      secretaryAvatarUploadError({ type: 'image/webp', name: 'a.bin', size: 20 }, 100)
    ).toBeNull();
    expect(secretaryAvatarUploadError({ type: 'image/png', name: 'a.png', size: 101 }, 100)).toBe(
      'size'
    );
    expect(secretaryAvatarUploadError({ type: 'text/plain', name: 'a.txt', size: 20 }, 100)).toBe(
      'type'
    );
  });
});

describe('AvatarColorField', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('非预设色显示在自定义入口上并标成选中', async () => {
    await act(async () => {
      root.render(<AvatarColorField color="#ff00aa" onChange={() => undefined} />);
    });
    const custom = container.querySelector('[data-enso="secretary-form-avatar-custom"]');
    expect(custom?.getAttribute('data-selected')).toBe('true');
    expect((custom as HTMLElement).style.backgroundColor).toBe('#ff00aa');
    expect(
      [...container.querySelectorAll('[data-enso="secretary-form-avatar"] > button')].some(
        (button) => button.getAttribute('aria-pressed') === 'true'
      )
    ).toBe(false);
    expect(
      (container.querySelector('[data-enso="secretary-form-avatar-hex"]') as HTMLInputElement)
        ?.value
    ).toBe('#ff00aa');
  });

  it('预设色标在对应色块上，自定义入口不选中', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<AvatarColorField color="#7C5CFF" onChange={onChange} />);
    });
    const custom = container.querySelector('[data-enso="secretary-form-avatar-custom"]');
    expect(custom?.getAttribute('data-selected')).toBe('false');
    expect(container.querySelector('[aria-label="#7c5cff"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    );
    act(() => {
      (container.querySelector('[aria-label="#c2553f"]') as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith('#c2553f');
  });
});
