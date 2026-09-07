interface PutOp {
  start: number;
  end: number;
  body: string[];
}

function splitAddressableLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parsePuts(patch: string): PutOp[] {
  const lines = patch.split('\n');
  const ops: PutOp[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line === '') {
      i += 1;
      continue;
    }
    const match = /^PUT (\d+)\.=(\d+):$/.exec(line);
    if (!match) throw new Error(`invalid hashline op: ${line}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    i += 1;
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').startsWith('+')) {
      body.push((lines[i] ?? '').slice(1));
      i += 1;
    }
    ops.push({ start, end, body });
  }
  if (ops.length === 0) throw new Error('hashline patch has no PUT operations');
  return ops;
}

export function applyHashlineToText(original: string, patch: string): string {
  const lines = splitAddressableLines(original);
  const ops = parsePuts(patch).sort((a, b) => a.start - b.start);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.body.length === 0) throw new Error(`PUT ${op.start}.=${op.end}: missing body`);
    if (op.start < 1 || op.end > lines.length || op.start > op.end) {
      throw new Error(`PUT ${op.start}.=${op.end}: out of range`);
    }
    const prev = ops[i - 1];
    if (prev && prev.end >= op.start) {
      throw new Error(`PUT ${prev.start}.=${prev.end} overlaps PUT ${op.start}.=${op.end}`);
    }
  }

  const out: string[] = [];
  let cursor = 1;
  for (const op of ops) {
    while (cursor < op.start) {
      out.push(lines[cursor - 1]!);
      cursor += 1;
    }
    out.push(...op.body);
    cursor = op.end + 1;
  }
  while (cursor <= lines.length) {
    out.push(lines[cursor - 1]!);
    cursor += 1;
  }

  let next = out.join('\n');
  if (original.endsWith('\n')) next += '\n';
  if (next === original) throw new Error('hashline patch produced no change');
  return next;
}
