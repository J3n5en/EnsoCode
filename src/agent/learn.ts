import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { saveLearnedLesson } from './localMemory';

export const LEARN_TOOL_DESCRIPTION = [
  'Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.',
  '',
  'Use after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.',
  '',
  '`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact.',
  'Capture sparingly, specifically: one strong reusable lesson > several vague ones.',
].join('\n');

export function createLearnTool(opts: { agentDir: string; cwd: string }): ToolDefinition {
  return {
    name: 'learn',
    label: 'Learn',
    description: LEARN_TOOL_DESCRIPTION,
    promptSnippet:
      'learn: capture a durable reusable lesson to project memory (optional skill in a later slice)',
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
          description: 'optional managed skill (ignored this slice)',
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
      const { memory, context } = params as { memory?: string; context?: string };
      const result = await saveLearnedLesson(opts.agentDir, opts.cwd, {
        content: memory ?? '',
        context,
      });
      if (result.stored === 0) {
        throw new Error('Lesson was empty after sanitization; nothing stored.');
      }
      return {
        content: [{ type: 'text' as const, text: 'Lesson stored.' }],
        details: { skill: null },
      };
    },
  };
}
