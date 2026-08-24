import type { ModelProvider } from '@shared/types';
import { Check, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface ModelPickerProps {
  providers: ModelProvider[];
  providerId: string;
  modelId: string;
  onSelect: (providerId: string, modelId: string) => void;
}

/** composer 工具行上的模型选择（ref-chat-b ModelChooser 形状）：pill 触发 + 搜索 + provider 分组列表 */
export function ModelPicker({ providers, providerId, modelId, onSelect }: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');

  const groups = useMemo(
    () =>
      providers
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: (provider.models ?? []).filter(
            (model) =>
              model.enabled !== false &&
              (!keyword ||
                model.id.toLowerCase().includes(keyword.toLowerCase()) ||
                (model.label ?? '').toLowerCase().includes(keyword.toLowerCase()))
          ),
        }))
        .filter((group) => group.models.length > 0),
    [providers, keyword]
  );

  const current = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex h-7 max-w-56 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <span className="truncate">{current?.label ?? modelId ?? t('Model')}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 p-0">
        <div className="border-b p-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('Search models')}
            className="h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {groups.map((group) => (
            <div key={group.id} className="mb-2 last:mb-0">
              <p className="px-1 pb-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                {group.name}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.models.map((model) => {
                  const selected = group.id === providerId && model.id === modelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        onSelect(group.id, model.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        selected
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.label ?? model.id}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              {t('No models found')}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
