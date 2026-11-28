import EnsoCore
import Foundation
import SwiftUI
import UIKit
import WebKit

/// 负责协调：
/// - 本机嵌入式 `LocalWebServer`（托管打包进 App 的 `WebApp` 静态文件 + `/desk/*` 加密隧道代理）
/// - `WKWebView` 与 `window.__ensoNative` 原生 JS 桥接
/// - `QuicRelayConnection` 多连接管理（iOS 原生 `NWProtocolQUIC` 多流 + 自动网络迁流）
/// - 原生 AVFoundation 二维码扫码与前后台生命周期唤醒
@MainActor
final class EnsoWebShellController: NSObject, ObservableObject {
    /// 固定本地回环端口，确保每次冷启动 WKWebView 的 origin (`http://127.0.0.1:49321`) 恒定，
    /// localStorage（配对设备列表）与 IndexedDB（离线快照/reads 缓存）可跨重启持久化保留。
    private static let defaultLocalPort: UInt16 = 49321

    @Published var isShowingScanner = false
    @Published var startupError: String?

    let webView: WKWebView
    private let bridgeHandler = WeakScriptMessageHandler()
    private var server: LocalWebServer?
    private var quicConnections: [String: QuicRelayConnection] = [:]
    private var pendingDeskFetches: [String: (LocalProxyAsset) -> Void] = [:]
    private var deskFetchSeq: UInt64 = 0
    private var pendingScanCallbackId: String?
    private var started = false

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // 保持持久数据存储（IndexedDB / Cache API / localStorage），不受 iOS Safari 7 天清理影响
        config.websiteDataStore = .default()

        let ucc = WKUserContentController()
        let bootstrapScript = WKUserScript(
            source: Self.nativeBridgeBootstrapJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        ucc.addUserScript(bootstrapScript)
        config.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .systemBackground
        #if DEBUG
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
        #endif
        self.webView = wv
        super.init()
        wv.navigationDelegate = self
        wv.uiDelegate = self

        bridgeHandler.target = self
        ucc.add(bridgeHandler, name: "ensoNative")

        EnsoPushManager.shared.configure { [weak self] sessionId in
            self?.openSessionFromNotification(sessionId)
        }

        let pip = EnsoPiPController.shared
        pip.onStatusChange = { [weak self] status in
            self?.publishPiPStatus(status)
        }
        pip.onRestoreSession = { [weak self] sessionId in
            guard let sessionId, !sessionId.isEmpty else { return }
            self?.openSessionFromNotification(sessionId)
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        server?.stop()
    }

    var pipSourceView: UIView {
        EnsoPiPController.shared.sourceView
    }

    func attachPiPViewIfNeeded() {
        EnsoPiPController.shared.attach(sourceView: pipSourceView)
    }

    private func publishPiPStatus(_ status: EnsoPiPStatusPayload) {
        guard let data = try? JSONEncoder().encode(status),
              let json = String(data: data, encoding: .utf8)
        else { return }
        evalJS("window.__ensoNativeInternal?.onPipState(\(json));")
    }

    func startIfNeeded() {
        guard !started else { return }
        started = true

        guard let webRoot = Bundle.main.url(forResource: "WebApp", withExtension: nil) else {
            startupError = "缺少内嵌 WebApp 资源，请先运行 packages/ios-app/scripts/sync-web.sh 构建前端。"
            return
        }
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("EnsoDeskCache", isDirectory: true)

        let localServer = LocalWebServer(webRoot: webRoot, cacheRoot: cachesDir)
        localServer.deskAssetFetcher = { [weak self] tunnelPath, completion in
            Task { @MainActor [weak self] in
                self?.requestDeskAssetFromWebView(path: tunnelPath, completion: completion)
            }
        }
        do {
            _ = try localServer.start(preferredPort: Self.defaultLocalPort)
            self.server = localServer
            webView.load(URLRequest(url: localServer.baseURL))
        } catch {
            startupError = "启动本地 Web 容器失败：\(error.localizedDescription)"
        }
    }

    /// 支持 Universal Link / `enso://` 深链直达配对或指定会话（小组件 / 灵动岛点击）
    func handleIncomingURL(_ url: URL) {
        guard let base = server?.baseURL else { return }
        if url.scheme == "enso", url.host == "open" {
            if let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let sessionId = comps.queryItems?.first(where: { $0.name == "session" })?.value,
               !sessionId.isEmpty
            {
                openSessionFromNotification(sessionId)
            }
            return
        }
        if url.scheme == "enso" || url.fragment?.contains("pk=") == true {
            var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
            comps?.fragment = url.fragment ?? url.query
            if let target = comps?.url {
                webView.load(URLRequest(url: target))
            }
        }
    }

    func completeQrScan(with payload: String?) {
        isShowingScanner = false
        guard let cbId = pendingScanCallbackId else { return }
        pendingScanCallbackId = nil
        if let payload, let encoded = Self.jsStringLiteral(payload) {
            evalJS("window.__ensoNativeInternal?.resolveScan(\(Self.jsStringLiteral(cbId) ?? "\"\""), \(encoded));")
        } else {
            evalJS("window.__ensoNativeInternal?.resolveScan(\(Self.jsStringLiteral(cbId) ?? "\"\""), null);")
        }
    }

    @objc private func appDidBecomeActive() {
        // iOS 长时间挂起后台可能回收监听端口，先恢复 LocalWebServer 再通知前端重连
        if let server, !server.isRunning {
            _ = try? server.ensureRunning()
        }
        // 切回前台时立即通知前端触发原生 QUIC / WebRTC 探活与重连
        EnsoPiPController.shared.handleDidBecomeActive()
        EnsoPushManager.shared.clearBadge()
        evalJS("window.dispatchEvent(new Event('enso:foreground'));")
    }

    @objc private func appWillResignActive() {
        EnsoPiPController.shared.handleWillResignActive()
    }

    func openSessionFromNotification(_ sessionId: String) {
        guard let sidLit = Self.jsStringLiteral(sessionId) else { return }
        evalJS("window.dispatchEvent(new CustomEvent('enso:open-session', { detail: { sessionId: \(sidLit) } }));")
        // 若当前在主壳页且尚未监听自定义事件，附带 query 参数确保冷启动也可定位会话
        if let url = webView.url, url.path == "/" || url.path == "/index.html" {
            var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var items = comps?.queryItems ?? []
            items.removeAll { $0.name == "session" }
            items.append(URLQueryItem(name: "session", value: sessionId))
            comps?.queryItems = items
            if let target = comps?.url {
                webView.load(URLRequest(url: target))
            }
        }
    }

    @objc private func appDidEnterBackground() {
        // 不能伪造 persisted=false 的 pagehide，否则前端会误以为页面卸载而向桌面发 rpc-bye，
        // 导致切回前台后宿主拒绝续连（resumed=false）并强制重载整个 iframe。
        // 画中画进行中或开启自动画中画时同样只发 enso:background，保持连接继续驱动 PiP 窗口刷新。
        evalJS("window.dispatchEvent(new Event('enso:background'));")
    }

    private func requestDeskAssetFromWebView(path: String, completion: @escaping (LocalProxyAsset) -> Void) {
        deskFetchSeq += 1
        let reqId = "d-\(deskFetchSeq)"
        pendingDeskFetches[reqId] = completion

        // 25s 超时保护，防止代理挂死
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            if let pending = self?.pendingDeskFetches.removeValue(forKey: reqId) {
                pending(LocalProxyAsset(status: 504, mime: "text/plain", body: Data("desk fetch timeout".utf8)))
            }
        }

        guard let idLit = Self.jsStringLiteral(reqId),
              let pathLit = Self.jsStringLiteral(path)
        else {
            pendingDeskFetches.removeValue(forKey: reqId)?(
                LocalProxyAsset(status: 400, mime: "text/plain", body: Data())
            )
            return
        }
        evalJS("if (typeof window.__ensoDeskNativeFetch === 'function') { window.__ensoDeskNativeFetch(\(idLit), \(pathLit)); } else { window.__ensoNative?.replyDeskAsset(\(idLit), 503, 'text/plain', ''); }")
    }

    private func evalJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static func jsStringLiteral(_ value: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let arr = String(data: data, encoding: .utf8),
              arr.count >= 2
        else { return nil }
        return String(arr.dropFirst().dropLast())
    }

    /// 在文档加载前注入 `window.__ensoNative`，与 `packages/phone/src/nativeBridge.ts` 协议严格对齐。
    private static let nativeBridgeBootstrapJS: String = """
    (() => {
      if (window.__ensoNative) return;
      const post = (msg) => window.webkit?.messageHandlers?.ensoNative?.postMessage(msg);
      let openCb = null, controlCb = null, binaryCb = null, closeCb = null;
      const scanResolvers = new Map();
      let scanSeq = 0;
      const pushResolvers = new Map();
      let pushSeq = 0;
      let pipStateCb = null, lastPipState = null;

      window.__ensoNativeInternal = {
        onOpen: (id) => { try { openCb && openCb(id); } catch {} },
        onControl: (id, text) => { try { controlCb && controlCb(id, text); } catch {} },
        onBinary: (id, b64) => { try { binaryCb && binaryCb(id, b64); } catch {} },
        onClose: (id, code, reason) => { try { closeCb && closeCb(id, code, reason); } catch {} },
        resolveScan: (cbId, value) => {
          const fn = scanResolvers.get(cbId);
          scanResolvers.delete(cbId);
          if (fn) fn(value);
        },
        resolvePush: (cbId, result) => {
          const fn = pushResolvers.get(cbId);
          pushResolvers.delete(cbId);
          if (fn) fn(result);
        },
        onPipState: (state) => {
          lastPipState = state;
          try { pipStateCb && pipStateCb(state); } catch {}
        },
      };

      window.__ensoNative = {
        platform: 'ios',
        quic: true,
        deskProxy: true,
        push: true,
        liveActivity: true,
        widgets: true,
        pip: true,
        openQuic: (params) => post({ type: 'quic-open', params }),
        sendQuicText: (id, text) => post({ type: 'quic-send-text', id, text }),
        sendQuicBinary: (id, lane, base64) => post({ type: 'quic-send-binary', id, lane, base64 }),
        closeQuic: (id, code, reason) => post({ type: 'quic-close', id, code: code ?? 1000, reason: reason ?? '' }),
        onQuicOpen: (cb) => { openCb = cb; },
        onQuicControl: (cb) => { controlCb = cb; },
        onQuicBinary: (cb) => { binaryCb = cb; },
        onQuicClose: (cb) => { closeCb = cb; },
        scanQr: () => new Promise((resolve) => {
          const cbId = 's-' + (++scanSeq);
          scanResolvers.set(cbId, resolve);
          post({ type: 'scan-qr', cbId });
        }),
        subscribePush: (vapidPublicKey, gatewayOrigin) => new Promise((resolve) => {
          const cbId = 'p-' + (++pushSeq);
          pushResolvers.set(cbId, resolve);
          post({ type: 'push-subscribe', cbId, vapidPublicKey, gatewayOrigin });
        }),
        unsubscribePush: () => {
          post({ type: 'push-unsubscribe' });
        },
        updateWidgetState: (snapshot) => {
          post({ type: 'widget-update', snapshot });
        },
        startPip: () => post({ type: 'pip-start' }),
        stopPip: () => post({ type: 'pip-stop' }),
        setPipAuto: (enabled) => post({ type: 'pip-set-auto', enabled: Boolean(enabled) }),
        setPipAspect: (aspect) => post({ type: 'pip-set-aspect', aspect: String(aspect || 'portrait') }),
        updatePipState: (snapshot) => post({ type: 'pip-update', snapshot }),
        onPipState: (cb) => {
          pipStateCb = cb;
          if (lastPipState && cb) { try { cb(lastPipState); } catch {} }
        },
        replyDeskAsset: (reqId, status, mime, bodyBase64) => post({
          type: 'desk-asset-reply',
          reqId,
          status,
          mime,
          bodyBase64,
        }),
      };
    })();
    """
}

extension EnsoWebShellController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String
        else { return }

        switch type {
        case "quic-open":
            guard let params = body["params"] as? [String: Any],
                  let id = params["id"] as? String,
                  let host = params["host"] as? String,
                  let portNum = params["port"] as? Int,
                  let port = UInt16(exactly: portNum),
                  let pairId = params["pairId"] as? String,
                  let role = params["role"] as? String,
                  let token = params["token"] as? String
            else { return }
            let alpn = (params["alpn"] as? String) ?? QuicFrameCodec.alpn
            let relayEpoch = params["relayEpoch"] as? String
            let sinceRelaySeq = (params["sinceRelaySeq"] as? NSNumber)?.uint64Value
            let hello = EnsoQuicHello(
                pairId: pairId,
                role: role,
                token: token,
                relayEpoch: relayEpoch,
                sinceRelaySeq: sinceRelaySeq
            )
            let cfg = EnsoQuicConfig(
                id: id,
                host: host,
                port: port,
                alpn: alpn,
                hello: hello,
                allowInsecureSelfSigned: false
            )
            let conn = QuicRelayConnection(config: cfg, delegate: self)
            quicConnections[id]?.close()
            quicConnections[id] = conn
            conn.start()

        case "quic-send-text":
            guard let id = body["id"] as? String,
                  let text = body["text"] as? String
            else { return }
            quicConnections[id]?.sendControlText(text)

        case "quic-send-binary":
            guard let id = body["id"] as? String,
                  let laneStr = body["lane"] as? String,
                  let b64 = body["base64"] as? String,
                  let data = Data(base64Encoded: b64)
            else { return }
            let lane: EnsoQuicLane = laneStr == "bulk" ? .bulk : .ctrl
            quicConnections[id]?.sendBinary(data, lane: lane)

        case "quic-close":
            guard let id = body["id"] as? String else { return }
            let code = (body["code"] as? Int) ?? 1000
            let reason = (body["reason"] as? String) ?? ""
            if let conn = quicConnections.removeValue(forKey: id) {
                conn.close(code: code, reason: reason)
            }

        case "scan-qr":
            guard let cbId = body["cbId"] as? String else { return }
            pendingScanCallbackId = cbId
            isShowingScanner = true

        case "push-subscribe":
            guard let cbId = body["cbId"] as? String,
                  let vapidPublicKey = body["vapidPublicKey"] as? String,
                  let gatewayOrigin = body["gatewayOrigin"] as? String
            else { return }
            Task { @MainActor [weak self] in
                let result = await EnsoPushManager.shared.subscribe(
                    vapidPublicKey: vapidPublicKey,
                    gatewayOrigin: gatewayOrigin
                )
                guard let self,
                      let cbLit = Self.jsStringLiteral(cbId),
                      let data = try? JSONSerialization.data(withJSONObject: result, options: []),
                      let json = String(data: data, encoding: .utf8)
                else { return }
                self.evalJS("window.__ensoNativeInternal?.resolvePush(\(cbLit), \(json));")
            }

        case "push-unsubscribe":
            EnsoPushManager.shared.clearBadge()

        case "widget-update":
            guard let snapshot = body["snapshot"] as? [String: Any] else { return }
            EnsoWidgetBridge.shared.update(from: snapshot)

        case "pip-start":
            EnsoPiPController.shared.start()

        case "pip-stop":
            EnsoPiPController.shared.stop()

        case "pip-set-auto":
            EnsoPiPController.shared.setAutoStart((body["enabled"] as? Bool) ?? false)

        case "pip-set-aspect":
            let raw = body["aspect"] as? String
            EnsoPiPController.shared.setAspect(EnsoPiPAspect(rawOrDefault: raw))

        case "pip-update":
            guard let raw = body["snapshot"] as? [String: Any],
                  JSONSerialization.isValidJSONObject(raw),
                  let data = try? JSONSerialization.data(withJSONObject: raw, options: []),
                  let snapshot = try? JSONDecoder().decode(EnsoPiPSnapshot.self, from: data)
            else { return }
            EnsoPiPController.shared.update(snapshot: snapshot)

        case "desk-asset-reply":
            guard let reqId = body["reqId"] as? String,
                  let status = body["status"] as? Int,
                  let mime = body["mime"] as? String,
                  let b64 = body["bodyBase64"] as? String
            else { return }
            let data = Data(base64Encoded: b64) ?? Data()
            pendingDeskFetches.removeValue(forKey: reqId)?(
                LocalProxyAsset(status: status, mime: mime, body: data)
            )

        default:
            break
        }
    }
}

extension EnsoWebShellController: QuicRelayConnectionDelegate {
    nonisolated func quicConnectionDidOpen(_ id: String) {
        Task { @MainActor [weak self] in
            guard let self, let idLit = Self.jsStringLiteral(id) else { return }
            self.evalJS("window.__ensoNativeInternal?.onOpen(\(idLit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didReceiveControlText text: String) {
        Task { @MainActor [weak self] in
            guard let self,
                  let idLit = Self.jsStringLiteral(id),
                  let textLit = Self.jsStringLiteral(text)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onControl(\(idLit), \(textLit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didReceiveBinaryFrame data: Data, lane: EnsoQuicLane) {
        let b64 = data.base64EncodedString()
        Task { @MainActor [weak self] in
            guard let self,
                  let idLit = Self.jsStringLiteral(id),
                  let b64Lit = Self.jsStringLiteral(b64)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onBinary(\(idLit), \(b64Lit));")
        }
    }

    nonisolated func quicConnection(_ id: String, didCloseWithCode code: Int, reason: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.quicConnections.removeValue(forKey: id)
            guard let idLit = Self.jsStringLiteral(id),
                  let reasonLit = Self.jsStringLiteral(reason)
            else { return }
            self.evalJS("window.__ensoNativeInternal?.onClose(\(idLit), \(code), \(reasonLit));")
        }
    }
}

extension EnsoWebShellController: WKNavigationDelegate, WKUIDelegate {
    private func isLocalAppURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return true }
        return host == "127.0.0.1" || host == "localhost"
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if (scheme == "http" || scheme == "https") && !isLocalAppURL(url) {
            if navigationAction.targetFrame?.isMainFrame != false {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 页面（重）加载后补发一次画中画状态，前端 onPipState 可立即拿到 supported/active/auto
        publishPiPStatus(EnsoPiPController.shared.status)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isLocalAppURL(url) {
                webView.load(navigationAction.request)
            } else {
                UIApplication.shared.open(url)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        guard let presenter = Self.topViewController() else {
            completionHandler()
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let presenter = Self.topViewController() else {
            completionHandler(false)
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        guard let presenter = Self.topViewController() else {
            completionHandler(nil)
            return
        }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        presenter.present(alert, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let keyWindow = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        var top = keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
