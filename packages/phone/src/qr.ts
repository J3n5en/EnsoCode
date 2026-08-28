/**
 * 二维码扫描：优先用原生 BarcodeDetector（Android Chrome 有，零开销），
 * 不可用时懒加载 jsQR 兜底 —— Safari / 所有 iOS 浏览器都没有 BarcodeDetector，
 * 而 iPhone 恰是本功能的主要场景。
 */

export interface QrScanner {
  /** 从当前视频帧解出二维码内容；未识别返回 null */
  scan(video: HTMLVideoElement): Promise<string | null>;
}

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

function nativeScanner(): QrScanner | null {
  const Detector = (globalThis as { BarcodeDetector?: new (o: object) => NativeDetector })
    .BarcodeDetector;
  if (!Detector) return null;
  const detector = new Detector({ formats: ['qr_code'] });
  return {
    async scan(video) {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue ?? null;
    },
  };
}

/** jsQR 走 canvas 取像素，尺寸压到 640 长边以控制单帧解码耗时 */
async function fallbackScanner(): Promise<QrScanner> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async scan(video) {
      if (!ctx || !video.videoWidth) return null;
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    },
  };
}

export async function createQrScanner(): Promise<QrScanner> {
  return nativeScanner() ?? (await fallbackScanner());
}
