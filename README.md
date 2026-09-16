<p align="center">
  <img src="build/icons/256x256.png" width="120" alt="EnsoCode" />
</p>

<h1 align="center">EnsoCode</h1>

<p align="center">
  <b>One Developer. An Entire Fleet of Autonomous Coding Agents.</b>
</p>

<p align="center">
  <b>English</b> • <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://enso.j3.do/">Website</a> • <a href="https://t.me/EnsoAI_news">News Channel</a> • <a href="https://t.me/EnsoCode_Official">Community</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-5c6bc0?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555?style=flat-square" alt="macOS, Windows, Linux" />
  <img src="https://img.shields.io/badge/runtime-Electron%20%2B%20pi-blue?style=flat-square" alt="Electron + pi" />
</p>

<p align="center">
  <img src="docs/readme/chat.jpg" alt="EnsoCode Workbench: Desktop workspace & mobile companion, one session across two screens" width="920" />
</p>

> Cart discounts require urgent changes, database slow query alerts are firing, and the design system buttons still need padding adjustments. With EnsoCode, you connect three repositories into your sidebar, delegate each task to autonomous agents in parallel, and watch diffs, terminal outputs, and execution milestones appear live on your timeline while you focus on verification.
> Step away from your desk without losing control: approvals, milestones, and agent turns stream to your mobile device via end-to-end encrypted relay in real time.

---

## 💡 Why EnsoCode

EnsoCode is a local-first desktop agent workbench built on Electron and powered by the [pi](https://github.com/earendil-works/pi) coding agent harness. Rather than treating an AI assistant as a single-turn completion tool, EnsoCode is engineered to **orchestrate, supervise, and collaborate with teams of specialized agents**:

- **Task Isolation & Boundaries**: Local repositories stay pinned to the sidebar. Each conversation is dedicated to a distinct task. Parallel branches in the same repository leverage opt-in Git Worktrees (`enso/*`) to guarantee zero file-lock collisions or dirty working-tree overwrites.
- **Hierarchical Agent Dispatch**: Delegate short, self-contained subtasks to **Subagents** (fire-and-forget in isolated context); assign multi-step exploratory workflows to **Coworkers** (persistent digital peers running in their own tabs with shared memory and interactive chat).
- **Embedded Review & Total Control**: Modern diff inspector directly embedded in the conversation flow. Switch dynamically across three approval levels (Full Approval, Auto-Accept Edits, Full Access) backed by automatic Git Checkpoint snapshots with one-click rollback.
- **Desk-Free Continuity**: Lightweight PWA mobile companion paired via QR code with end-to-end encryption (E2EE). Review diffs, approve critical commands, steer agents, and answer interactive questions anywhere.
- **Multi-Node & Remote Execution**: Seamlessly connect to remote servers via native SSH tunnels or pair with another desktop node to run and inspect sessions remotely.
- **Frictionless Ecosystem Migration**: One-click import for local Claude Code, Codex, and Cursor configurations, model keys, MCP servers, and prompt histories.

---

## ⚡ Core Capabilities

### 1. Multi-Task Orchestration & Agent Hierarchy

| Mode / Mechanism | Description |
| :--- | :--- |
| **Multi-Project & Sessions** | Centralize multiple local repositories in the sidebar. Dedicated timelines, model presets, pinned sessions, and archived states per conversation. |
| **Opt-in Git Worktree Isolation** | Work directly on your main working copy by default, or switch to an isolated Git Worktree (`enso/*` branches) for conflict-free parallel feature branches. |
| **Subagents (Outsourced Micro-Workers)** | Spawn isolated, one-shot agents for focused subtasks (e.g., `scout`, `tester`, `reviewer`, `worker`). Delivers a structured final report and safely self-terminates. |
| **Coworkers (Persistent Digital Peers)** | Long-lived subordinate agents living in their own dedicated tabs. Observe their thoughts, steer their actions, or chat directly without polluting your main session context. |
| **Background Processes** | Long-running servers, test watchers, and builds float in live status capsules above the composer with instant log inspection and exit hooks. |

---

### 2. Review, Safety & Checkpoints

| Feature | Description |
| :--- | :--- |
| **Embedded File Diffs** | Review line-by-line file reads, patch insertions, and modifications inside the stream or in the integrated side panel. |
| **Three Approval Modes** | Seamlessly toggle between **Full Manual Approval** (requires review for bash/MCP/file modifications), **Auto-Accept Edits** (fast coding with command confirmation), and **Full Access**. |
| **Git Checkpoints** | Automatic lightweight commits saved to `refs/enso-checkpoints` before destructive edits (up to 50 checkpoints per session) for instantaneous rewind and undo. |

---

### 3. Continuous Execution & Steering

| Feature | Description |
| :--- | :--- |
| **Goal Tracking (`/goal`)** | Pin high-level milestones to the top of your session. The agent autonomously plans and drives forward (up to 25 auto-turns) with pause/resume controls. |
| **Steer & Interrupt Queue** | Queue follow-up prompts and instructions while the agent is running; edit or drop them before execution, or trigger an immediate `Steer` interrupt. |
| **Automatic Fault Recovery** | Automatic retry countdown on transient network timeouts or provider 5xx spikes, with clear status indicators. |
| **Dockable Side Panel** | Multi-tab side workbench supporting integrated file navigation, session changes inspector, split terminals, and an embedded browser. |

<p align="center">
  <img src="docs/readme/split-workbench.png" alt="Integrated Dockable Side Panel: Files, Changes, Terminals, and Browser" width="920" />
</p>

---

### 4. Remote Nodes & Mobile Companion

- **Zero-Setup Mobile Companion**: Pair your phone in seconds using a QR code scan. Web-standard PWA with End-to-End Encryption (E2EE). The relay server forwards only ciphertext.
- **Remote Desktop Nodes**: Interconnect different EnsoCode machines. Browse and operate sessions running on your remote workstation directly from your laptop.
- **Native Remote SSH Projects**: Manage remote workspaces directly via SSH tunnels without requiring local filesystem synchronizations.

<p align="center">
  <img src="docs/readme/phone.png" alt="Device Pairing: QR Scan, End-to-End Encryption" width="920" />
</p>

---

### 5. Extensibility & Personalization

| Feature | Description |
| :--- | :--- |
| **Skills, MCP & Slash Commands** | Native pill UI supporting `/skill:` invocations, `@` file and session autocomplete, and multi-server MCP integrations. |
| **Runtime Presets** | Bundle model policies, skill packages, MCP tools, and system prompts into reusable presets. |
| **Appearance & Ghostty Themes** | Built-in terminal color engines, light and dark themes, background images, and custom glassmorphism opacity. |
| **Configuration Sync & Migration** | Automatically detect and import configuration, providers, and histories from Claude Code, Codex, and Cursor. |

<p align="center">
  <img src="docs/readme/appearance.png" alt="Appearance: Themes, Terminal Themes, and Styling" width="920" />
</p>

---

## 🛠️ Development & Build

### Prerequisites
- **Node.js**: `>= 22.0.0`
- **Package Manager**: [pnpm](https://pnpm.io) (`>= 10.0.0`)

### Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Launch desktop development mode
pnpm dev
```

### Mock provider (no API keys)

The **Mock** / Demo catalog entry is a first-class in-process provider. It streams assistant text locally and never calls a vendor.

1. `pnpm dev`
2. Settings → Providers → **Add model or provider** → **Mock** (one click; placeholder key `enso-mock` is filled for you)
3. Start a chat. Optional: put `[[tool:read {"path":"README.md"}]]` in the prompt to demo a tool call.

Isolated userData for screenshots or clean demos:

```bash
node scripts/seed-mock-env.mjs /tmp/enso-mock
ENSO_USER_DATA_DIR=/tmp/enso-mock pnpm dev
```

### Packaging

```bash
pnpm build:mac    # Build macOS app bundle (.dmg / .zip)
pnpm build:win    # Build Windows executable (.exe)
pnpm build:linux  # Build Linux package (.AppImage / .deb)
```

### Code Quality & Verification

```bash
pnpm typecheck    # TypeScript verification
pnpm lint         # Biome check & linting
pnpm test         # Run Vitest test suites
```

---

## 🔗 Links

- Website: [enso.j3.do](https://enso.j3.do/)
- News channel: [t.me/EnsoAI_news](https://t.me/EnsoAI_news)
- Community group: [t.me/EnsoCode_Official](https://t.me/EnsoCode_Official)

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
