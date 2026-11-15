import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  explicitPort,
  keepRequested,
  mergeOwnedPids,
  ownedProcessGroups,
  reservePorts,
  resolveArtDir,
} from './verify-secretary-isolation.mjs';

test('explicit ports are optional and must be real TCP ports', () => {
  assert.equal(explicitPort('SEC_VERIFY_CDP_PORT', undefined), null);
  assert.equal(explicitPort('SEC_VERIFY_CDP_PORT', ''), null);
  assert.equal(explicitPort('SEC_VERIFY_CDP_PORT', '9433'), 9433);
  assert.throws(() => explicitPort('SEC_VERIFY_CDP_PORT', '0'), /SEC_VERIFY_CDP_PORT/);
  assert.throws(() => explicitPort('SEC_VERIFY_CDP_PORT', 'nope'), /SEC_VERIFY_CDP_PORT/);
  assert.throws(() => explicitPort('SEC_VERIFY_CDP_PORT', '65536'), /SEC_VERIFY_CDP_PORT/);
});

test('keep directory only when SEC_VERIFY_KEEP or --keep is set', () => {
  assert.equal(keepRequested({ SEC_VERIFY_KEEP: '1' }, []), true);
  assert.equal(keepRequested({ SEC_VERIFY_KEEP: 'true' }, []), true);
  assert.equal(keepRequested({}, ['node', 'scripts/verify-secretary.mjs', '--keep']), true);
  assert.equal(keepRequested({ SEC_VERIFY_KEEP: '0' }, []), false);
  assert.equal(keepRequested({}, []), false);
});

test('auto temp dir stays under /tmp so mk-env accepts it', () => {
  assert.equal(
    resolveArtDir({ SEC_VERIFY_DIR: '/tmp/sec-custom' }, () => '/tmp/unused'),
    '/tmp/sec-custom'
  );
  assert.equal(
    resolveArtDir({}, (prefix) => `${prefix}abc123`),
    '/tmp/sec-verify-abc123'
  );
});

test('owned pids follow the spawn tree and ignore other sessions', () => {
  const processes = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 11, pgid: 12 },
    { pid: 13, ppid: 12, pgid: 12 },
    { pid: 99, ppid: 1, pgid: 99 },
  ];
  const owned = mergeOwnedPids([], processes, [10]);
  assert.deepEqual(owned, [10, 11, 12, 13]);
  assert.deepEqual(ownedProcessGroups(processes, owned), [10, 12]);
});

test('pids already owned stay tracked after the parent is reparented', () => {
  const first = mergeOwnedPids(
    [],
    [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 12, ppid: 10, pgid: 12 },
    ],
    [10]
  );
  const second = mergeOwnedPids(
    first,
    [
      { pid: 12, ppid: 1, pgid: 12 },
      { pid: 14, ppid: 12, pgid: 12 },
      { pid: 99, ppid: 1, pgid: 99 },
    ],
    []
  );
  assert.deepEqual(second, [10, 12, 14]);
});

test('auto ports differ across overlapping reservations and a busy explicit port fails', async () => {
  const held = new Set();
  const open = (port) =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const actual = typeof address === 'object' && address ? address.port : port;
        if (held.has(actual)) {
          reject(new Error(`port ${actual} reserved twice`));
          return;
        }
        held.add(actual);
        resolve({
          port: actual,
          close: () =>
            new Promise((done) =>
              server.close(() => {
                held.delete(actual);
                done();
              })
            ),
        });
      });
    });
  const busy = await open(0);
  try {
    const [first, second] = await Promise.all([
      reservePorts({ cdp: null, fake: null, plugin: null, renderer: null }, open),
      reservePorts({ cdp: null, fake: null, plugin: null, renderer: null }, open),
    ]);
    const values = [...Object.values(first.ports), ...Object.values(second.ports)];
    // 每份都挑 cdp/fake/plugin/renderer/telegram 五个端口
    assert.equal(values.length, 10);
    assert.equal(new Set(values).size, 10);
    assert.equal(held.size, 11);
    await first.release('cdp');
    assert.equal(held.size, 10);
    await first.release();
    await second.release();
    assert.deepEqual([...held], [busy.port]);
    await assert.rejects(
      reservePorts({ cdp: busy.port, fake: null, plugin: null, renderer: null }, open),
      /already in use/
    );
  } finally {
    await busy.close();
  }
});
