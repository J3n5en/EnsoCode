import type { RegistryNotice } from '@shared/extensionPlugins/types';
import { Button } from '@/components/ui/button';

/** 清除提示要写盘，远端不可用；远端只显示指引 */
export function RegistryNoticeBanner(props: {
  notice: RegistryNotice;
  remote: boolean;
  onDismiss: () => void;
}) {
  const { notice, remote, onDismiss } = props;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-700 text-sm dark:text-amber-400">
      {notice.unreadable && (
        <p>
          插件登记表曾读取失败，下面的列表可能不全。插件文件没有删除，原文保存在数据目录的
          extension-plugins/registry.json.unreadable。
        </p>
      )}
      {notice.discarded.length > 0 && (
        <p>
          检测到旧格式的登记记录，已丢弃并清理，请重新安装：
          <span className="font-mono">{notice.discarded.join(', ')}</span>
        </p>
      )}
      {remote ? (
        <p className="text-muted-foreground">
          请在桌面端点「知道了」，或运行 enso-server plugin notice-dismiss 清除此提示。
        </p>
      ) : (
        <Button size="sm" variant="outline" onClick={onDismiss}>
          知道了
        </Button>
      )}
    </div>
  );
}
