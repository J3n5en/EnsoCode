import type { ProjectedMessage } from '@shared/types/agent';
import type { WorkspaceSearchDoc, WorkspaceSearchField } from '@shared/workspaceSearch';

const TOOL_SNIPPET = 120;

function textOf(message: ProjectedMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

function toolSnippet(message: ProjectedMessage): string | undefined {
  if (message.role !== 'toolResult' && !message.content.some((part) => part.type === 'toolCall')) {
    return undefined;
  }
  const names = [
    message.toolName,
    ...message.content.flatMap((part) => (part.type === 'toolCall' ? [part.name] : [])),
  ].filter((name): name is string => Boolean(name));
  if (names.length === 0) return undefined;
  const args = message.content
    .flatMap((part) =>
      part.type === 'toolCall' && part.arguments != null ? [JSON.stringify(part.arguments)] : []
    )
    .join(' ')
    .slice(0, TOOL_SNIPPET);
  return `${names.join(' ')} ${args}`.trim();
}

export function conversationToSearchDoc(input: {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  lastActiveAt: number;
  archived?: boolean;
  isDraftEmpty?: boolean;
  isCurrent?: boolean;
  parentConversationId?: string;
  coworkerId?: string;
  messages: ProjectedMessage[];
}): WorkspaceSearchDoc {
  const fields: WorkspaceSearchField[] = [
    { field: 'title', text: input.title },
    { field: 'project', text: input.projectName },
    { field: 'id', text: input.conversationId },
    { field: 'body', text: input.messages.map(textOf).filter(Boolean).join('\n') },
  ];
  const tools = input.messages.map(toolSnippet).filter((text): text is string => Boolean(text));
  if (tools.length > 0) fields.push({ field: 'tool', text: tools.join('\n') });
  return {
    conversationId: input.conversationId,
    projectId: input.projectId,
    projectName: input.projectName,
    title: input.title,
    lastActiveAt: input.lastActiveAt,
    fields,
    ...(input.archived ? { archived: true } : {}),
    ...(input.isDraftEmpty ? { isDraftEmpty: true } : {}),
    ...(input.isCurrent ? { isCurrent: true } : {}),
    ...(input.parentConversationId ? { parentConversationId: input.parentConversationId } : {}),
    ...(input.coworkerId ? { coworkerId: input.coworkerId } : {}),
  };
}
