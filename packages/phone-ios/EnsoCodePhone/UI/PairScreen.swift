import AVFoundation
import SwiftUI

struct PairScreen: View {
  @Environment(\.ensoPalette) var palette
  var autoInvite: String?
  var onPaired: (PairedDevice) -> Void
  var onCancel: (() -> Void)?

  @State private var uri = ""
  @State private var busy = false
  @State private var error: String?
  @State private var scanning = false
  @State private var autoStarted = false

  var body: some View {
    VStack(spacing: 20) {
      Spacer()
      VStack(spacing: 6) {
        Image(systemName: "iphone")
          .font(.system(size: 32))
          .foregroundStyle(palette.mutedForeground)
        Text("连接到 EnsoCode")
          .font(.system(size: EnsoFont.xl, weight: .medium))
        Text("在桌面端「设置 → 手机」生成配对码，扫码或粘贴。")
          .font(.system(size: EnsoFont.base))
          .foregroundStyle(palette.mutedForeground)
          .multilineTextAlignment(.center)
      }
      .padding(.horizontal, 24)

      if scanning {
        VStack(spacing: 8) {
          QRScannerView { value in
            if (try? PairURI.parse(value)) != nil {
              scanning = false
              Task { await pair(value) }
            }
          }
          .aspectRatio(1, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
          .background(Color.black)
          Button("取消扫码") { scanning = false }
            .font(.system(size: EnsoFont.base))
            .foregroundStyle(palette.foreground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
        }
        .frame(maxWidth: 384)
        .padding(.horizontal, 24)
      } else {
        // PWA: Button w-full max-w-sm，primary 实心
        Button {
          scanning = true
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "camera")
              .font(.system(size: 15))
            Text("扫描二维码")
              .font(.system(size: EnsoFont.base, weight: .medium))
          }
          .foregroundStyle(palette.primaryForeground)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 10)
        }
        .background(palette.primary)
        .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
        .frame(maxWidth: 384)
        .padding(.horizontal, 24)
      }

      HStack(spacing: 8) {
        TextField("enso://pair?relay=…", text: $uri)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(EnsoFont.mono(EnsoFont.sm))
          .padding(.horizontal, 10)
          .frame(height: 36)
          .background(palette.background)
          .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
          .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
        Button {
          Task { await pair(uri.trimmingCharacters(in: .whitespacesAndNewlines)) }
        } label: {
          if busy {
            ProgressView().controlSize(.small)
          } else {
            Text("配对").font(.system(size: EnsoFont.base))
          }
        }
        .foregroundStyle(palette.foreground)
        .padding(.horizontal, 14)
        .frame(height: 36)
        .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
        .disabled(busy || uri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .opacity(busy || uri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
      }
      .frame(maxWidth: 384)
      .padding(.horizontal, 24)

      if let error {
        Text(error)
          .font(.system(size: EnsoFont.sm))
          .foregroundStyle(palette.destructive)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 384)
          .padding(.horizontal, 24)
      }

      if let onCancel {
        Button("返回", action: onCancel)
          .font(.system(size: EnsoFont.base))
          .foregroundStyle(palette.mutedForeground)
      }
      Spacer()
    }
    .onAppear {
      if let autoInvite, !autoStarted {
        autoStarted = true
        Task { await pair(autoInvite) }
      }
    }
  }

  private func pair(_ raw: String) async {
    busy = true
    error = nil
    defer { busy = false }
    do {
      let invite = try PairURI.parse(raw)
      let device = try await Handshake.claim(
        relayUrl: invite.relay,
        hostPublicKey: invite.publicKey,
        deviceName: Handshake.deviceName()
      )
      onPaired(device)
    } catch {
      self.error = error.localizedDescription
    }
  }
}

struct QRScannerView: UIViewControllerRepresentable {
  var onCode: (String) -> Void

  func makeUIViewController(context: Context) -> ScannerController {
    let c = ScannerController()
    c.onCode = onCode
    return c
  }

  func updateUIViewController(_ uiViewController: ScannerController, context: Context) {
    uiViewController.onCode = onCode
  }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private var handled = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device)
    else { return }
    if session.canAddInput(input) { session.addInput(input) }
    let output = AVCaptureMetadataOutput()
    if session.canAddOutput(output) {
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
    }
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = view.bounds
    view.layer.addSublayer(layer)
    preview = layer
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      self?.session.startRunning()
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    session.stopRunning()
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !handled,
      let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      let value = obj.stringValue
    else { return }
    handled = true
    onCode?(value)
  }
}
