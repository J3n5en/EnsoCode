import { readFileSync } from 'node:fs';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const MAX_SKILL_CHARS = 60_000;

export interface LoadedSkill {
  name: string;
  description: string;
  filePath: string;
}

function errorResult(text: string): Awaited<ReturnType<ToolDefinition['execute']>> {
  return { content: [{ type: 'text', text }], details: undefined, isError: true };
}

/**
 * 秘书没有 read 工具，SKILL.md 只能经这里读。名字必须在本次 spawn 实际加载的 skill 表里，
 * 因此调用方给不了任意路径。
 */
export function createSkillReadTool(skills: () => readonly LoadedSkill[]): ToolDefinition {
  return {
    name: 'skill_read',
    label: 'skill_read',
    description:
      'Read one skill file by name from <available_skills>. Call it before following a skill: acting on a guess of its contents defeats the point. Only skills loaded into this session can be read.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Skill name exactly as listed in <available_skills>',
        },
      },
      required: ['name'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const raw = (params as { name?: unknown } | null)?.name;
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) return errorResult('skill_read needs a skill name');
      const loaded = skills();
      const skill = loaded.find((entry) => entry.name === name);
      if (!skill) {
        const available = loaded.map((entry) => entry.name).join(', ');
        return errorResult(
          `No skill named "${name}" is loaded in this session.` +
            (available ? ` Available: ${available}` : ' No skills are loaded.')
        );
      }
      try {
        const text = readFileSync(skill.filePath, 'utf8');
        return {
          content: [
            {
              type: 'text',
              text: text.length > MAX_SKILL_CHARS ? `${text.slice(0, MAX_SKILL_CHARS)}\n…` : text,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return errorResult(
          `Could not read skill "${name}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}
