import { secretaryReportImageUrl } from '@shared/localImage';
import { reportTextForView } from '@shared/secretary/doneReport';
import type { SecretaryDoneReport as DoneReport } from '@shared/types/secretary';
import { GitMerge, GitPullRequest, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { ZoomableImage } from '@/components/chat/ZoomableImage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const PR_STATE = { OPEN: 'PR open', MERGED: 'PR merged', CLOSED: 'PR closed' } as const;
const SECTION_TITLE = 'mb-1.5 text-[12px] font-medium text-muted-foreground';
const TILE = 'aspect-video w-full overflow-hidden rounded-md border border-border bg-muted/40';

/** 已完成条目的「结果」：完成时的汇报、PR 与改动文件、截图缩略图 */
export function SecretaryDoneReport({
  conversationId,
  fallback,
}: {
  conversationId: string;
  fallback?: string;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<DoneReport | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    void window.electronAPI.secretary
      .doneReport(conversationId)
      .then((result) => {
        if (alive) setData(result.ok ? result.result : null);
      })
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const report = data?.report ?? null;
  const text = report?.text ?? fallback;
  // 同名的不可用图可能有好几张：key 按出现次数区分
  const seen = new Map<string, number>();
  const tiles = (report && !report.imagesGone ? report.images : []).map((image) => {
    const base = 'name' in image ? image.name : `missing:${image.label}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { image, key: n > 1 ? `${base}#${n}` : base };
  });
  return (
    <div
      data-enso="session-peek-result"
      className="min-h-0 flex-1 overflow-y-auto border-t px-6 py-4 max-sm:px-4"
    >
      {data === undefined ? (
        <p className="text-[13px] text-muted-foreground">{t('Loading…')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {data?.pr && (
            <div
              data-enso="done-report-pr"
              className="flex flex-wrap items-center gap-2 text-[12.5px]"
            >
              {data.pr.state === 'MERGED' ? (
                <GitMerge className="size-3.5 text-brand" />
              ) : (
                <GitPullRequest className="size-3.5 text-success" />
              )}
              <a
                href={data.pr.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline-offset-2 hover:underline"
              >
                PR #{data.pr.number}
              </a>
              {data.pr.state && (
                <span className="text-muted-foreground">{t(PR_STATE[data.pr.state])}</span>
              )}
              {data.pr.mergeSha && (
                <span
                  data-enso="done-report-sha"
                  title={data.pr.mergeSha}
                  className="rounded bg-muted px-1.5 font-mono text-[11.5px]"
                >
                  {data.pr.mergeSha.slice(0, 7)}
                </span>
              )}
            </div>
          )}
          {text ? (
            <div data-enso="done-report-text" className="min-w-0 text-[13px]">
              <Markdown text={reportTextForView(text)} />
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{t('No report was saved')}</p>
          )}
          {report && report.images.length > 0 && (
            <section data-enso="done-report-images">
              <div className={SECTION_TITLE}>{t('Screenshots')}</div>
              {report.imagesGone ? (
                <p
                  data-enso="done-report-images-gone"
                  className="text-[12.5px] text-muted-foreground"
                >
                  {report.imagesGone === 'expired'
                    ? t('Screenshots expired (kept for 7 days)')
                    : t('Screenshots were cleaned up')}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-2">
                  {tiles.map(({ image, key }) =>
                    'name' in image ? (
                      <figure key={key} className="min-w-0">
                        <ZoomableImage
                          src={secretaryReportImageUrl(conversationId, image.name, report.at)}
                          alt={image.label}
                          title={image.label}
                          lazy
                          frameClassName={cn(TILE, 'block')}
                          className="size-full object-cover"
                        />
                        <figcaption className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {image.label}
                        </figcaption>
                      </figure>
                    ) : (
                      <figure key={key} className="min-w-0">
                        <div
                          data-enso="done-report-missing"
                          className={cn(
                            TILE,
                            'flex flex-col items-center justify-center gap-1 text-[11.5px] text-muted-foreground'
                          )}
                        >
                          <ImageOff className="size-4 opacity-70" />
                          {t('Image unavailable')}
                        </div>
                        <figcaption className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {image.label}
                        </figcaption>
                      </figure>
                    )
                  )}
                </div>
              )}
            </section>
          )}
          {data?.files && data.files.length > 0 && (
            <section data-enso="done-report-files">
              <div className={SECTION_TITLE}>
                {t('Changed files ({{count}})', {
                  count: data.files.length + (data.moreFiles ?? 0),
                })}
              </div>
              <ul className="flex flex-col rounded-md border border-border text-[12px]">
                {data.files.map((file) => (
                  <li
                    key={file.path}
                    data-enso="done-report-file"
                    className="flex min-w-0 items-center gap-2 border-b border-border px-2 py-1 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                      {file.path}
                    </span>
                    {file.additions === null ? (
                      <span className="shrink-0 text-muted-foreground">{t('Binary')}</span>
                    ) : (
                      <span className="shrink-0 font-mono tabular-nums">
                        <span className="text-success">+{file.additions}</span>{' '}
                        <span className="text-destructive">−{file.deletions}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {data.moreFiles ? (
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {t('{{count}} more files', { count: data.moreFiles })}
                </p>
              ) : null}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
