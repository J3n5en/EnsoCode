import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import SwiftUI

/// 把 SwiftUI 视图离线编码为 IOSurface 支持的 `CMSampleBuffer`（32BGRA + `DisplayImmediately`），
/// 供 `AVSampleBufferDisplayLayer` 驱动系统原生播放画中画（自带左上角 × 关闭按钮与右上角返回按钮）。
///
/// 使用 `ImageRenderer.render(_:)` 直接往 `CVPixelBuffer` 的 `CGContext` 绘制，
/// 绕开 iOS 后台 `ImageRenderer.uiImage` 返回 `nil` 的系统限制。
public enum EnsoPiPFrameEncoder {
    /// 把逻辑尺寸乘以缩放系数并向上对齐到偶数像素，满足视频硬件合成管线的偶尺寸要求。
    public static func pixelDimensions(for logicalSize: CGSize, scale: CGFloat) -> (width: Int, height: Int) {
        let safeScale = max(1, scale)
        let rawW = max(2, Int(ceil(logicalSize.width * safeScale)))
        let rawH = max(2, Int(ceil(logicalSize.height * safeScale)))
        let evenW = rawW % 2 == 0 ? rawW : rawW + 1
        let evenH = rawH % 2 == 0 ? rawH : rawH + 1
        return (evenW, evenH)
    }

    /// 在主线程把任意 SwiftUI 视图编码为立即可展示的 `CMSampleBuffer`。
    @MainActor
    public static func encode<Content: View>(
        view: Content,
        size: CGSize,
        scale: CGFloat = 2.0,
        presentationTime: CMTime = .zero
    ) -> CMSampleBuffer? {
        let (pixelWidth, pixelHeight) = pixelDimensions(for: size, scale: scale)
        let renderer = ImageRenderer(
            content: view.frame(width: size.width, height: size.height)
        )
        renderer.proposedSize = ProposedViewSize(size)
        renderer.scale = max(1, scale)
        renderer.isOpaque = true

        return encodeCanvas(
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            scale: max(1, scale),
            presentationTime: presentationTime
        ) { cgContext in
            renderer.render { _, renderInContext in
                renderInContext(cgContext)
            }
        }
    }

    /// 分配 IOSurface-backed BGRA `CVPixelBuffer`、通过 `CGContext` 绘制并封装为 `CMSampleBuffer`。
    public static func encodeCanvas(
        pixelWidth: Int,
        pixelHeight: Int,
        scale: CGFloat,
        presentationTime: CMTime = .zero,
        draw: (CGContext) -> Void
    ) -> CMSampleBuffer? {
        guard pixelWidth >= 2, pixelHeight >= 2 else { return nil }

        var pixelBuffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
        ]
        let createStatus = CVPixelBufferCreate(
            kCFAllocatorDefault,
            pixelWidth,
            pixelHeight,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &pixelBuffer
        )
        guard createStatus == kCVReturnSuccess, let pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let cgContext = CGContext(
            data: baseAddress,
            width: pixelWidth,
            height: pixelHeight,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo
        ) else { return nil }

        cgContext.scaleBy(x: scale, y: scale)
        draw(cgContext)

        var formatDescription: CMVideoFormatDescription?
        let fmtStatus = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard fmtStatus == noErr, let formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr, let sampleBuffer else { return nil }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0,
           let rawDict = CFArrayGetValueAtIndex(attachments, 0)
        {
            let dict = Unmanaged<CFMutableDictionary>.fromOpaque(rawDict).takeUnretainedValue()
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sampleBuffer
    }
}
