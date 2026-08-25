import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 复制按钮（✓ 反馈 1s）；text 支持惰性取值（表格等渲染时才序列化） */
export function CopyButton({
  text,
  className,
}: {
  text: string | (() => string);
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const value = typeof text === 'function' ? text() : text;
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        });
      }}
      className={cn('flex items-center gap-1 transition-colors hover:text-foreground', className)}
      title={t('Copy')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
