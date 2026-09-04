/** 与会话 Context occupancy 同一套估算：ceil(chars / 4)。 */

export function charsToTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export interface OccupancySkill {
  name: string;
  description?: string;
  content?: string;
}

export interface OccupancyTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export function skillOccupancyText(skill: OccupancySkill): string {
  return `${skill.name} ${skill.description ?? ''} ${skill.content ?? ''}`;
}

export function toolOccupancyText(tool: OccupancyTool): string {
  const params = tool.parameters == null ? '' : JSON.stringify(tool.parameters);
  return `${tool.name} ${tool.description ?? ''} ${params}`;
}

export function estimateSkillTokens(skill: OccupancySkill): number {
  return charsToTokens(skillOccupancyText(skill).length);
}

export function estimateToolTokens(tool: OccupancyTool): number {
  return charsToTokens(toolOccupancyText(tool).length);
}

export function estimateInstructionTokens(content: string): number {
  return charsToTokens(content.length);
}

export function estimateToolsTotal(tools: readonly OccupancyTool[]): number {
  return charsToTokens(tools.reduce((sum, tool) => sum + toolOccupancyText(tool).length, 0));
}
