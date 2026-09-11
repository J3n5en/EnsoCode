// 先启动隔离 pnpm dev（CDP 9222），再运行本脚本；验证真实 Chromium 编辑历史。
import assert from 'node:assert/strict';

const port = process.env.ENSO_CDP_PORT || '9222';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
assert.ok(page, 'EnsoCode main window not found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result));
  return response.result.result.value;
};
const editCommand = async (command) => {
  const modifiers = command === 'Redo' ? 12 : 4;
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'z',
      code: 'KeyZ',
      modifiers,
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
      ...(type === 'rawKeyDown' ? { commands: [command] } : {}),
    });
  }
};
const mount = async () => {
  await evaluate(`(async () => {
    window.__pasteUndoRoot?.unmount();
    document.querySelector('#paste-undo-test-host')?.remove();
    let resources;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      resources = performance.getEntriesByType('resource').map(entry => entry.name);
      if (resources.some(url => url.includes('/react.js?')) && resources.some(url => url.includes('/react-dom_client.js?'))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const { default: React } = await import(resources.find(url => url.includes('/react.js?')));
    const { default: ReactDOM } = await import(resources.find(url => url.includes('/react-dom_client.js?')));
    const { MentionEditor } = await import('/components/chat/MentionEditor.tsx');
    const host = document.createElement('div');
    host.id = 'paste-undo-test-host';
    document.body.append(host);
    window.__pasteUndoRoot = ReactDOM.createRoot(host);
    window.__pasteUndoState = undefined;
    window.__pasteUndoFiles = 0;
    window.__pasteUndoRoot.render(React.createElement(MentionEditor, {
      placeholder: 'paste test',
      onStateChange: state => { window.__pasteUndoState = state; },
      onKeyDown: () => {},
      onPaste: event => { window.__pasteUndoFiles = event.clipboardData.files.length; event.preventDefault(); },
      onCompositionStart: () => {}, onCompositionEnd: () => {},
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    host.querySelector('[contenteditable]').focus();
  })()`);
};
const text = () =>
  evaluate(`document.querySelector('#paste-undo-test-host [contenteditable]').innerText`);
const stateText = () => evaluate(`window.__pasteUndoState?.plainText`);
const pasteText = (value) =>
  evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(value)});
    document.querySelector('#paste-undo-test-host [contenteditable]').dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    );
  })()`);

await send('Runtime.enable');
try {
  await mount();
  await send('Input.insertText', { text: 'before' });
  await pasteText(' pasted');
  assert.equal(await text(), 'before pasted');
  assert.equal(await stateText(), 'before pasted');
  await editCommand('Undo');
  assert.equal(await text(), 'before');
  assert.equal(await stateText(), 'before');
  await editCommand('Redo');
  assert.equal(await text(), 'before pasted');
  assert.equal(await stateText(), 'before pasted');

  await mount();
  await send('Input.insertText', { text: 'alpha beta gamma' });
  await evaluate(`(() => {
    const editor = document.querySelector('#paste-undo-test-host [contenteditable]');
    const range = document.createRange();
    range.setStart(editor.firstChild, 6);
    range.setEnd(editor.firstChild, 10);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  await pasteText('BETA');
  assert.equal(await text(), 'alpha BETA gamma');
  await editCommand('Undo');
  assert.equal(await text(), 'alpha beta gamma');
  await editCommand('Redo');
  assert.equal(await text(), 'alpha BETA gamma');

  await mount();
  const longText = `${'long text '.repeat(1200)}\nsecond line`;
  await pasteText(longText);
  assert.equal(await stateText(), longText);
  await editCommand('Undo');
  assert.equal(await stateText(), '');
  await editCommand('Redo');
  assert.equal(await stateText(), longText);

  await mount();
  assert.equal(
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['image'], 'pasted.png', { type: 'image/png' }));
      document.querySelector('#paste-undo-test-host [contenteditable]').dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      );
      return window.__pasteUndoFiles;
    })()`),
    1
  );
  assert.equal(await stateText(), undefined);

  console.log('composer paste undo/redo verification passed');
} finally {
  await evaluate(
    `window.__pasteUndoRoot?.unmount(); document.querySelector('#paste-undo-test-host')?.remove()`
  );
  ws.close();
}
