import SwiftUI

@main
struct EnsoCodePhoneApp: App {
  @StateObject private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
        .onAppear { model.start() }
        .onOpenURL { model.handleIncomingURL($0) }
        .onChange(of: scenePhase) { _, phase in model.scenePhase(phase) }
        .onChange(of: model.catalog.count) { _, _ in model.onAppearSelectFirst() }
        .onChange(of: model.syncing) { _, _ in model.updateBannerFlash() }
        .onChange(of: model.state) { _, _ in model.updateBannerFlash() }
        .preferredColorScheme(model.palette.isDark ? .dark : .light)
    }
  }
}
