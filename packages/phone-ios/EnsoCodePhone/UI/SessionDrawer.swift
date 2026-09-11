import SwiftUI

struct SessionDrawer: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.ensoPalette) var palette
  @State private var foldedProjects: Set<String> = []
  @State private var revealedExtras: [String: Int] = [:]
  @State private var archivedOpen = false
  @State private var confirmUnpair: String?
  @State private var collapsedGroups: Set<String> = []
  @State private var selectedGroupId = DeviceStore.selectedGroupId
  @State private var nowTick = Int64(Date().timeIntervalSince1970 * 1000)
  @State private var renaming: String?
  @State private var renameDraft = ""

  var body: some View {
    let open = model.drawerOpen
    ZStack(alignment: .leading) {
      // 遮罩：PWA bg-black/40
      Color.black.opacity(open ? 0.4 : 0)
        .ignoresSafeArea()
        .allowsHitTesting(open)
        .onTapGesture { model.drawerOpen = false }
        .animation(.easeInOut(duration: 0.2), value: open)

      VStack(spacing: 0) {
        // 头部：PWA h-12 border-b px-3，「项目」+ 关闭
        HStack {
          Text("项目").font(.system(size: EnsoFont.base, weight: .medium))
          Spacer()
          Button { model.drawerOpen = false } label: {
            Image(systemName: "xmark")
              .font(.system(size: 14))
              .foregroundStyle(palette.mutedForeground)
              .frame(width: 28, height: 28)
              .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.sm))
          }
          .buttonStyle(EnsoHoverButtonStyle())
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
        .overlay(alignment: .bottom) { EnsoDivider() }

        if !model.projectGroups.isEmpty {
          HStack {
            Image(systemName: "folder")
              .font(.system(size: 13))
              .foregroundStyle(palette.mutedForeground)
            Picker("组", selection: $selectedGroupId) {
              Text("全部").tag(ProjectGroups.allId)
              ForEach(model.projectGroups.sorted { $0.order < $1.order }) { g in
                Text((g.emoji.map { "\($0) " } ?? "") + g.name).tag(g.id)
              }
              Text("未分组").tag(ProjectGroups.ungroupedId)
            }
            .pickerStyle(.menu)
            .tint(palette.foreground)
            Spacer()
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .overlay(alignment: .bottom) { EnsoDivider() }
          .onChange(of: selectedGroupId) { _, v in DeviceStore.selectedGroupId = v }
        }

        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            if model.projects.isEmpty {
              Text("桌面端还没有项目")
                .font(.system(size: EnsoFont.base))
                .foregroundStyle(palette.mutedForeground)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .padding(.vertical, 24)
                .overlay(
                  RoundedRectangle(cornerRadius: EnsoRadius.lg)
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4]))
                    .foregroundStyle(palette.border)
                )
            }
            if !pinnedSessions.isEmpty {
              HStack(spacing: 6) {
                Image(systemName: "pin.fill")
                  .font(.system(size: 12))
                  .foregroundStyle(palette.mutedForeground)
                Text("置顶").font(.system(size: EnsoFont.base, weight: .medium))
              }
              .padding(.horizontal, 8)
              .padding(.vertical, 8)
              VStack(spacing: 2) {
                ForEach(pinnedSessions) { s in sessionRow(s) }
              }
            }
            projectSections
            if !orphans.isEmpty {
              projectBlock(id: "__orphans__", name: "其他", badge: nil, sessions: orphans, canCreate: false)
            }
          }
          .padding(8)
        }

        // 归档栏固定底部（滚动区外），与桌面一致
        if !archivedSessions.isEmpty {
          VStack(spacing: 2) {
            if archivedOpen {
              ScrollView {
                VStack(spacing: 2) {
                  ForEach(archivedSessions) { s in sessionRow(s, showProject: true) }
                }
              }
              .frame(maxHeight: 256)
            }
            Button { archivedOpen.toggle() } label: {
              HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                  .font(.system(size: 11, weight: .semibold))
                  .rotationEffect(.degrees(archivedOpen ? -90 : 0))
                  .frame(width: 20)
                Image(systemName: "archivebox")
                  .font(.system(size: 13))
                Text("已归档")
                  .font(.system(size: EnsoFont.base))
                Spacer()
                Text("\(archivedSessions.count)")
                  .font(.system(size: 10))
                  .foregroundStyle(palette.mutedForeground)
              }
              .foregroundStyle(palette.mutedForeground)
              .padding(.horizontal, 8)
              .padding(.vertical, 8)
              .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
            }
            .buttonStyle(.plain)
          }
          .padding(8)
          .overlay(alignment: .top) { EnsoDivider() }
        }

        settings
      }
      .frame(width: min(UIScreen.main.bounds.width * 0.82, 320))
      .background(palette.background)
      .overlay(alignment: .trailing) { EnsoDivider().rotationEffect(.degrees(90)).frame(width: 1) }
      .offset(x: open ? 0 : -340)
      .animation(.easeInOut(duration: 0.2), value: open)
    }
    .onChange(of: model.drawerOpen) { _, open in
      if open { nowTick = Int64(Date().timeIntervalSince1970 * 1000); confirmUnpair = nil }
    }
    .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in
      if model.drawerOpen { nowTick = Int64(Date().timeIntervalSince1970 * 1000) }
    }
  }

  private var archivedProjectIds: Set<String> {
    Set(model.projects.filter(\.archived).map(\.id))
  }

  private func isArchived(_ c: CatalogEntry) -> Bool {
    c.archived || archivedProjectIds.contains(c.projectId)
  }

  private var activeProjects: [ProjectEntry] {
    ProjectGroups.filterProjects(model.projects, groups: model.projectGroups, archivedIds: archivedProjectIds, selected: selectedGroupId)
  }

  private var topLevel: [CatalogEntry] { model.catalog.filter { $0.parentId == nil } }

  private var pinnedSessions: [CatalogEntry] {
    let ids = Set(activeProjects.map(\.id))
    return DrawerOrder.orderPinned(
      topLevel.filter { $0.pinned && !isArchived($0) && ($0.projectId.isEmpty || ids.contains($0.projectId)) },
      manualIds: model.pinnedOrder
    )
  }

  private var archivedSessions: [CatalogEntry] {
    DrawerOrder.sortByActivity(
      topLevel.filter { c in
        guard isArchived(c) else { return false }
        if selectedGroupId == ProjectGroups.allId { return true }
        guard let project = model.projects.first(where: { $0.id == c.projectId }) else {
          return selectedGroupId == ProjectGroups.ungroupedId
        }
        if selectedGroupId == ProjectGroups.ungroupedId {
          return ProjectGroups.isUngrouped(project, groups: model.projectGroups)
        }
        return project.groupId == selectedGroupId
      }
    )
  }

  private var orphans: [CatalogEntry] {
    let known = Set(model.projects.map(\.id))
    return DrawerOrder.orderProjectSessions(topLevel.filter { !isArchived($0) && !known.contains($0.projectId) })
  }

  @ViewBuilder
  private var projectSections: some View {
    if selectedGroupId == ProjectGroups.allId && !model.projectGroups.isEmpty {
      ForEach(ProjectGroups.sectionsForAllView(model.projects, groups: model.projectGroups, archivedIds: archivedProjectIds), id: \.groupId) { section in
        let folded = collapsedGroups.contains(section.groupId)
        // 组头：PWA h-7 text-xs font-medium muted，chevron 展开旋转
        Button {
          if folded { collapsedGroups.remove(section.groupId) } else { collapsedGroups.insert(section.groupId) }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "chevron.right")
              .font(.system(size: 11, weight: .semibold))
              .rotationEffect(.degrees(folded ? 0 : 90))
            if let g = section.group {
              if let emoji = g.emoji { Text(emoji).font(.system(size: EnsoFont.base)) }
              if let color = g.color, let c = Color(css: color) {
                Circle().fill(c).frame(width: 8, height: 8)
              }
              Text(g.name)
            } else {
              Text("未分组")
            }
            Spacer()
            Text("\(section.projects.count)")
              .font(.system(size: 10))
              .foregroundStyle(palette.mutedForeground.opacity(0.7))
          }
          .font(.system(size: EnsoFont.sm, weight: .medium))
          .foregroundStyle(palette.mutedForeground)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !folded {
          ForEach(section.projects) { p in
            projectBlock(id: p.id, name: p.name, badge: p.sshBadge, sessions: sessions(for: p.id), canCreate: model.state == .online)
          }
        }
      }
    } else {
      ForEach(activeProjects) { p in
        projectBlock(id: p.id, name: p.name, badge: p.sshBadge, sessions: sessions(for: p.id), canCreate: model.state == .online)
      }
    }
  }

  private func sessions(for projectId: String) -> [CatalogEntry] {
    DrawerOrder.orderProjectSessions(topLevel.filter { !isArchived($0) && $0.projectId == projectId })
  }

  private func projectBlock(id: String, name: String, badge: String?, sessions: [CatalogEntry], canCreate: Bool) -> some View {
    let folded = foldedProjects.contains(id)
    let extra = revealedExtras[id] ?? 0
    let shown = SessionSlots.shownCount(total: sessions.count, revealedExtra: extra)
    return VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Button {
          if folded { foldedProjects.remove(id) } else { foldedProjects.insert(id) }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "chevron.right")
              .font(.system(size: 11, weight: .semibold))
              .rotationEffect(.degrees(folded ? 0 : 90))
            Image(systemName: "folder")
              .font(.system(size: 13))
              .foregroundStyle(palette.mutedForeground)
            Text(name).lineLimit(1)
            if let badge {
              Text(badge)
                .font(.system(size: 10))
                .foregroundStyle(palette.mutedForeground)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(palette.muted)
                .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.sm))
            }
            Text("\(sessions.count)").foregroundStyle(palette.mutedForeground)
          }
          .font(.system(size: EnsoFont.md, weight: .medium))
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        Spacer()
        if canCreate {
          Button {
            model.drawerOpen = false
            model.composeProjectId = id == "__orphans__" ? nil : id
            model.composing = true
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(palette.mutedForeground)
              .frame(width: 24, height: 24)
              .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.sm))
          }
          .buttonStyle(EnsoHoverButtonStyle())
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      if !folded {
        VStack(spacing: 2) {
          ForEach(Array(sessions.prefix(shown))) { s in sessionRow(s) }
        }
        if sessions.count > SessionSlots.collapsedLimit {
          HStack(spacing: 12) {
            if shown < sessions.count {
              Button("展开其余 \(sessions.count - shown) 条") {
                revealedExtras[id] = SessionSlots.nextRevealedExtra(total: sessions.count, revealedExtra: extra)
              }
            }
            if extra > 0 {
              Button("收起") { revealedExtras[id] = SessionSlots.prevRevealedExtra(extra) }
            }
          }
          .font(.system(size: EnsoFont.sm))
          .foregroundStyle(palette.mutedForeground)
          .padding(.horizontal, 12)
          .padding(.vertical, 4)
        }
      }
    }
  }

  // PWA SessionRow：状态点 + 标题 text-sm + 相对时间；active bg-muted
  private func sessionRow(_ session: CatalogEntry, showProject: Bool = false) -> some View {
    Button {
      model.setActiveSession(session.id)
      model.drawerOpen = false
    } label: {
      HStack(spacing: 8) {
        Circle()
          .fill(dotColor(session))
          .frame(width: 6, height: 6)
          .modifier(PulseModifier(active: session.status == "running"))
        VStack(alignment: .leading, spacing: 1) {
          Text(session.title.isEmpty ? "新对话" : session.title)
            .font(.system(size: EnsoFont.base))
            .lineLimit(1)
          if showProject {
            Text(session.projectName)
              .font(.system(size: 10))
              .foregroundStyle(palette.mutedForeground)
          }
        }
        Spacer()
        if let ts = session.updatedAt {
          Text(RelativeTime.format(ts, now: nowTick))
            .font(.system(size: EnsoFont.xs))
            .foregroundStyle(palette.mutedForeground)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(model.activeId == session.id ? palette.muted : Color.clear)
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(palette.foreground)
  }

  private func dotColor(_ s: CatalogEntry) -> Color {
    if s.status == "running" { return palette.info }
    if s.status == "failed" { return palette.destructive }
    if s.unread { return palette.success }
    return palette.mutedForeground.opacity(0.3)
  }

  // 底部设置区：主题 / 推送 / 设备列表 / 配对新电脑 / 版本
  private var settings: some View {
    VStack(alignment: .leading, spacing: 4) {
      if confirmUnpair == nil {
        HStack(spacing: 8) {
          Image(systemName: "paintpalette")
            .font(.system(size: 14))
            .foregroundStyle(palette.mutedForeground)
          Text("主题").font(.system(size: EnsoFont.base)).foregroundStyle(palette.mutedForeground)
          Spacer()
          // PWA: rounded-md border p-0.5 分段选择器
          HStack(spacing: 2) {
            ForEach(ThemePreference.allCases, id: \.self) { pref in
              Button(pref.label) { model.setTheme(pref) }
                .font(.system(size: EnsoFont.xs))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(model.themePreference == pref ? palette.primary : Color.clear)
                .foregroundStyle(model.themePreference == pref ? palette.primaryForeground : palette.mutedForeground)
                .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.sm))
            }
          }
          .padding(2)
          .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)

        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 8) {
            Image(systemName: "bell")
              .font(.system(size: 14))
              .foregroundStyle(palette.mutedForeground)
            Text("推送通知").font(.system(size: EnsoFont.base)).foregroundStyle(palette.mutedForeground)
            Spacer()
            Toggle("", isOn: Binding(
              get: { model.pushEnabled },
              set: { model.togglePush($0) }
            ))
            .labelsHidden()
            .controlSize(.small)
            .disabled(model.pushBusy)
          }
          if model.pushBusy {
            Text("正在开启…").font(.system(size: EnsoFont.xs)).foregroundStyle(palette.mutedForeground).padding(.leading, 24)
          } else if let err = model.pushError {
            Text(err).font(.system(size: EnsoFont.xs)).foregroundStyle(palette.destructive).padding(.leading, 24)
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
      }

      VStack(spacing: 2) {
        ForEach(model.devices) { d in
          if confirmUnpair == d.pairId {
            // 解绑确认：PWA rounded-lg border border-dashed p-3
            VStack(alignment: .leading, spacing: 8) {
              Text("解绑「\(d.label)」后需重新扫码才能连接，确定吗？")
                .font(.system(size: EnsoFont.sm))
              HStack {
                Spacer()
                Button("取消") { confirmUnpair = nil }
                  .foregroundStyle(palette.mutedForeground)
                Button("确定解绑") {
                  model.unpairDevice(d.pairId)
                  confirmUnpair = nil
                }
                .foregroundStyle(palette.destructive)
              }
              .font(.system(size: EnsoFont.sm))
            }
            .padding(12)
            .overlay(
              RoundedRectangle(cornerRadius: EnsoRadius.lg)
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4]))
                .foregroundStyle(palette.border)
            )
          } else {
            HStack(spacing: 8) {
              Image(systemName: "laptopcomputer")
                .font(.system(size: 14))
                .foregroundStyle(palette.mutedForeground)
              if renaming == d.pairId {
                TextField("名称", text: $renameDraft, onCommit: {
                  model.renameDevice(pairId: d.pairId, label: renameDraft)
                  renaming = nil
                })
                .font(.system(size: EnsoFont.base))
                .textFieldStyle(.plain)
              } else {
                Button {
                  model.switchDevice(d.pairId)
                } label: {
                  Text(d.label)
                    .font(.system(size: EnsoFont.base))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                }
                .buttonStyle(.plain)
              }
              Spacer()
              if d.pairId == model.device?.pairId {
                Text(model.connectionLabel)
                  .font(.system(size: 10))
                  .foregroundStyle(palette.mutedForeground)
              }
              Button {
                renaming = d.pairId
                renameDraft = d.label
              } label: {
                Image(systemName: "pencil").font(.system(size: 12)).foregroundStyle(palette.mutedForeground)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("重命名 \(d.label)")
              Button { confirmUnpair = d.pairId } label: {
                Image(systemName: "link.badge.slash").font(.system(size: 12)).foregroundStyle(palette.destructive)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("解绑 \(d.label)")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
          }
        }
      }

      if confirmUnpair == nil {
        Button {
          model.drawerOpen = false
          model.adding = true
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "plus").font(.system(size: 14))
            Text("配对新电脑").font(.system(size: EnsoFont.base))
          }
          .foregroundStyle(palette.mutedForeground)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }

      Text("版本 \(AppVersion.commit)")
        .font(.system(size: 10))
        .foregroundStyle(palette.mutedForeground.opacity(0.7))
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }
    .padding(8)
    .overlay(alignment: .top) { EnsoDivider() }
  }
}
