import { classifyEditArgs } from './classify';

export interface HashlineEditHandlers {
  applyReplace: (params: unknown) => unknown;
  applyHashline: (params: unknown) => unknown;
}

export function createHashlineEditTool(handlers: HashlineEditHandlers) {
  return {
    name: 'edit',
    async execute(_id: string, params: unknown) {
      const kind = classifyEditArgs(params).kind;
      if (kind === 'replace') return handlers.applyReplace(params);
      if (kind === 'hashline') return handlers.applyHashline(params);
      if (kind === 'mixed') {
        throw new Error('edit accepts either hashline input or replace edits, not both');
      }
      throw new Error('edit requires hashline input or replace edits');
    },
  };
}
