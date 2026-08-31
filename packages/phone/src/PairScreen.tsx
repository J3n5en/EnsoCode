import { claimPairing, type PairedDevice, parsePairUri } from '@enso/pair';

import { Camera, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createQrScanner } from './qr';

/** 扫到的内容是否是配对码（能解析出 relay + 公钥即可） */
function isPairPayload(value: string): boolean {
  try {
    parsePairUri(value);
    return true;
  } catch {
    return false;
  }
}

/** 配对页：扫码或粘贴配对码。BarcodeDetector 可用则用摄像头，否则手工粘贴。 */
export function PairScreen({
  onPaired,
  autoInvite,
  onCancel,
}: {
  onPaired: (device: PairedDevice) => void;
  /** 扫码直达时从地址栏取到的邀请链接，挂载后自动完成配对 */
  autoInvite?: string | null;
  /** 已配对状态下添加新电脑时提供：显示返回按钮 */
  onCancel?: () => void;
}) {
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopScan = () => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setScanning(false);
  };
  const pair = async (raw: string) => {
    setBusy(true);
    setError(null);
    try {
      const invite = parsePairUri(raw);
      const deviceName = /iPhone|iPad|Android/i.exec(navigator.userAgent)?.[0] ?? 'Phone';
      const result = await claimPairing(invite.relay, invite.publicKey, deviceName);
      onPaired({
        pairId: result.pairId,
        token: result.deviceToken,
        contentKey: btoa(String.fromCharCode(...result.contentKey))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, ''),
        deviceName,
        relayUrl: invite.relay,
        pairedAt: Date.now(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 扫码直达：地址栏带邀请时直接配对，用户无需再点任何按钮
  const autoRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoInvite 是触发信号，只跑一次
  useEffect(() => {
    if (!autoInvite || autoRef.current) return;
    autoRef.current = true;
    void pair(autoInvite);
  }, [autoInvite]);

  // 扫到码后的动作：effect 只依赖 scanning，经 ref 取最新实现，避免依赖抖动导致重挂
  const onDetectedRef = useRef<(value: string) => void>(() => {});
  onDetectedRef.current = (value: string) => {
    stopScan();
    void pair(value);
  };

  const startScan = async () => {
    setError(null);
    try {
      // 只负责拿流；挂到 <video> 与解码循环交给下面的 effect——
      // setScanning 是异步的，此刻 <video> 还没挂载，直接读 ref 必然为 null
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      setScanning(true);
    } catch (e) {
      // 非 HTTPS / 非 localhost 时 getUserMedia 不可用，提示要具体
      setError(
        !window.isSecureContext
          ? '扫码需要 HTTPS 环境，请改用粘贴配对码'
          : e instanceof DOMException && e.name === 'NotAllowedError'
            ? '摄像头权限被拒绝，请在浏览器设置中允许后重试'
            : '无法访问摄像头，请粘贴配对码'
      );
      setScanning(false);
    }
  };

  // 进入扫码态后 <video> 才存在，此时才能挂流并起解码循环
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    let cancelled = false;
    let raf = 0;
    video.srcObject = stream;
    // iOS 要求静音才允许内联自动播放；React 的 muted 属性有时不落到 DOM，显式再设一次
    video.muted = true;

    void (async () => {
      try {
        await video.play();
        const scanner = await createQrScanner();
        const tick = async () => {
          if (cancelled || !streamRef.current) return;
          try {
            const value = await scanner.scan(video);
            // 兼容两种码：桌面新版发 https 链接（系统相机也能直接打开），旧版是 enso:// scheme
            if (value && isPairPayload(value)) {
              onDetectedRef.current(value);
              return;
            }
          } catch {}
          raf = requestAnimationFrame(() => void tick());
        };
        await tick();
      } catch {
        if (!cancelled) setError('无法开始预览，请粘贴配对码');
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [scanning]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 pt-safe pb-safe">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <Smartphone className="h-8 w-8 text-muted-foreground" />
        <h1 className="font-medium text-lg">连接到 EnsoCode</h1>
        <p className="text-muted-foreground text-sm">
          在桌面端「设置 → 手机」生成配对码，扫码或粘贴。
        </p>
      </div>

      {scanning ? (
        <div className="w-full max-w-sm space-y-2">
          <video
            ref={videoRef}
            playsInline
            muted
            className="aspect-square w-full rounded-lg bg-black object-cover"
          />
          <Button variant="outline" className="w-full" onClick={stopScan}>
            取消扫码
          </Button>
        </div>
      ) : (
        <Button className="w-full max-w-sm" onClick={() => void startScan()}>
          <Camera className="mr-1.5 h-4 w-4" />
          扫描二维码
        </Button>
      )}

      <div className="flex w-full max-w-sm items-center gap-2">
        <Input
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="enso://pair?relay=…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button
          variant="outline"
          className="shrink-0"
          disabled={busy || !uri.trim()}
          onClick={() => void pair(uri.trim())}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : '配对'}
        </Button>
      </div>

      {error && <p className="max-w-sm text-center text-destructive text-xs">{error}</p>}

      {onCancel && (
        <Button variant="ghost" className="w-full max-w-sm" onClick={onCancel}>
          返回
        </Button>
      )}
    </div>
  );
}
