import Foundation
import Network

struct NetworkIdentity: Equatable {
  var online: Bool
  var wifi: Bool
  var cellular: Bool
  var wired: Bool

  init(online: Bool, wifi: Bool, cellular: Bool, wired: Bool) {
    self.online = online
    self.wifi = wifi
    self.cellular = cellular
    self.wired = wired
  }

  init(_ path: NWPath) {
    self.init(
      online: path.status == .satisfied,
      wifi: path.usesInterfaceType(.wifi),
      cellular: path.usesInterfaceType(.cellular),
      wired: path.usesInterfaceType(.wiredEthernet)
    )
  }
}
