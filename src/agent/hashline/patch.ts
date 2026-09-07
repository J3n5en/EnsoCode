import { applyHashlineToText } from './apply';
import { computeFileHash } from './format';

const HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\]$/;

export function parseHashlineHeader(input: string): {
  path?: string;
  tag?: string;
  body: string;
} {
  const lines = input.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  const first = (lines[i] ?? '').trim();
  const match = HEADER.exec(first);
  if (!match) return { body: input };
  return {
    path: match[1],
    tag: match[2]?.toUpperCase(),
    body: lines.slice(i + 1).join('\n'),
  };
}

export function applyHashlineInput(
  liveText: string,
  input: string,
  expected?: { path?: string; tag?: string }
): string {
  const parsed = parseHashlineHeader(input);
  if (parsed.tag) {
    const liveTag = computeFileHash(liveText);
    if (parsed.tag !== liveTag) {
      throw new Error(`hashline tag stale: ${parsed.tag} !== ${liveTag}`);
    }
    if (expected?.tag && expected.tag.toUpperCase() !== parsed.tag) {
      throw new Error(`hashline tag mismatch: ${parsed.tag} !== ${expected.tag}`);
    }
  }
  if (parsed.path && expected?.path && parsed.path !== expected.path) {
    throw new Error(`hashline path mismatch: ${parsed.path} !== ${expected.path}`);
  }
  return applyHashlineToText(liveText, parsed.body);
}
