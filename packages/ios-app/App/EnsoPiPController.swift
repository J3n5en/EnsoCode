import AVFoundation
import AVKit
import EnsoCore
import SwiftUI
import UIKit

/// 原生画中画（视频通话样式）实时对话窗口：
/// 用户切到其他 App 时把当前会话浮在系统 PiP 窗口里，点 PiP 的还原按钮回到同一会话。
@MainActor
final class EnsoPiPController: NSObject {
    static let shared = EnsoPiPController()

    /// `isPictureInPicturePossible` 迟迟不变为 true 时放弃本次启动的时限。
    private static let startTimeout: Duration = .milliseconds(2500)
    private static let silentWavData: Data = makeSilentWavData()

    let viewModel = EnsoPiPViewModel()

    /// 透明、不拦截触摸的小尺寸行内锚点视图（非全屏，避免关闭自动画中画时被 iOS 误判为全屏视频自动起窗）。
    let sourceView: UIView = {
        let view = UIView()
        view.backgroundColor = .clear
        view.alpha = 1.0
        view.isUserInteractionEnabled = false
        view.isHidden = false
        return view
    }()

    private(set) var phase: EnsoPiPLifecyclePhase = .unavailable
    private(set) var autoStartEnabled = false
    private var lastError: String?

    var onStatusChange: ((EnsoPiPStatusPayload) -> Void)?
    var onRestoreSession: ((String?) -> Void)?

    private var pipController: AVPictureInPictureController?
    private weak var attachedSourceView: UIView?
    private weak var hostSourceView: UIView?
    private var keepAlivePlayer: AVAudioPlayer?
    private var possibleObservation: NSKeyValueObservation?
    /// 非 nil 表示用户已请求启动，正在等待系统报告 `isPictureInPicturePossible`。
    private var pendingStart: Task<Void, Never>?

    var isActive: Bool { phase == .active }

    var status: EnsoPiPStatusPayload {
        EnsoPiPStatusPayload(
            supported: AVPictureInPictureController.isPictureInPictureSupported(),
            active: phase == .active,
            auto: autoStartEnabled,
            error: lastError
        )
    }

    /// 记录已挂载到窗口的源视图；按 Apple 要求仅在开启自动画中画或手动启动时才挂载 ContentSource。
    func attach(sourceView: UIView) {
        hostSourceView = sourceView
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            transition(to: .unavailable)
            return
        }
        if phase == .unavailable {
            transition(to: .ready)
        }
        if autoStartEnabled {
            ensureControllerAttached()
        }
    }

    /// 幂等：仅在需要自动画中画或主动开启时才创建 AVPictureInPictureController。
    @discardableResult
    private func ensureControllerAttached() -> AVPictureInPictureController? {
        guard let sourceView = hostSourceView ?? (self.sourceView.window != nil ? self.sourceView : nil) else {
            return nil
        }
        if let existing = pipController, attachedSourceView === sourceView { return existing }
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return nil }

        let callViewController = AVPictureInPictureVideoCallViewController()
        callViewController.preferredContentSize = CGSize(width: 340, height: 220)
        callViewController.view.backgroundColor = .black
        let hosting = UIHostingController(rootView: EnsoPiPConversationView(model: viewModel))
        hosting.view.backgroundColor = .clear
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        callViewController.addChild(hosting)
        callViewController.view.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: callViewController.view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: callViewController.view.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: callViewController.view.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: callViewController.view.bottomAnchor),
        ])
        hosting.didMove(toParent: callViewController)

        let source = AVPictureInPictureController.ContentSource(
            activeVideoCallSourceView: sourceView,
            contentViewController: callViewController
        )
        let controller = AVPictureInPictureController(contentSource: source)
        controller.delegate = self
        controller.canStartPictureInPictureAutomaticallyFromInline = autoStartEnabled

        possibleObservation = controller.observe(
            \.isPictureInPicturePossible,
            options: [.initial, .new]
        ) { [weak self] _, change in
            let possible = change.newValue ?? false
            Task { @MainActor [weak self] in
                self?.pictureInPicturePossibleChanged(possible)
            }
        }
        pipController?.delegate = nil
        pipController = controller
        attachedSourceView = sourceView
        return controller
    }

    /// 空闲且未开启自动画中画时释放 ContentSource，防止系统切后台误起画中画。
    private func detachControllerIfIdle() {
        guard !autoStartEnabled, phase == .ready || phase == .unavailable else { return }
        possibleObservation?.invalidate()
        possibleObservation = nil
        pipController?.delegate = nil
        pipController?.contentSource = nil
        pipController = nil
        attachedSourceView = nil
    }

    func start() {
        guard let controller = ensureControllerAttached() else {
            fail(AVPictureInPictureController.isPictureInPictureSupported() ? "画中画尚未就绪" : "当前设备不支持画中画")
            return
        }
        guard phase == .ready else { return }
        activateAudioSession(startKeepAlive: true)
        lastError = nil
        transition(to: .starting)
        if controller.isPictureInPicturePossible {
            controller.startPictureInPicture()
            return
        }
        pendingStart = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.startTimeout)
            guard let self, !Task.isCancelled, self.pendingStart != nil else { return }
            self.pendingStart = nil
            self.transition(to: .ready)
            self.fail("画中画暂不可用，请稍后重试")
        }
    }

    func stop() {
        switch phase {
        case .active:
            transition(to: .stopping)
            pipController?.stopPictureInPicture()
        case .starting where pendingStart != nil:
            cancelPendingStart()
            transition(to: .ready)
            stopSilentKeepAlive()
            deactivateAudioSessionIfIdle()
            detachControllerIfIdle()
        default:
            break
        }
    }

    func setAutoStart(_ enabled: Bool) {
        autoStartEnabled = enabled
        if enabled {
            let controller = ensureControllerAttached()
            controller?.canStartPictureInPictureAutomaticallyFromInline = true
        } else {
            pipController?.canStartPictureInPictureAutomaticallyFromInline = false
            deactivateAudioSessionIfIdle()
            detachControllerIfIdle()
        }
        notifyStatus()
    }

    /// 即将切后台时，若开启了自动画中画，提前激活无混音的 playback 音频会话让系统允许自动进入 PiP。
    func handleWillResignActive() {
        guard autoStartEnabled, phase == .ready else { return }
        ensureControllerAttached()?.canStartPictureInPictureAutomaticallyFromInline = true
        activateAudioSession(startKeepAlive: false)
    }

    /// 回到前台且未在画中画时释放音频会话，避免影响其他 App 音频。
    func handleDidBecomeActive() {
        guard phase == .ready else { return }
        stopSilentKeepAlive()
        deactivateAudioSessionIfIdle(force: true)
    }

    func update(snapshot: EnsoPiPSnapshot) {
        viewModel.apply(snapshot)
    }

    private func pictureInPicturePossibleChanged(_ possible: Bool) {
        guard possible, pendingStart != nil, phase == .starting else { return }
        cancelPendingStart()
        pipController?.startPictureInPicture()
    }

    private func cancelPendingStart() {
        pendingStart?.cancel()
        pendingStart = nil
    }

    private func transition(to next: EnsoPiPLifecyclePhase) {
        guard phase != next else { return }
        phase = next
        notifyStatus()
    }

    private func fail(_ message: String) {
        lastError = message
        stopSilentKeepAlive()
        deactivateAudioSessionIfIdle(force: true)
        detachControllerIfIdle()
        notifyStatus()
    }

    private func notifyStatus() {
        onStatusChange?(status)
    }

    /// iOS 要求 `.playback`（不带 `.mixWithOthers`）才允许进入 PiP；仅在 PiP 活跃时跑极轻静音保活，
    /// 防止切到其他 App 5 秒后进程被挂起导致对话浮窗停止刷新。
    private func activateAudioSession(startKeepAlive: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            NSLog("[EnsoPiP] activate audio session failed: %@", String(describing: error))
        }
        if startKeepAlive {
            startSilentKeepAlive()
        }
    }

    private func startSilentKeepAlive() {
        if let player = keepAlivePlayer, player.isPlaying { return }
        do {
            let player = try AVAudioPlayer(data: Self.silentWavData)
            player.numberOfLoops = -1
            player.volume = 0
            player.prepareToPlay()
            player.play()
            keepAlivePlayer = player
        } catch {
            NSLog("[EnsoPiP] silent keep-alive failed: %@", String(describing: error))
        }
    }

    private func stopSilentKeepAlive() {
        keepAlivePlayer?.stop()
        keepAlivePlayer = nil
    }

    private func deactivateAudioSessionIfIdle(force: Bool = false) {
        guard force || !autoStartEnabled, phase == .ready || phase == .unavailable else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            NSLog("[EnsoPiP] deactivate audio session failed: %@", String(describing: error))
        }
    }

    /// 内存生成 1 秒 8kHz 单声道 16-bit 静音 WAV（~16KB），零外部资源文件。
    private static func makeSilentWavData() -> Data {
        let sampleRate: UInt32 = 8_000
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let dataSize: UInt32 = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let chunkSize: UInt32 = 36 + dataSize
        let byteRate: UInt32 = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign: UInt16 = channels * (bitsPerSample / 8)

        var wav = Data(capacity: Int(44 + dataSize))
        func appendLE<T: FixedWidthInteger>(_ value: T) {
            var le = value.littleEndian
            withUnsafeBytes(of: &le) { wav.append(contentsOf: $0) }
        }
        wav.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
        appendLE(chunkSize)
        wav.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"
        wav.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // "fmt "
        appendLE(UInt32(16))
        appendLE(UInt16(1)) // PCM
        appendLE(channels)
        appendLE(sampleRate)
        appendLE(byteRate)
        appendLE(blockAlign)
        appendLE(bitsPerSample)
        wav.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
        appendLE(dataSize)
        wav.append(Data(count: Int(dataSize)))
        return wav
    }
}

/// AVKit 在主线程回调这些代理方法；`@preconcurrency` 让编译器按主线程隔离并在运行时断言。
extension EnsoPiPController: @preconcurrency AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        cancelPendingStart()
        activateAudioSession(startKeepAlive: true)
        transition(to: .starting)
    }

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        lastError = nil
        transition(to: .active)
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        cancelPendingStart()
        transition(to: .ready)
        fail(error.localizedDescription)
    }

    func pictureInPictureControllerWillStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        transition(to: .stopping)
    }

    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        transition(to: .ready)
        stopSilentKeepAlive()
        deactivateAudioSessionIfIdle(force: true)
        detachControllerIfIdle()
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        onRestoreSession?(viewModel.snapshot.sessionId)
        completionHandler(true)
    }
}
