import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface InterceptionResult {
  block: boolean;
  message?: string;
  suggestedTool?: string;
}

interface Rule {
  pattern: RegExp;
  tool: string;
  message: string;
}

const RULES: Rule[] = [
  {
    pattern: /^\s*(cat|head|tail|less|more)\s+/,
    tool: 'read',
    message: 'Use the `read` tool instead of cat/head/tail/less.',
  },
  {
    pattern: /^\s*(Get-Content|gc|type)\b/i,
    tool: 'read',
    message: 'Use the `read` tool instead of Get-Content/gc/type.',
  },
  {
    pattern: /^\s*(grep|rg|ripgrep|ag|ack)\s+/,
    tool: 'grep',
    message: 'Use the `grep` tool instead of grep/rg.',
  },
  {
    pattern: /^\s*(Select-String|sls)\b/i,
    tool: 'grep',
    message: 'Use the `grep` tool instead of Select-String/sls.',
  },
  {
    pattern: /^\s*sed\s+(-i|--in-place)\b/,
    tool: 'edit',
    message: 'Use the `edit` tool instead of sed -i.',
  },
  {
    pattern: /^\s*perl\s+.*-[pn]?i\b/,
    tool: 'edit',
    message: 'Use the `edit` tool instead of perl -i.',
  },
  {
    pattern: /^\s*(Set-Content|Add-Content|sc|ac)\b/i,
    tool: 'edit',
    message: 'Use the `edit` tool instead of Set-Content/Add-Content.',
  },
];

const DEFAULT_TOOLS = ['read', 'grep', 'edit', 'find'];

export function checkBashInterception(
  command: string,
  availableTools: readonly string[] = DEFAULT_TOOLS
): InterceptionResult {
  const tools = new Set(availableTools);
  for (const candidate of interceptionCandidates(command)) {
    for (const rule of RULES) {
      if (!tools.has(rule.tool)) continue;
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(candidate)) {
        return {
          block: true,
          suggestedTool: rule.tool,
          message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
        };
      }
    }
  }
  return { block: false };
}

function interceptionCandidates(command: string): string[] {
  const out = [command.trim()];
  for (const segment of splitSegments(command)) {
    if (segment.pipedStdin) continue;
    const text = segment.text.trim();
    if (text) out.push(text);
  }
  return out;
}

function splitSegments(command: string): Array<{ text: string; pipedStdin: boolean }> {
  const segments: Array<{ text: string; pipedStdin: boolean }> = [];
  let start = 0;
  let pipedStdin = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      push(command.slice(start, i), pipedStdin, segments);
      start = i + 1;
      pipedStdin = false;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      push(command.slice(start, i), pipedStdin, segments);
      start = i + 2;
      i += 1;
      pipedStdin = false;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      push(command.slice(start, i), pipedStdin, segments);
      start = i + 2;
      i += 1;
      pipedStdin = false;
      continue;
    }
    if (ch === '|') {
      push(command.slice(start, i), pipedStdin, segments);
      start = i + 1;
      pipedStdin = true;
    }
  }
  push(command.slice(start), pipedStdin, segments);
  return segments;
}

function push(
  text: string,
  pipedStdin: boolean,
  segments: Array<{ text: string; pipedStdin: boolean }>
): void {
  if (text.trim()) segments.push({ text, pipedStdin });
}

export function withBashInterception(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = (params as { command?: string }).command;
      if (typeof command === 'string') {
        const names =
          ctx && typeof ctx === 'object' && Array.isArray((ctx as unknown as { toolNames?: unknown }).toolNames)
            ? ((ctx as unknown as { toolNames: string[] }).toolNames)
            : DEFAULT_TOOLS;
        const hit = checkBashInterception(command, names);
        if (hit.block) throw new Error(hit.message);
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
