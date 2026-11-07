import { type ComponentType, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';

export function httpHomepage(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function PluginReadmeDialog({
  pluginId,
  name,
  from,
  homepage,
  onClose,
}: {
  pluginId: string | null;
  name: string;
  from: 'installed' | 'market';
  homepage?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(httpHomepage(homepage));
  const [MarkdownView, setMarkdownView] = useState<ComponentType<{ text: string }> | null>(null);

  useEffect(() => {
    if (!pluginId) return;
    let alive = true;
    void import('@/components/chat/Markdown').then((mod) => {
      if (alive) setMarkdownView(() => mod.Markdown);
    });
    return () => {
      alive = false;
    };
  }, [pluginId]);

  useEffect(() => {
    if (!pluginId) return;
    let cancelled = false;
    setMarkdown(null);
    setError(null);
    setLink(httpHomepage(homepage));
    void (async () => {
      const api = window.electronAPI.extensionPlugins;
      const primary = await api.readme({ id: pluginId, from });
      let text: string | null = primary.ok ? primary.markdown : null;
      let message: string | null = primary.ok ? null : primary.error;
      if (!primary.ok && from === 'installed') {
        const fallback = await api.readme({ id: pluginId, from: 'market' });
        if (fallback.ok) {
          text = fallback.markdown;
          message = null;
        }
      }
      if (!httpHomepage(homepage)) {
        const list = await api.marketList(false);
        const found = list.ok ? list.plugins.find((plugin) => plugin.id === pluginId) : undefined;
        if (!cancelled) setLink(httpHomepage(found?.homepage));
      }
      if (cancelled) return;
      setMarkdown(text);
      setError(text ? null : message);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, from, homepage]);

  return (
    <Dialog open={pluginId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('Usage guide')}
            {name ? ` · ${name}` : ''}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] space-y-3 overflow-y-auto">
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="text-sm underline">
              {t('Homepage')}
            </a>
          )}
          {error && <p className="text-muted-foreground text-sm">{error}</p>}
          {markdown !== null && MarkdownView && <MarkdownView text={markdown} />}
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
