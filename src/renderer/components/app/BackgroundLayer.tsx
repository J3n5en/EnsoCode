import { isVideoPath, toLocalImageUrl, toRemoteImageProxyUrl } from '@shared/localImage';
import * as React from 'react';
import { holesClipPath } from '@/lib/backgroundClip';
import type { BackgroundSizeMode } from '@/stores/settings';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';

/**
 * 背景层：绝对定位铺满主窗口最底层（z-index:-1 + pointer-events:none），
 * 不拦截任何交互。前景面板的半透明由 useBackgroundImage() 负责。
 *
 * 不管有没有开壁纸都常驻一层实心主题底色（body 必须保持透明），
 * 浏览器 guest 矩形用 clip-path 挖掉——guest 沉到 workbench 之下时（锁定/被浮层压住）
 * 才能透出来，其余区域照常铺底色/壁纸。
 *
 * - file 模式：本地路径经 local-image:// 协议加载
 * - folder 模式：files.listMedia 枚举目录后随机选一张；定时/手动刷新时重新随机
 * - url 模式：经 local-image://remote-fetch 主进程代理加载；刷新时以 nonce 绕开缓存
 */

const SIZE_MODE_STYLES: Record<BackgroundSizeMode, React.CSSProperties> = {
  cover: { backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' },
  contain: {
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  repeat: { backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'top left' },
  center: { backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' },
};

export function BackgroundLayer() {
  const enabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const sourceType = useSettingsStore((s) => s.backgroundSourceType);
  const imagePath = useSettingsStore((s) => s.backgroundImagePath);
  const folderPath = useSettingsStore((s) => s.backgroundFolderPath);
  const urlPath = useSettingsStore((s) => s.backgroundUrlPath);
  const randomEnabled = useSettingsStore((s) => s.backgroundRandomEnabled);
  const randomInterval = useSettingsStore((s) => s.backgroundRandomInterval);
  const blur = useSettingsStore((s) => s.backgroundBlur);
  const brightness = useSettingsStore((s) => s.backgroundBrightness);
  const saturation = useSettingsStore((s) => s.backgroundSaturation);
  const sizeMode = useSettingsStore((s) => s.backgroundSizeMode);
  const refreshNonce = useSettingsStore((s) => s.backgroundRefreshNonce);

  // 换图信号 = 手动刷新（nonce 经多窗口同步传来）+ 定时器；tick 单调递增兼作缓存 buster
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (refreshNonce > 0) setTick((t) => t + 1);
  }, [refreshNonce]);

  React.useEffect(() => {
    if (!enabled || !randomEnabled || sourceType === 'file') return;
    const ms = Math.max(5, randomInterval) * 1000;
    const timer = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => window.clearInterval(timer);
  }, [enabled, randomEnabled, randomInterval, sourceType]);

  // folder 模式：每次换图信号都重新枚举（顺带感知目录里新增的文件）
  const [folderFiles, setFolderFiles] = React.useState<string[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 专门用于触发重新枚举/重新随机
  React.useEffect(() => {
    if (!enabled || sourceType !== 'folder' || !folderPath) {
      setFolderFiles([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.files.listMedia(folderPath).then((files) => {
      if (!cancelled) setFolderFiles(files);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, sourceType, folderPath, tick]);

  // 随机选图：多于一张时避开当前这张，保证「刷新」肉眼可见
  const [folderPick, setFolderPick] = React.useState('');
  React.useEffect(() => {
    if (folderFiles.length === 0) {
      setFolderPick('');
      return;
    }
    setFolderPick((prev) => {
      if (folderFiles.length === 1) return folderFiles[0];
      const candidates = folderFiles.filter((file) => file !== prev);
      return candidates[Math.floor(Math.random() * candidates.length)];
    });
  }, [folderFiles]);

  return (
    <BackgroundShell>
      {enabled && (
        <BackgroundMedia
          state={{
            sourceType,
            imagePath,
            folderPick,
            urlPath,
            tick,
            blur,
            brightness,
            saturation,
            sizeMode,
          }}
        />
      )}
    </BackgroundShell>
  );
}

function BackgroundShell({ children }: { children: React.ReactNode }) {
  const holes = useSidePanelStore((s) => s.browserHoles);
  const clipPath = holesClipPath(Object.values(holes));
  return (
    <div
      aria-hidden
      data-slot="background-layer"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={{
        clipPath,
        // 实心底：用原始令牌（--background），不能用会被重映射成半透明的 --color-background
        backgroundColor: 'var(--background)',
      }}
    >
      {children}
    </div>
  );
}

interface MediaState {
  sourceType: string;
  imagePath: string;
  folderPick: string;
  urlPath: string;
  tick: number;
  blur: number;
  brightness: number;
  saturation: number;
  sizeMode: BackgroundSizeMode;
}

function BackgroundMedia({ state }: { state: MediaState }) {
  const {
    sourceType,
    imagePath,
    folderPick,
    urlPath,
    tick,
    blur,
    brightness,
    saturation,
    sizeMode,
  } = state;

  // 目标源解析
  const target = React.useMemo(() => {
    if (sourceType === 'file' && imagePath) {
      return { src: toLocalImageUrl(imagePath), video: isVideoPath(imagePath) };
    }
    if (sourceType === 'folder' && folderPick) {
      return { src: toLocalImageUrl(folderPick), video: isVideoPath(folderPick) };
    }
    if (sourceType === 'url') {
      const trimmed = urlPath.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        return { src: toRemoteImageProxyUrl(trimmed, tick), video: isVideoPath(trimmed) };
      }
    }
    return null;
  }, [sourceType, imagePath, folderPick, urlPath, tick]);

  // 先预加载再切换：下载/解码期间继续展示旧图，避免露底空隙（尤其网络图）
  const [display, setDisplay] = React.useState<{ src: string; video: boolean } | null>(null);
  React.useEffect(() => {
    if (!target) {
      setDisplay(null);
      return;
    }
    if (target.video) {
      setDisplay(target);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setDisplay(target);
    };
    // 加载失败保留旧图，不切空
    img.src = target.src;
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!display) return null;
  const { src, video } = display;

  const filter = `blur(${blur}px) brightness(${brightness}) saturate(${saturation})`;
  // 模糊会在边缘产生透明晕边，内层向外扩 2×blur 再被外层裁掉
  const bleed = blur > 0 ? `-${blur * 2}px` : '0';

  return (
    <>
      {video ? (
        <video
          key={src}
          src={src}
          autoPlay
          loop
          muted
          playsInline
          className="absolute"
          style={{
            inset: bleed,
            width: 'auto',
            height: 'auto',
            minWidth: '100%',
            minHeight: '100%',
            objectFit: sizeMode === 'contain' ? 'contain' : 'cover',
            filter,
            transition: 'filter 0.3s ease',
          }}
        />
      ) : (
        <div
          key={src}
          className="absolute"
          style={{
            inset: bleed,
            backgroundImage: `url("${src}")`,
            ...SIZE_MODE_STYLES[sizeMode],
            filter,
            transition: 'filter 0.3s ease',
          }}
        />
      )}
    </>
  );
}
