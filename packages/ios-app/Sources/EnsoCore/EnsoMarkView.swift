#if canImport(SwiftUI)
import SwiftUI

/// 对应 macOS 菜单栏 `build/trayTemplate.svg` 的 EnsoCode 圆相（Ensō）矢量图标。
/// SVG 原始参数：viewBox 64x64，圆心 (32, 32)，半径 18.24，线宽 8.32，
/// 弧线从 67.57° 顺时针绕 320° 至 27.43°，右下角留出约 40° 缺口。
public struct EnsoArcShape: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let strokeWidth = side * (8.32 / 44.8)
        let radius = max(1, (side - strokeWidth) / 2)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        var path = Path()
        // SwiftUI 屏幕坐标系 y 向下，clockwise: false 表示角度递增（屏幕顺时针）绘制 320° 大弧
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(67.57),
            endAngle: .degrees(27.43),
            clockwise: false
        )
        return path
    }
}

public enum EnsoMarkBadge: Sendable {
    case none
    case pending
    case done
}

public struct EnsoMarkView: View {
    public let size: CGFloat
    public let color: Color
    public var badge: EnsoMarkBadge

    public init(size: CGFloat, color: Color, badge: EnsoMarkBadge = .none) {
        self.size = size
        self.color = color
        self.badge = badge
    }

    public var body: some View {
        let strokeWidth = max(1.8, size * (8.32 / 44.8))
        ZStack {
            EnsoArcShape()
                .stroke(
                    color,
                    style: StrokeStyle(
                        lineWidth: strokeWidth,
                        lineCap: .round,
                        lineJoin: .round
                    )
                )

            if badge == .pending {
                // 嵌在圆相右下角 47.5° 缺口中心，既保留 Enso 轮廓又清晰提示待审批
                let dotSize = max(3.2, strokeWidth * 1.05)
                let orbit = (size - strokeWidth) / 2
                let rad = 47.5 * Double.pi / 180.0
                Circle()
                    .fill(color)
                    .frame(width: dotSize, height: dotSize)
                    .offset(x: CGFloat(cos(rad)) * orbit, y: CGFloat(sin(rad)) * orbit)
            } else if badge == .done {
                let dotSize = max(3.0, strokeWidth * 0.95)
                let orbit = (size - strokeWidth) / 2
                let rad = 47.5 * Double.pi / 180.0
                Circle()
                    .fill(color)
                    .frame(width: dotSize, height: dotSize)
                    .offset(x: CGFloat(cos(rad)) * orbit, y: CGFloat(sin(rad)) * orbit)
            }
        }
        .frame(width: size, height: size)
    }
}
#endif
