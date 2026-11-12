export const TOOL_SECTIONS = [
  { id: 'collaboration', label: 'Collaboration & planning' },
  { id: 'web', label: 'Web' },
  { id: 'execution', label: 'Execution' },
  { id: 'context', label: 'Context & memory' },
  { id: 'safety', label: 'Safety' },
] as const;

export type ToolSectionId = (typeof TOOL_SECTIONS)[number]['id'];

export const TOOL_SECTION = {
  subagent: 'collaboration',
  workflow: 'collaboration',
  todo: 'collaboration',
  plan: 'collaboration',
  ask_user: 'collaboration',
  browser: 'web',
  web: 'web',
  background_tasks: 'execution',
  isolated_sandbox: 'execution',
  computer: 'execution',
  image_generation: 'execution',
  memory: 'context',
  turn_discard: 'context',
} as const satisfies Record<string, ToolSectionId>;

export function builtinToolsInSection<T extends { id: string }>(
  tools: readonly T[],
  section: ToolSectionId
): T[] {
  return tools.filter((tool) => {
    if (!Object.hasOwn(TOOL_SECTION, tool.id)) return false;
    return TOOL_SECTION[tool.id as keyof typeof TOOL_SECTION] === section;
  });
}
