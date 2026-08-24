import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';
import { CircleStop, SendHorizontal, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export function ChatView() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const session = useSessionsStore();

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.apiKey),
    [providers]
  );
  const [providerId, setProviderId] = useState('');
  const provider = enabledProviders.find((p) => p.id === providerId) ?? enabledProviders[0];
  const enabledModels = useMemo(
    () => (provider?.models ?? []).filter((model) => model.enabled !== false),
    [provider]
  );
  const [modelId, setModelId] = useState('');
  const effectiveModelId = enabledModels.some((m) => m.id === modelId)
    ? modelId
    : (enabledModels[0]?.id ?? '');

  const [text, setText] = useState('');
  const [cwd, setCwd] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息变化时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages]);

  const busy = session.status === 'running' || session.spawning;

  const handleSend = async () => {
    const content = text.trim();
    if (!content || !provider || !effectiveModelId) return;
    setText('');
    if (!session.sessionId) {
      const error = await session.start(provider.id, effectiveModelId, cwd.trim());
      if (error) return;
    }
    await useSessionsStore.getState().send(content);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Select value={provider?.id ?? ''} onValueChange={(v) => setProviderId(v ?? '')}>
          <SelectTrigger className="h-8 w-44">
            <SelectValue placeholder={t('Provider')} />
          </SelectTrigger>
          <SelectPopup>
            {enabledProviders.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select value={effectiveModelId} onValueChange={(v) => setModelId(v ?? '')}>
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder={t('Model')} />
          </SelectTrigger>
          <SelectPopup>
            {enabledModels.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label ?? model.id}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder={t('Working directory')}
          className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <StatusBadge status={session.spawning ? 'running' : session.status} />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => window.electronAPI.window.openSettings()}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
          {session.messages.map((message, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 协议按 index upsert，index 即消息身份
            <MessageBubble key={index} message={message} />
          ))}
          {session.error && (
            <p className="text-sm text-destructive whitespace-pre-wrap">{session.error}</p>
          )}
        </div>
      </ScrollArea>

      <div className="border-t px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              session.status === 'running' ? t('Steer the running agent…') : t('Ask the agent…')
            }
            className="min-h-10 flex-1 resize-none"
            rows={2}
          />
          {busy ? (
            <Button variant="outline" size="icon" onClick={() => void session.abort()}>
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => void handleSend()} disabled={!text.trim()}>
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'running' ? 'default' : status === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{status}</Badge>;
}

function MessageBubble({ message }: { message: ProjectedMessage }) {
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap">
        {textOf(message.content)}
      </div>
    );
  }
  if (message.role === 'toolResult') {
    return (
      <div className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
        {message.toolName}
        {message.isError ? ' ✕' : ' ✓'}
      </div>
    );
  }
  return (
    <div className="flex max-w-[85%] flex-col gap-1 self-start">
      {message.content.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: part 无稳定 id，整条消息快照替换，index 稳定
        <MessagePart key={index} part={part} />
      ))}
      {message.errorMessage && (
        <p className="text-sm text-destructive whitespace-pre-wrap">{message.errorMessage}</p>
      )}
    </div>
  );
}

function MessagePart({ part }: { part: ProjectedPart }) {
  switch (part.type) {
    case 'text':
      return part.text ? <p className="text-sm whitespace-pre-wrap">{part.text}</p> : null;
    case 'thinking':
      return part.text ? (
        <p className="text-xs text-muted-foreground italic whitespace-pre-wrap">{part.text}</p>
      ) : null;
    case 'toolCall':
      return (
        <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {part.name}
        </p>
      );
    default:
      return null;
  }
}

const textOf = (parts: ProjectedPart[]): string =>
  parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
