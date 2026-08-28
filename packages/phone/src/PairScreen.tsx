import { claimPairing, type PairedDevice, parsePairUri } from '@enso/pair';
import { Camera, Loader2, Smartphone } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createQrScanner } from './qr';

/** 配对页：扫码或粘贴配对码。BarcodeDetector 可用则用摄像头，否则手工粘贴。 */
export function PairScreen({ onPaired }: { onPaired: (device: PairedDevice) => void }) {
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

  const startScan = async () => {
    setError(null);
    try {
      // 先要摄像头再建解码器：权限被拒时不必白白加载 jsQR
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // iOS 要求 playsInline + muted 才能内联播放（已在 JSX 上声明）
      await video.play();
      const scanner = await createQrScanner();
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const value = await scanner.scan(video);
          if (value?.startsWith('enso://pair')) {
            stopScan();
            await pair(value);
            return;
          }
        } catch {}
        requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch (e) {
      // 非 HTTPS / 非 localhost 时 getUserMedia 不可用，提示要具体
      const insecure = !window.isSecureContext;
      setError(
        insecure
          ? '扫码需要 HTTPS 环境，请改用粘贴配对码'
          : e instanceof DOMException && e.name === 'NotAllowedError'
            ? '摄像头权限被拒绝，请在浏览器设置中允许后重试'
            : '无法访问摄像头，请粘贴配对码'
      );
      setScanning(false);
    }
  };

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
    </div>
  );
}
