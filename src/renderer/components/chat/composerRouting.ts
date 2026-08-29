import type { AgentTypeKey } from '@shared/builtinAgents';
import type { AttachedImage } from '@shared/types/agent';
import type { AgentDispatchTask, FileMentionCandidate } from '@shared/types/mentions';
import type { ComposerPayload } from './mentionComposer';

export function routeComposerPayload(
  payload: ComposerPayload,
  handlers: {
    dispatchAgent: (typeKey: AgentTypeKey, task: AgentDispatchTask) => void;
    sendCoding: (text: string, images: AttachedImage[]) => void;
  }
): 'agent' | 'coding' {
  if (payload.recipient) {
    handlers.dispatchAgent(payload.recipient.typeKey, {
      text: payload.text,
      images: payload.images,
      fileMentions: payload.mentions
        .filter((mention): mention is FileMentionCandidate => mention.kind === 'file')
        .map((mention) => ({ id: mention.id, relativePath: mention.relativePath })),
    });
    return 'agent';
  }
  handlers.sendCoding(payload.text, payload.images);
  return 'coding';
}
