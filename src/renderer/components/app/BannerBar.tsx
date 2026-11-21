import type { ReactNode } from 'react';

/** 更新横幅的条形外壳；最小化的重启等待条复用同一位置与样式 */
export function BannerBar({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-blue-500/20 bg-background">
      <div className="flex items-center gap-2 bg-blue-500/8 px-4 py-1.5 text-xs">{children}</div>
    </div>
  );
}
