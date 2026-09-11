import SwiftUI

struct RootView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    let palette = model.palette
    ZStack {
      palette.background.ignoresSafeArea()
      if model.device == nil || model.adding {
        PairScreen(
          autoInvite: model.pendingInvite,
          onPaired: { model.addDevice($0) },
          onCancel: model.device == nil ? nil : { model.adding = false }
        )
      } else if model.state == .unauthorized, let device = model.device {
        UnauthorizedView(device: device, others: model.devices.count > 1) {
          model.unpairDevice(device.pairId)
        }
      } else {
        ChatScreen()
        SessionDrawer()
      }
    }
    .foregroundStyle(palette.foreground)
    .tint(palette.info)
    .environment(\.ensoPalette, palette)
    .preferredColorScheme(preferredScheme)
    .sheet(isPresented: $model.composing) {
      NewSessionSheet()
        .environment(\.ensoPalette, palette)
    }
    .sheet(isPresented: $model.configOpen) {
      SessionConfigSheet()
        .environment(\.ensoPalette, palette)
    }
  }

  /// 跟随调色板深浅设置系统外观，保证键盘/选择器等系统控件配色一致
  private var preferredScheme: ColorScheme? {
    switch model.themePreference {
    case .light: return .light
    case .dark: return .dark
    case .auto:
      if model.hostTheme == .light { return .light }
      if model.hostTheme == .dark { return .dark }
      return nil
    }
  }
}

struct UnauthorizedView: View {
  @Environment(\.ensoPalette) var palette
  let device: StoredDevice
  let others: Bool
  let onRemove: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "iphone")
        .font(.system(size: 32))
        .foregroundStyle(palette.mutedForeground)
      Text("配对已失效")
        .font(.system(size: EnsoFont.xl, weight: .medium))
      Text(others ? "「\(device.label)」已解绑此设备，可移除它并切到其他电脑。" : "「\(device.label)」已解绑此设备，请重新扫码配对。")
        .font(.system(size: EnsoFont.base))
        .foregroundStyle(palette.mutedForeground)
        .multilineTextAlignment(.center)
      Button(others ? "移除此配对" : "重新配对", action: onRemove)
        .font(.system(size: EnsoFont.base, weight: .medium))
        .foregroundStyle(palette.primaryForeground)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(palette.primary)
        .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
    }
    .padding(.horizontal, 24)
  }
}
