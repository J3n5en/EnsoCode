import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { artifactPreviewKind } from './artifacts';
import { decodeUtf8Base64 } from './viewBridge';

function formatByteSize(size: number): string {
  if (!Number.isFinite(size) || size < 1024) return `${Math.max(0, Math.round(size))} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function saveArtifact(artifact: PluginArtifactInfo): Promise<string | null> {
  if (!window.electronAPI.remote) {
    const result = await window.electronAPI.extensionPlugins.artifactSave(artifact.id);
    if (!result.ok) return result.error;
    return null;
  }
  const result = await window.electronAPI.extensionPlugins.artifactRead(artifact.id);
  if (!result.ok) return result.error;
  const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(
    new Blob([bytes], { type: artifact.mime || 'application/octet-stream' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.name;
  link.click();
  URL.revokeObjectURL(url);
  return null;
}

function ArtifactRow({
  artifact,
  onDelete,
}: {
  artifact: PluginArtifactInfo;
  onDelete?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<{ kind: 'text' | 'image'; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = artifactPreviewKind(artifact.mime);

  const open = async () => {
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.extensionPlugins.artifactRead(artifact.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setPreview(null);
      return;
    }
    if (kind === 'image') {
      setPreview({ kind: 'image', body: `data:${result.info.mime};base64,${result.base64}` });
      return;
    }
    if (kind === 'text') {
      setPreview({ kind: 'text', body: decodeUtf8Base64(result.base64) });
      return;
    }
    setPreview(null);
    setError('这个文件不能在这里预览');
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate" title={artifact.name}>
          {artifact.name}
          <span className="ml-2 text-muted-foreground">
            {artifact.mime} · {formatByteSize(artifact.size)}
          </span>
        </span>
        {kind !== 'file' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open()}>
            预览
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void saveArtifact(artifact).then((message) => {
              setBusy(false);
              setError(message);
            });
          }}
        >
          {window.electronAPI.remote ? '下载' : '另存'}
        </Button>
        {onDelete && (
          <Button size="sm" variant="ghost" onClick={() => onDelete(artifact.id)}>
            删除
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {preview?.kind === 'text' && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
          {preview.body}
        </pre>
      )}
      {preview?.kind === 'image' && (
        <img
          src={preview.body}
          alt={artifact.name}
          className="max-h-48 max-w-full rounded border object-contain"
        />
      )}
    </div>
  );
}

export function PluginArtifactList({
  artifacts,
  onDelete,
}: {
  artifacts: PluginArtifactInfo[];
  onDelete?: (id: string) => void;
}) {
  if (artifacts.length === 0)
    return <p className="text-muted-foreground text-xs">还没有产出文件</p>;
  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => (
        <ArtifactRow key={artifact.id} artifact={artifact} onDelete={onDelete} />
      ))}
    </div>
  );
}

/** 插件工具卡片下方的产出 */
export function PluginArtifactsCard({ artifacts }: { artifacts: PluginArtifactInfo[] }) {
  return (
    <div className="mt-1 mb-1.5 ml-[30px] rounded-lg border border-border/70 bg-card px-3 py-2">
      <p className="mb-1 text-[11px] text-muted-foreground">产出文件</p>
      <PluginArtifactList artifacts={artifacts} />
    </div>
  );
}
