// 先启动隔离 pnpm dev（CDP 9222），再运行 node scripts/verify-timeline-height.mjs。
// 真实布局回归：长首条不能成为所有行的高度；不读写会话或设置。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const expression = `(async () => {
  if (document.visibilityState !== 'visible') throw new Error('Bring the dev Electron window to the foreground before running this layout test.');
  const resources = performance.getEntriesByType('resource').map(entry => entry.name);
  const { default: React } = await import(resources.find(url => url.includes('/react.js?')));
  const { default: ReactDOM } = await import(resources.find(url => url.includes('/react-dom_client.js?')));
  const { MessageTimeline } = await import('/components/chat/MessageTimeline.tsx');
  const { buildTimeline } = await import('/stores/sessions/timeline.ts');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;width:900px;height:720px;display:flex;flex-direction:column;background:var(--background)';
  document.body.append(host);
  const root = ReactDOM.createRoot(host);
  const results = [];
  try {
    for (const [key, longIndex, count] of [['a', 0, 120], ['b', 119, 120], ['a', 0, 120], ['short', -1, 2]]) {
      const messages = Array.from({ length: count }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: key + ' message ' + i + ': ' + 'Conversation text. '.repeat(i === longIndex ? 2000 : 1) }],
      }));
      const items = buildTimeline(messages, false);
      const start = performance.now();
      let firstVisibleMs = null;
      let maxHeight = 0;
      root.render(React.createElement(MessageTimeline, { key, items, busy: true, running: false, emptyTitle: 'Height regression' }));
      await new Promise(resolve => {
        let frame = 0;
        const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 1800);
        function sample() {
          const scroller = host.querySelector('[data-virtuoso-scroller]');
          const list = host.querySelector('[data-testid="virtuoso-item-list"]');
          const elapsed = performance.now() - start;
          maxHeight = Math.max(maxHeight, scroller?.scrollHeight ?? 0);
          if (firstVisibleMs === null && list && getComputedStyle(list).visibility !== 'hidden' && list.innerText.includes(key + ' message')) {
            firstVisibleMs = Math.round(elapsed);
          }
          if (elapsed < 1600) frame = requestAnimationFrame(sample);
          else { clearTimeout(timer); resolve(); }
        }
        frame = requestAnimationFrame(sample);
      });
      const scroller = host.querySelector('[data-virtuoso-scroller]');
      results.push({
        key, longIndex, count, maxHeight, firstVisibleMs,
        height: scroller?.scrollHeight,
        bottomGap: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : null,
        lastMessageVisible: scroller?.innerText.includes(key + ' message ' + (count - 1)),
      });
    }
    return results;
  } finally {
    root.unmount();
    host.remove();
  }
})()`;

const output = execFileSync(
  process.execPath,
  ['.agents/skills/enso-cdp/scripts/cdp.mjs', 'eval', expression],
  { encoding: 'utf8', timeout: 30_000 }
);
const results = JSON.parse(output);
console.table(results);
for (const result of results) {
  assert.ok(result.maxHeight < 36_000, `${result.key}: first-row height inflated the entire list`);
  assert.ok(result.firstVisibleMs !== null, `${result.key}: timeline stayed hidden`);
  assert.ok(result.lastMessageVisible, `${result.key}: last message is missing`);
  assert.ok(
    result.bottomGap !== null && result.bottomGap <= 40,
    `${result.key}: not pinned to bottom`
  );
}
