import { isUtf8 } from 'node:buffer';
import { closestMatchHint } from '../closestMatch';
import type { ApplyPatchChunk } from './types';

interface SourceLine {
  text: string;
  ending?: string;
}

export interface MatchBudget {
  remaining: number;
}

interface Replacement {
  index: number;
  count: number;
  lines: string[];
  order: number;
}

function decode(raw: Buffer, path: string): string {
  if (!isUtf8(raw)) throw new Error(`File is not valid UTF-8: ${path}`);
  const value = raw.toString('utf8');
  if (value.includes('\0')) throw new Error(`Binary file cannot be patched: ${path}`);
  return value;
}

function parseSource(
  raw: Buffer,
  path: string
): {
  bom: string;
  lines: SourceLine[];
  preferredEnding: string;
  text: string;
} {
  const text = decode(raw, path);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const lines: SourceLine[] = [];
  let preferredEnding = '\n';
  let sawEnding = false;
  let start = 0;
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    let ending: string | undefined;
    if (body[cursor] === '\r') {
      ending = body[cursor + 1] === '\n' ? '\r\n' : '\r';
    } else if (body[cursor] === '\n') ending = '\n';
    if (!ending) continue;
    if (!sawEnding) {
      preferredEnding = ending;
      sawEnding = true;
    }
    lines.push({ text: body.slice(start, cursor), ending });
    cursor += ending.length - 1;
    start = cursor + 1;
  }
  if (start < body.length) lines.push({ text: body.slice(start) });
  return { bom, lines, preferredEnding, text };
}

function normalizePunctuation(value: string): string {
  return [...value.trim()]
    .map((char) => {
      switch (char) {
        case '\u2010':
        case '\u2011':
        case '\u2012':
        case '\u2013':
        case '\u2014':
        case '\u2015':
        case '\u2212':
          return '-';
        case '\u2018':
        case '\u2019':
        case '\u201A':
        case '\u201B':
          return "'";
        case '\u201C':
        case '\u201D':
        case '\u201E':
        case '\u201F':
          return '"';
        case '\u00A0':
        case '\u2002':
        case '\u2003':
        case '\u2004':
        case '\u2005':
        case '\u2006':
        case '\u2007':
        case '\u2008':
        case '\u2009':
        case '\u200A':
        case '\u202F':
        case '\u205F':
        case '\u3000':
          return ' ';
        default:
          return char;
      }
    })
    .join('');
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  budget: MatchBudget
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const last = lines.length - pattern.length;
  const searchStart = eof ? Math.max(start, last) : start;
  const matchAt = (index: number, equal: (left: string, right: string) => boolean): boolean => {
    budget.remaining -= pattern.length;
    if (budget.remaining < 0) throw new Error('apply_patch comparison limit exceeded');
    return pattern.every((line, offset) => equal(lines[index + offset], line));
  };
  const find = (equal: (left: string, right: string) => boolean): number | undefined => {
    for (let index = searchStart; index <= last; index += 1) {
      if (matchAt(index, equal)) return index;
    }
    return undefined;
  };
  return (
    find((left, right) => left === right) ??
    find((left, right) => left.trimEnd() === right.trimEnd()) ??
    find((left, right) => left.trim() === right.trim()) ??
    find((left, right) => normalizePunctuation(left) === normalizePunctuation(right))
  );
}

function computeReplacements(
  sourceLines: readonly SourceLine[],
  chunks: readonly ApplyPatchChunk[],
  path: string,
  budget: MatchBudget
): Replacement[] {
  const lines = sourceLines.map((line) => line.text);
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  let order = 0;
  for (const chunk of chunks) {
    if (chunk.restartSearch) lineIndex = 0;
    if (chunk.changeContext !== undefined) {
      const found = seekSequence(lines, [chunk.changeContext], lineIndex, false, budget);
      if (found === undefined) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      }
      lineIndex = found + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({ index: lines.length, count: 0, lines: chunk.newLines, order: order++ });
      continue;
    }
    let pattern: readonly string[] = chunk.oldLines;
    let nextLines: readonly string[] = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile, budget);
    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1);
      if (nextLines.at(-1) === '') nextLines = nextLines.slice(0, -1);
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile, budget);
    }
    if (found === undefined) {
      const earlier =
        lineIndex > 0
          ? seekSequence(lines, pattern, 0, false, { remaining: Number.MAX_SAFE_INTEGER })
          : undefined;
      const hint =
        earlier !== undefined
          ? `These lines exist at line ${earlier + 1}, above the previous hunk. Order hunks top to bottom.`
          : closestMatchHint(lines, chunk.oldLines);
      throw new Error(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}${hint ? `\n\n${hint}` : ''}`
      );
    }
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= nextLines.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push({
          index: found + oldStart,
          count: oldContext - oldStart,
          lines: nextLines.slice(newStart, newContext).slice(),
          order: order++,
        });
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== nextLines.length) {
      replacements.push({
        index: found + oldStart,
        count: pattern.length - oldStart,
        lines: nextLines.slice(newStart).slice(),
        order: order++,
      });
    }
    lineIndex = found + pattern.length;
  }
  return replacements.sort((left, right) => left.index - right.index || left.order - right.order);
}

export function applyUpdateChunks(
  raw: Buffer,
  path: string,
  chunks: readonly ApplyPatchChunk[],
  budget: MatchBudget = { remaining: Number.MAX_SAFE_INTEGER }
): Buffer {
  const source = parseSource(raw, path);
  if (chunks.length === 0) return Buffer.from(source.text, 'utf8');
  const replacements = computeReplacements(source.lines, chunks, path, budget);
  const result: SourceLine[] = [];
  let sourceIndex = 0;
  for (const replacement of replacements) {
    if (replacement.index < sourceIndex) throw new Error(`Overlapping update chunks in ${path}`);
    for (let index = sourceIndex; index < replacement.index; index += 1) {
      result.push(source.lines[index]);
    }
    for (const text of replacement.lines) {
      result.push({ text, ending: source.preferredEnding });
    }
    sourceIndex = replacement.index + replacement.count;
  }
  for (let index = sourceIndex; index < source.lines.length; index += 1) {
    result.push(source.lines[index]);
  }
  for (const line of result) line.ending ??= source.preferredEnding;
  const body = result.map((line) => `${line.text}${line.ending ?? ''}`).join('');
  return Buffer.from(source.bom + body, 'utf8');
}

export function decodePatchText(raw: Buffer, path: string): string {
  return decode(raw, path);
}
