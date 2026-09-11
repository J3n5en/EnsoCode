import SwiftUI
import UIKit

enum ThemePreference: String, CaseIterable {
  case auto, light, dark
  var label: String {
    switch self {
    case .auto: return "跟随桌面"
    case .light: return "浅"
    case .dark: return "深"
    }
  }
}

/// 与 PWA（packages/phone/src/styles.css）同源的 oklch 设计令牌，
/// 经 canvas 换算为精确 sRGB。改色时两边同步。
struct EnsoPalette: Equatable {
  var isDark: Bool
  var background: Color
  var foreground: Color
  var card: Color
  var primary: Color
  var primaryForeground: Color
  var secondary: Color
  var secondaryForeground: Color
  var muted: Color
  var mutedForeground: Color
  var accent: Color
  var destructive: Color
  var success: Color
  var warning: Color
  var info: Color
  var border: Color
  var ring: Color

  static let light = EnsoPalette(
    isDark: false,
    background: Color(rgb: (255, 255, 255)),
    foreground: Color(rgb: (9, 9, 16)),
    card: Color(rgb: (255, 255, 255)),
    primary: Color(rgb: (22, 22, 29)),
    primaryForeground: Color(rgb: (250, 250, 250)),
    secondary: Color(rgb: (243, 243, 245)),
    secondaryForeground: Color(rgb: (22, 22, 29)),
    muted: Color(rgb: (243, 243, 245)),
    mutedForeground: Color(rgb: (114, 114, 123)),
    accent: Color(rgb: (243, 243, 245)),
    destructive: Color(rgb: (231, 0, 11)),
    success: Color(rgb: (0, 130, 54)),
    warning: Color(rgb: (254, 153, 0)),
    info: Color(rgb: (43, 127, 255)),
    border: Color(rgb: (229, 229, 231)),
    ring: Color(rgb: (160, 160, 169))
  )

  static let dark = EnsoPalette(
    isDark: true,
    background: Color(rgb: (9, 9, 16)),
    foreground: Color(rgb: (250, 250, 250)),
    card: Color(rgb: (9, 9, 16)),
    primary: Color(rgb: (250, 250, 250)),
    primaryForeground: Color(rgb: (22, 22, 29)),
    secondary: Color(rgb: (37, 37, 45)),
    secondaryForeground: Color(rgb: (250, 250, 250)),
    muted: Color(rgb: (37, 37, 45)),
    mutedForeground: Color(rgb: (160, 160, 169)),
    accent: Color(rgb: (37, 37, 45)),
    destructive: Color(rgb: (130, 24, 26)),
    success: Color(rgb: (0, 130, 54)),
    warning: Color(rgb: (254, 153, 0)),
    info: Color(rgb: (43, 127, 255)),
    border: Color(rgb: (37, 37, 45)),
    ring: Color(rgb: (81, 81, 90))
  )

  /// sync-terminal：整套 UI 配色由终端调色板推导（与桌面同语义）
  static func from(terminal: TerminalPalette) -> EnsoPalette {
    let base = dark
    let bg = Color(css: terminal.background) ?? base.background
    let fg = Color(css: terminal.foreground) ?? base.foreground
    let muted = Color(css: terminal.brightBlack) ?? base.muted
    let dark = bg.luminance < 0.5
    return EnsoPalette(
      isDark: dark,
      background: bg,
      foreground: fg,
      card: bg,
      primary: dark ? fg : Color(rgb: (22, 22, 29)),
      primaryForeground: dark ? Color(rgb: (22, 22, 29)) : fg,
      secondary: muted.opacity(0.4),
      secondaryForeground: fg,
      muted: muted.opacity(0.45),
      mutedForeground: fg.opacity(0.7),
      accent: muted.opacity(0.4),
      destructive: base.destructive,
      success: base.success,
      warning: base.warning,
      info: Color(css: terminal.brightBlue) ?? base.info,
      border: muted.opacity(0.5),
      ring: fg.opacity(0.4)
    )
  }
}

/// PWA 字号阶梯（html font-size:15px 下的 rem 已换算成 pt）
enum EnsoFont {
  static let xs: CGFloat = 11      // text-[11px]
  static let sm: CGFloat = 12      // text-xs
  static let md: CGFloat = 13      // 介于 xs/sm
  static let base: CGFloat = 14    // text-sm
  static let lg: CGFloat = 15      // text-base
  static let xl: CGFloat = 18      // text-lg

  static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }
}

enum EnsoRadius {
  static let sm: CGFloat = 4
  static let md: CGFloat = 6
  static let lg: CGFloat = 8
  static let xl: CGFloat = 12
  static let xxl: CGFloat = 16
}

extension Color {
  init(rgb: (Int, Int, Int)) {
    self.init(
      red: Double(rgb.0) / 255,
      green: Double(rgb.1) / 255,
      blue: Double(rgb.2) / 255
    )
  }

  var luminance: Double {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
    return 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
  }

  init?(css: String) {
    let s = css.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") {
      var hex = String(s.dropFirst())
      if hex.count == 3 {
        hex = hex.map { "\($0)\($0)" }.joined()
      }
      guard hex.count == 6, let n = UInt32(hex, radix: 16) else { return nil }
      self.init(
        red: Double((n >> 16) & 0xff) / 255,
        green: Double((n >> 8) & 0xff) / 255,
        blue: Double(n & 0xff) / 255
      )
      return
    }
    if s.hasPrefix("rgb") {
      let nums = s.split(whereSeparator: { !$0.isNumber && $0 != "." }).compactMap { Double($0) }
      guard nums.count >= 3 else { return nil }
      self.init(red: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255)
      return
    }
    return nil
  }
}

enum ThemeResolver {
  static func resolve(
    preference: ThemePreference,
    host: HostAppearance,
    terminal: TerminalPalette?,
    systemDark: Bool
  ) -> EnsoPalette {
    switch preference {
    case .light: return .light
    case .dark: return .dark
    case .auto:
      if host == .syncTerminal, let terminal { return .from(terminal: terminal) }
      if host == .light { return .light }
      if host == .dark { return .dark }
      return systemDark ? .dark : .light
    }
  }
}

/// 调色板注入环境，组件经 @Environment(\.ensoPalette) 取用
private struct EnsoPaletteKey: EnvironmentKey {
  static let defaultValue: EnsoPalette = .light
}

extension EnvironmentValues {
  var ensoPalette: EnsoPalette {
    get { self[EnsoPaletteKey.self] }
    set { self[EnsoPaletteKey.self] = newValue }
  }
}

/// 半透明分隔线（PWA 的 border-b 是 1px border，不是系统 Divider）
struct EnsoDivider: View {
  @Environment(\.ensoPalette) var palette
  var body: some View {
    palette.border.frame(height: 1.0 / UIScreen.main.scale)
  }
}
