import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** 确认按钮文案(动作动词) */
  confirmLabel: string;
  onConfirm: () => void;
}

/** 危险动作的二次确认弹窗(删除项目/对话、回退等) */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            {t('Cancel')}
          </AlertDialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
