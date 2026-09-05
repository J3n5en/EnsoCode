import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { saveLearnedLesson } from './localMemory';
import { authoredSkillNames, writeManagedSkill } from './memory/managedSkill';

export const LEARN_TOOL_DESCRIPTION = [
  'Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.',
  '',
  'Use after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.',
  '',
  '`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact.',
  'Capture sparingly, specifically: one strong reusable lesson > several vague ones.',
].join('\n');

export function createLearnTool(opts: {
  agentDir: string;
  cwd: string;
  skillPaths?: string[];
}): ToolDefinition {
  return {
    name: 'learn',
    label: 'Learn',
    description: LEARN_TOOL_DESCRIPTION,
    promptSnippet:
      'learn: capture a durable reusable lesson to project memory; optional skill writes managed-skills',
    parameters: {
      type: 'object',
      properties: {
        memory: {
          type: 'string',
          description: 'the durable, self-contained lesson to remember (what, when, why)',
        },
        context: { type: 'string', description: 'optional source context for the lesson' },
        skill: {
          type: 'object',
          description: 'optional managed skill to create or update',
          properties: {
            action: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            body: { type: 'string' },
          },
        },
      },
      required: ['memory'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params) {
      const { memory, context, skill } = params as {
        memory?: string;
        context?: string;
        skill?: { action?: string; name?: string; description?: string; body?: string };
      };
      const result = await saveLearnedLesson(opts.agentDir, opts.cwd, {
        content: memory ?? '',
        context,
      });
      if (result.stored === 0) {
        throw new Error('Lesson was empty after sanitization; nothing stored.');
      }
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: 'Lesson stored.' }],
          details: { skill: null },
        };
      }
      const written = await writeManagedSkill(
        opts.agentDir,
        {
          action: skill.action === 'update' ? 'update' : 'create',
          name: skill.name ?? '',
          description: skill.description ?? '',
          body: skill.body ?? '',
        },
        authoredSkillNames(opts.skillPaths ?? [])
      );
      if (!written.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Lesson stored. ${written.error}`,
            },
          ],
          details: { skill: null, ...(written.shadowed ? { shadowed: true } : {}) },
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: `Lesson stored. Managed skill ${written.name} written.` },
        ],
        details: { skill: written.path },
      };
    },
  };
}
