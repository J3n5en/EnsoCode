import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListFilterBar } from './ListFilterBar';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/input', () => ({
  Input: ({
    ref,
    unstyled: _unstyled,
    ...props
  }: ComponentProps<'input'> & { unstyled?: boolean }) => <input ref={ref} {...props} />,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ListFilterBar', () => {
  it('clears non-empty query on Escape without bubbling, but lets Escape bubble when empty', async () => {
    const parentKeyDown = vi.fn();
    const onQueryChange = vi.fn();

    await act(async () =>
      root.render(
        <div onKeyDown={parentKeyDown}>
          <ListFilterBar query="mcp" onQueryChange={onQueryChange} placeholder="Filter..." />
        </div>
      )
    );

    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(
        Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' })
      );
    });
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(parentKeyDown).not.toHaveBeenCalled();

    onQueryChange.mockClear();
    await act(async () =>
      root.render(
        <div onKeyDown={parentKeyDown}>
          <ListFilterBar query="" onQueryChange={onQueryChange} placeholder="Filter..." />
        </div>
      )
    );

    const emptyInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      emptyInput.dispatchEvent(
        Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' })
      );
    });
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  it('shows trailing clear button only when non-empty and focuses input on clear', async () => {
    const onQueryChange = vi.fn();
    await act(async () =>
      root.render(<ListFilterBar query="" onQueryChange={onQueryChange} placeholder="Filter..." />)
    );
    expect(container.querySelector('button[aria-label="Clear filter"]')).toBeNull();

    await act(async () =>
      root.render(
        <ListFilterBar query="foo" onQueryChange={onQueryChange} placeholder="Filter..." />
      )
    );
    const clearButton = container.querySelector(
      'button[aria-label="Clear filter"]'
    ) as HTMLButtonElement | null;
    expect(clearButton).not.toBeNull();

    const input = container.querySelector('input') as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    await act(async () => {
      clearButton?.click();
    });
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(focusSpy).toHaveBeenCalled();
  });
});
