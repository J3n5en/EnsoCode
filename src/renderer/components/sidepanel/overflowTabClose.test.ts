import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { overflowTabList, removeOverflowRows, snapshotOverflowRows } from './overflowTabClose';

function popup() {
  const { document } = parseHTML(`<!doctype html><body>
    <div class="dv-popover-anchor">
      <div id="popover">
        <div class="dv-tabs-overflow-container">
          <div class="dv-tab"><div data-panel-id="a"><button id="close-a"></button></div></div>
          <div class="dv-tab"><div data-panel-id="b"><button id="close-b"></button></div></div>
        </div>
      </div>
    </div>
    <div class="dv-tabs-container">
      <div class="dv-tab"><div data-panel-id="header"><button id="close-header"></button></div></div>
    </div>
  </body>`);
  return document;
}

describe('removeOverflowRows', () => {
  it('drops only the closed row and leaves the popup open', () => {
    const document = popup();
    const button = document.getElementById('close-a');
    if (!button) throw new Error('missing button');
    const list = overflowTabList(button);
    if (!list) throw new Error('missing list');
    const row = snapshotOverflowRows(list).get('a');
    if (!row) throw new Error('missing row');

    removeOverflowRows(list, [row]);

    expect(list.querySelector('[data-panel-id="a"]')).toBeNull();
    expect(list.querySelector('[data-panel-id="b"]')).not.toBeNull();
    expect(document.getElementById('popover')).not.toBeNull();
  });

  it('dismisses the popup when the last overflow tab is closed', () => {
    const document = popup();
    const button = document.getElementById('close-b');
    if (!button) throw new Error('missing button');
    const list = overflowTabList(button);
    if (!list) throw new Error('missing list');
    const rows = snapshotOverflowRows(list);

    removeOverflowRows(
      list,
      [rows.get('a'), rows.get('b')].filter((row) => row !== undefined)
    );

    expect(document.querySelector('.dv-tabs-overflow-container')).toBeNull();
    expect(document.querySelector('.dv-popover-anchor')).not.toBeNull();
    expect(document.getElementById('popover')).toBeNull();
  });

  it('does not treat a header-strip tab as an overflow row', () => {
    const document = popup();
    const button = document.getElementById('close-header');
    if (!button) throw new Error('missing button');

    expect(overflowTabList(button)).toBeNull();
    expect(document.querySelector('[data-panel-id="header"]')).not.toBeNull();
  });
});
