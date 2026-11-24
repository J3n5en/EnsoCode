import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, useState } from 'react';
import { useI18n } from '@/i18n';
import { copyText } from '@/lib/copyText';

interface Props {
  /** 出错时写进日志与复制内容，指明是哪一块面板 */
  name: string;
  children: ReactNode;
}

interface Failure {
  error: unknown;
  componentStack: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function errorReport(name: string, failure: Failure): string {
  const { error } = failure;
  const head =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return [`[${name}]`, head, failure.componentStack.trim()].filter(Boolean).join('\n');
}

function PanelErrorFallback({
  name,
  failure,
  onRetry,
}: {
  name: string;
  failure: Failure;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div
      data-enso="side-panel-error"
      data-panel={name}
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <AlertTriangle className="size-5 text-warning" />
      <p className="text-[13.5px] font-medium">{t('This panel crashed')}</p>
      <p
        data-enso="side-panel-error-message"
        className="line-clamp-3 max-w-full break-words text-[12px] text-muted-foreground"
      >
        {errorMessage(failure.error)}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          data-enso="side-panel-error-retry"
          onClick={onRetry}
          className="rounded-md bg-foreground px-3 py-1 text-[12px] text-background hover:opacity-90"
        >
          {t('Retry')}
        </button>
        <button
          type="button"
          data-enso="side-panel-error-copy"
          onClick={() => {
            void copyText(errorReport(name, failure)).then(setCopied);
          }}
          className="rounded-md border border-border px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {copied ? t('Copied') : t('Copy error')}
        </button>
      </div>
    </div>
  );
}

/** 侧栏一块面板渲染出错时只在这块里显示原因与重试，不白屏、不拖垮整个窗口 */
export class PanelErrorBoundary extends Component<Props, { failure: Failure | null }> {
  state: { failure: Failure | null } = { failure: null };

  static getDerivedStateFromError(error: unknown): { failure: Failure } {
    return { failure: { error, componentStack: '' } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[side-panel] ${this.props.name} 渲染失败`, error);
    this.setState({ failure: { error, componentStack: info.componentStack ?? '' } });
  }

  render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    return (
      <PanelErrorFallback
        name={this.props.name}
        failure={failure}
        onRetry={() => this.setState({ failure: null })}
      />
    );
  }
}
