import { secretaryReportImageUrl } from '@shared/localImage';
import { reportTextForView } from '@shared/secretary/doneReport';
import type {
  SecretaryDoneReport as DoneReport,
  SecretaryStoredReport,
} from '@shared/types/secretary';
import { Clock, GitMerge, GitPullRequest, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { ZoomableImage } from '@/components/chat/ZoomableImage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { GoalResultFacts } from './GoalResultFacts';

const PR_STATE = { OPEN: 'PR open', MERGED: 'PR merged', CLOSED: 'PR closed' } as const;
const SECTION_TITLE = 'mb-1.5 text-[12px] font-medium text-muted-foreground';
const TILE = 'aspect-video w-full overflow-hidden rounded-md border border-border bg-muted/40';
const PLACEHOLDER = cn(
  TILE,
  'flex flex-col items-center justify-center gap-1 text-[11.5px] text-muted-foreground'
);

const pad = (n: number) => String(n).padStart(2, '0');
const day = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const minute = (at: number) => {
  const date = new Date(at);
  return `${day(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 「完成于 11-21 18:05，保留 7 天，已于 11-28 清理」 */
function goneDetail(
  t: ReturnType<typeof useI18n>['t'],
  report: SecretaryStoredReport,
  reason: 'expired' | 'cleared'
): string {
  const done = minute(report.at);
  if (report.imagesGoneAt === undefined) return t('Completed {{done}}', { done });
  const gone = day(report.imagesGoneAt);
  return reason === 'expired' && report.retentionDays
    ? t('Completed {{done}}, kept for {{days}} days, cleaned up on {{gone}}', {
        done,
        days: report.retentionDays,
        gone,
      })
    : t('Completed {{done}}, cleaned up on {{gone}}', { done, gone });
}

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
  // 副本读不出来（格式不对、被外部删掉）的按无法显示处理
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setBroken(new Set());
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
  const images = report?.images ?? [];
  const gone = images.flatMap((image) => ('gone' in image && image.gone ? [image.gone] : []));
  const allGone =
    gone.length > 0 && images.every((image) => !('name' in image) || Boolean(image.gone));
  const goneReason = gone.includes('expired') ? 'expired' : 'cleared';
  // 同名的不可用图可能有好几张：key 按出现次数区分
  const seen = new Map<string, number>();
  const tiles = images
    .filter((image) => !(allGone && 'gone' in image && image.gone))
    .map((image) => {
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
          {report?.goalResult && <GoalResultFacts view={report.goalResult} detail />}
          {text ? (
            <div data-enso="done-report-text" className="min-w-0 text-[13px]">
              <Markdown text={reportTextForView(text)} />
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{t('No report was saved')}</p>
          )}
          {report && images.length > 0 && (
            <section data-enso="done-report-images">
              <div className={SECTION_TITLE}>{t('Screenshots')}</div>
              {allGone && (
                <div
                  data-enso="done-report-images-gone"
                  className="flex items-center gap-3 rounded-md border border-dashed border-border bg-muted/40 px-4 py-3"
                >
                  <ImageOff className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">
                      {goneReason === 'expired'
                        ? t('{{count}} screenshots expired', { count: gone.length })
                        : t('{{count}} screenshots were cleaned up', { count: gone.length })}
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {goneDetail(t, report, goneReason)}
                    </div>
                  </div>
                </div>
              )}
              {tiles.length > 0 && (
                <div className={cn('grid grid-cols-3 gap-2 max-sm:grid-cols-2', allGone && 'mt-2')}>
                  {tiles.map(({ image, key }) => {
                    const caption = (
                      <figcaption className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {image.label}
                      </figcaption>
                    );
                    if ('name' in image && image.gone)
                      return (
                        <figure key={key} className="min-w-0">
                          <div
                            data-enso="done-report-expired"
                            title={goneDetail(t, report, image.gone)}
                            className={PLACEHOLDER}
                          >
                            <Clock className="size-4 opacity-70" />
                            {image.gone === 'expired' ? t('Expired') : t('Cleaned up')}
                          </div>
                          {caption}
                        </figure>
                      );
                    if ('name' in image && !broken.has(image.name))
                      return (
                        <figure key={key} className="min-w-0">
                          <ZoomableImage
                            src={secretaryReportImageUrl(conversationId, image.name, report.at)}
                            alt={image.label}
                            title={image.label}
                            lazy
                            frameClassName={cn(TILE, 'block')}
                            className="size-full object-cover"
                            onError={() => setBroken((prev) => new Set(prev).add(image.name))}
                          />
                          {caption}
                        </figure>
                      );
                    return (
                      <figure key={key} className="min-w-0">
                        <div data-enso="done-report-missing" className={PLACEHOLDER}>
                          <ImageOff className="size-4 opacity-70" />
                          {t('Image unavailable')}
                        </div>
                        {caption}
                      </figure>
                    );
                  })}
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
