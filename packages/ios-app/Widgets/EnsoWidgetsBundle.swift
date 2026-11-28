import SwiftUI
import WidgetKit

@main
struct EnsoWidgetsBundle: WidgetBundle {
    var body: some Widget {
        EnsoStatusWidget()
        if #available(iOS 16.1, *) {
            EnsoLiveActivityWidget()
        }
    }
}
