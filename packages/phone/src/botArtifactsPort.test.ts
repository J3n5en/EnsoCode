import type { PhoneToHost } from '@enso/pair';
import { describe, expect, it } from 'vitest';
import { artifactKey, BotArtifactsPort } from './botArtifactsPort';

const chatId = '11111111-1111-4111-8111-111111111111';
const entry = { chatId, entryId: 'e1' };
const turn = { chatId, conversationId: 'c1', messageIndex: 4 };
const mediaId = `${'a'.repeat(64)}.png`;

function setup() {
  const sent: PhoneToHost[] = [];
  const port = new BotArtifactsPort((command) => {
    sent.push(command);
  });
  return { sent, port };
}

describe('artifactKey', () => {
  it('distinguishes entry and turn targets', () => {
    expect(artifactKey(entry)).not.toBe(artifactKey(turn));
    expect(artifactKey(turn)).toBe(artifactKey({ ...turn }));
  });
});

describe('BotArtifactsPort', () => {
  it('requests each target once and stores sanitized frames', () => {
    const { sent, port } = setup();
    port.request(entry);
    port.request(entry);
    expect(sent).toEqual([{ type: 'bot-artifacts', target: entry }]);
    let notified = 0;
    port.subscribe(() => notified++);
    port.receive({
      type: 'bot-artifacts',
      target: entry,
      artifacts: [
        { rel: 'a.png', name: 'a.png', size: 3, kind: 'image' },
        { rel: 1, name: 'bad' } as never,
      ],
      media: [
        { ok: true, mediaId, source: 'web', thumb: 'data:image/jpeg;base64,AA' },
        { ok: true, mediaId: '../x.png', source: 'web' } as never,
        { ok: true, mediaId, source: 'web', thumb: 'javascript:alert(1)' },
        { ok: false, error: 'quota', source: 'desktop' },
        { ok: false, error: 'boom', source: 'web' } as never,
      ],
    });
    expect(notified).toBe(1);
    expect(port.get(entry)).toEqual({
      artifacts: [{ rel: 'a.png', name: 'a.png', size: 3, kind: 'image' }],
      media: [
        { ok: true, mediaId, source: 'web', thumb: 'data:image/jpeg;base64,AA' },
        { ok: false, error: 'quota', source: 'desktop' },
      ],
    });
  });

  it('re-requests empty results on a later mount, but not non-empty ones', () => {
    const { sent, port } = setup();
    port.request(turn);
    port.receive({ type: 'bot-artifacts', target: turn, artifacts: [], media: [] });
    port.request(turn);
    expect(sent).toHaveLength(2);
    port.receive({
      type: 'bot-artifacts',
      target: turn,
      artifacts: [{ rel: 'x.md', name: 'x.md', size: 1, kind: 'markdown' }],
      media: [],
    });
    port.request(turn);
    expect(sent).toHaveLength(2);
  });

  it('resolves image requests by requestId and rejects bad data urls', async () => {
    const { sent, port } = setup();
    const first = port.image(entry, { mediaId });
    const second = port.image(turn, { rel: 'a.png' });
    const [a, b] = sent as Extract<PhoneToHost, { type: 'bot-artifact-image' }>[];
    expect(a).toMatchObject({ type: 'bot-artifact-image', target: entry, mediaId });
    expect(b).toMatchObject({ type: 'bot-artifact-image', target: turn, rel: 'a.png' });
    port.receiveImage({ type: 'bot-artifact-image', requestId: b.requestId, dataUrl: 'http://x' });
    port.receiveImage({
      type: 'bot-artifact-image',
      requestId: a.requestId,
      dataUrl: 'data:image/png;base64,AA',
    });
    await expect(first).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA' });
    await expect(second).resolves.toEqual({ error: 'invalid' });
  });

  it('fails pending image requests on reset', async () => {
    const { port } = setup();
    const pending = port.image(entry, { mediaId });
    port.reset();
    await expect(pending).resolves.toEqual({ error: 'offline' });
  });
});
