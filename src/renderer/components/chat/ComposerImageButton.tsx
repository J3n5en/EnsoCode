import { ImagePlus } from 'lucide-react';
import { useRef } from 'react';
import { useI18n } from '@/i18n';
import { insertComposerImage } from './composerMentionBridge';

/** 工具行「添加图片」。选中后逐张读成 base64，经 Composer 已注册的桥接插入。 */
export function ComposerImageButton({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          for (const file of Array.from(event.target.files ?? [])) {
            if (!file.type.startsWith('image/')) continue;
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result !== 'string') return;
              const base64 = reader.result.slice(reader.result.indexOf(',') + 1);
              insertComposerImage({ data: base64, mimeType: file.type });
            };
            reader.readAsDataURL(file);
          }
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label={t('Attach image')}
        title={t('Attach image')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 max-md:size-[32px]"
      >
        <ImagePlus className="h-3.5 w-3.5" />
      </button>
    </>
  );
}
