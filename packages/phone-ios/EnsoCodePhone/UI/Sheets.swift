import SwiftUI

/// PWA 底部弹层风格：SheetContent side="bottom"，标题 + 字段列表 + 底部按钮。
/// 与 PWA 的 Field 组件一致：label text-xs muted + 选择器整宽。
struct SheetField<Content: View>: View {
  @Environment(\.ensoPalette) var palette
  let label: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.system(size: EnsoFont.sm))
        .foregroundStyle(palette.mutedForeground)
      content
    }
  }
}

/// PWA Select 风格的选择器：整宽圆角边框 + 当前值 + chevron
struct SheetPicker<Content: View>: View {
  @Environment(\.ensoPalette) var palette
  @ViewBuilder var content: Content

  var body: some View {
    Menu {
      content
    } label: {
      HStack {
        Spacer().frame(width: 0)
      }
      .frame(maxWidth: .infinity, minHeight: 36)
      .padding(.horizontal, 10)
      .background(palette.background)
      .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
      .overlay(pickerLabel, alignment: .leading)
    }
  }

  private var pickerLabel: some View {
    HStack {
      Spacer()
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(palette.mutedForeground)
        .padding(.trailing, 10)
    }
    .allowsHitTesting(false)
  }
}

/// 弹层通用外壳：标题栏 + 内容 + 安全区
struct EnsoSheet<Content: View>: View {
  @Environment(\.ensoPalette) var palette
  let title: String
  let onClose: () -> Void
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(title).font(.system(size: EnsoFont.base, weight: .medium))
        Spacer()
        Button(action: onClose) {
          Image(systemName: "xmark")
            .font(.system(size: 14))
            .foregroundStyle(palette.mutedForeground)
            .frame(width: 28, height: 28)
            .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.sm))
        }
        .buttonStyle(EnsoHoverButtonStyle())
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      content
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
    .background(palette.background)
  }
}

struct NewSessionSheet: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.ensoPalette) var palette
  @State private var pickedProject: String?
  @State private var pickedProvider: String?
  @State private var pickedModel: String?
  @State private var approvalMode: ApprovalMode = .full
  @State private var reasoningEnabled = false
  @State private var thinkingLevel: ThinkingLevel = .medium

  var body: some View {
    EnsoSheet(title: "新建会话", onClose: { model.composing = false }) {
      VStack(alignment: .leading, spacing: 16) {
        SheetField(label: "项目") {
          Menu {
            ForEach(model.projects) { p in
              Button(p.listLabel) { pickedProject = p.id }
            }
          } label: {
            selectLabel(model.projects.first(where: { $0.id == projectId })?.listLabel ?? "选择项目")
          }
        }
        SheetField(label: "模型服务") {
          Menu {
            ForEach(model.providers) { p in
              Button(p.name) { pickedProvider = p.id; pickedModel = nil }
            }
          } label: {
            selectLabel(provider.name.isEmpty ? "选择模型服务" : provider.name)
          }
        }
        SheetField(label: "模型") {
          Menu {
            ForEach(provider.models) { m in
              Button(m.display) { pickedModel = m.id }
            }
          } label: {
            selectLabel(modelId.isEmpty ? "选择模型" : (provider.models.first(where: { $0.id == modelId })?.display ?? modelId))
          }
        }
        SheetField(label: "审批模式") {
          Menu {
            ForEach(ApprovalMode.allCases, id: \.self) { m in
              Button(m.label) { approvalMode = m }
            }
          } label: {
            selectLabel(approvalMode.label)
          }
        }
        HStack {
          Text("推理")
            .font(.system(size: EnsoFont.sm))
            .foregroundStyle(palette.mutedForeground)
          Spacer()
          Toggle("", isOn: $reasoningEnabled).labelsHidden().controlSize(.small)
        }
        if reasoningEnabled {
          SheetField(label: "推理档位") {
            Menu {
              ForEach(ThinkingLevel.allCases, id: \.self) { l in
                Button(l.label) { thinkingLevel = l }
              }
            } label: {
              selectLabel(thinkingLevel.label)
            }
          }
        }
        if model.projects.isEmpty {
          Text("桌面端还没有项目，请先在桌面添加。")
            .font(.system(size: EnsoFont.sm))
            .foregroundStyle(palette.destructive)
        } else if model.providers.isEmpty {
          Text("桌面端没有可用的模型服务。")
            .font(.system(size: EnsoFont.sm))
            .foregroundStyle(palette.destructive)
        }
        // PWA: flex justify-end gap-2，取消 outline + 创建 primary
        HStack {
          Spacer()
          Button("取消") { model.composing = false }
            .font(.system(size: EnsoFont.base))
            .foregroundStyle(palette.foreground)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
          Button("创建") { create() }
            .font(.system(size: EnsoFont.base, weight: .medium))
            .foregroundStyle(palette.primaryForeground)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(canCreate ? palette.primary : palette.primary.opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
            .disabled(!canCreate)
        }
        .padding(.top, 4)
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .presentationBackground(palette.background)
  }

  private var projectId: String {
    model.projects.first(where: { $0.id == pickedProject })?.id
      ?? model.projects.first(where: { $0.id == model.composeProjectId })?.id
      ?? model.projects.first?.id
      ?? ""
  }

  private var provider: ProviderEntry {
    model.providers.first(where: { $0.id == pickedProvider }) ?? model.providers.first ?? ProviderEntry(id: "", name: "", models: [])
  }

  private var modelId: String {
    provider.models.first(where: { $0.id == pickedModel })?.id ?? provider.models.first?.id ?? ""
  }

  private var canCreate: Bool { !projectId.isEmpty && !provider.id.isEmpty && !modelId.isEmpty }

  private func selectLabel(_ text: String) -> some View {
    HStack {
      Text(text)
        .font(.system(size: EnsoFont.base))
        .foregroundStyle(palette.foreground)
        .lineLimit(1)
      Spacer()
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(palette.mutedForeground)
    }
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, minHeight: 36)
    .background(palette.background)
    .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
    .contentShape(Rectangle())
  }

  private func create() {
    model.spawn(
      NewSessionRequest(
        projectId: projectId,
        providerId: provider.id,
        modelId: modelId,
        approvalMode: approvalMode,
        reasoningEnabled: reasoningEnabled,
        thinkingLevel: thinkingLevel
      )
    )
  }
}

struct SessionConfigSheet: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.ensoPalette) var palette

  var body: some View {
    EnsoSheet(title: "会话设置", onClose: { model.configOpen = false }) {
      VStack(alignment: .leading, spacing: 16) {
        SheetField(label: "模型服务") {
          Menu {
            ForEach(model.providers) { p in
              Button(p.name) { selectProvider(p) }
            }
          } label: {
            selectLabel(currentProvider.name.isEmpty ? "选择模型服务" : currentProvider.name)
          }
        }
        SheetField(label: "模型") {
          Menu {
            ForEach(currentProvider.models) { m in
              Button(m.display) { selectModel(m.id) }
            }
          } label: {
            selectLabel(currentModelLabel)
          }
        }
        HStack {
          Text("推理")
            .font(.system(size: EnsoFont.sm))
            .foregroundStyle(palette.mutedForeground)
          Spacer()
          Toggle("", isOn: reasoningBinding).labelsHidden().controlSize(.small)
        }
        if model.entry?.reasoningEnabled == true {
          SheetField(label: "推理档位") {
            Menu {
              ForEach(ThinkingLevel.allCases, id: \.self) { l in
                Button(l.label) { setThinking(l) }
              }
            } label: {
              selectLabel((model.entry?.thinkingLevel ?? .medium).label)
            }
          }
        }
        Text("模型切换对运行中的会话在下次启动时生效；推理档位即时生效。")
          .font(.system(size: EnsoFont.xs))
          .foregroundStyle(palette.mutedForeground)
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(palette.background)
  }

  private var currentProvider: ProviderEntry {
    model.providers.first(where: { $0.id == model.entry?.providerId }) ?? model.providers.first
      ?? ProviderEntry(id: "", name: "", models: [])
  }

  private var currentModelLabel: String {
    if let mid = model.entry?.modelId,
      let m = currentProvider.models.first(where: { $0.id == mid })
    { return m.display }
    return currentProvider.models.first?.display ?? "选择模型"
  }

  private func selectLabel(_ text: String) -> some View {
    HStack {
      Text(text)
        .font(.system(size: EnsoFont.base))
        .foregroundStyle(palette.foreground)
        .lineLimit(1)
      Spacer()
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(palette.mutedForeground)
    }
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, minHeight: 36)
    .background(palette.background)
    .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
    .contentShape(Rectangle())
  }

  private func selectProvider(_ p: ProviderEntry) {
    guard let sid = model.activeId, let first = p.models.first else { return }
    model.send(.setModel(sessionId: sid, providerId: p.id, modelId: first.id))
  }

  private func selectModel(_ mid: String) {
    guard let sid = model.activeId else { return }
    model.send(.setModel(sessionId: sid, providerId: currentProvider.id, modelId: mid))
  }

  private var reasoningBinding: Binding<Bool> {
    Binding(
      get: { model.entry?.reasoningEnabled ?? false },
      set: { enabled in
        guard let sid = model.activeId else { return }
        model.send(.setReasoning(sessionId: sid, enabled: enabled))
      }
    )
  }

  private func setThinking(_ level: ThinkingLevel) {
    guard let sid = model.activeId else { return }
    model.send(.setThinking(sessionId: sid, level: level))
  }
}
