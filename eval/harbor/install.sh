#!/usr/bin/env bash
# Install Node.js 22 (if needed) and the EnsoCode server package.
# Usage: install.sh [/path/to/ensocode-server.tgz]
#
# 计时优化：能在网络空闲时重叠的步骤全部并行——node 下载/解压与 apt 装包同时起跑，
# npm 解析依赖时网络和磁盘都不再闲置。
#   - node tarball 优先流式下载解压（curl | tar，不落盘），与 apt 装 curl/xz 并行
#   - npm install 直接装 tgz 但用 --ignore-scripts：@vscode/ripgrep 的 postinstall 走 GitHub API
#     （未鉴权每 IP 每小时 60 次，批量评测必 403），改成搭车 apt 装发行版 rg 后链接进 bin/；
#     装不上就退回到不带 rg（ripgrepCandidates 本来就容忍缺失，退化到 PATH 查找）
# 日志：输出 tee 到 /logs/agent/setup/install.log（harbor 会把 /logs/agent 收进 trial 产物），
#       /logs 不存在（本地调试）时静默跳过
set -euo pipefail

if [[ -d /logs/agent ]]; then
  # /logs/agent 是 harbor 的绑定挂载：mkdir 失败说明挂载只读或异常，tee 到里面会半途失败，
  # 宁可不 tee 也不能让 install 挂在日志上
  if mkdir -p /logs/agent/setup 2>/dev/null && touch /logs/agent/setup/install.log 2>/dev/null; then
    exec > >(tee -a /logs/agent/setup/install.log) 2>&1
  fi
fi

start_ts="$(date +%s)"
step() {
  echo "[install +$(( $(date +%s) - start_ts ))s] $*"
}

export DEBIAN_FRONTEND=noninteractive

# 最低可用版本：undici 8.x（pi-mcp/pi-tui 的依赖）engines 要求 node >=22.19，
# 且 node 的 zstd 支持（createZstdDecompress，undici decompress 拦截器运行时要用到）
# 在 22.15+ 才进 LTS；22.6 之类更老的 22.x 会在 require('undici') 时直接崩。
node_min_major=22
node_min_minor=19

# 版本检测片段只在 node_ok 一处使用；最低版本经 env 传入避免引号插值。
# 三点判定：能执行、bun shim 排除（oven/bun 镜像用 node→bun 的 symlink 冒充 node，
# process.versions.node 会谎报宿主模拟的版本号）、semver >= 最低版本。
node_check_js='const v = process.versions.node;
const parts = typeof v === "string" ? v.split(".").map(Number) : [];
const major = Number(process.env.ENSO_NODE_MIN_MAJOR);
const minor = Number(process.env.ENSO_NODE_MIN_MINOR);
const ok = process.versions.bun === undefined
  && parts.length >= 2
  && (parts[0] > major || (parts[0] === major && parts[1] >= minor));
process.exit(ok ? 0 : 1);'

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  ENSO_NODE_MIN_MAJOR=$node_min_major ENSO_NODE_MIN_MINOR=$node_min_minor \
    node -e "$node_check_js" >/dev/null 2>&1
}

need_node() {
  ! node_ok
}

arch="$(uname -m)"
case "$arch" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
node_version="${ENSO_NODE_VERSION:-22.23.4}"
node_tarball="node-v${node_version}-linux-${node_arch}.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}/${node_tarball}"

# ---------- 并行轨道 ----------
# 轨道 A（后台）：node 下载。镜像有 curl+xz 就流式 curl|tar 进 /usr/local；
# 缺工具就先落盘（curl 在而 xz 缺的场景），等前台 apt 装好后再解。
# 轨道 B（前台）：apt 装 curl/xz/ca-certificates，ripgrep 搭车同一个 update。
# 两边汇合后 npm install 解依赖。

node_fetch_pid=""
node_tarball_tmp=""
rg_install_pid=""
cleanup() {
  [[ -n "$node_tarball_tmp" ]] && rm -rf "$node_tarball_tmp" 2>/dev/null || true
}
trap cleanup EXIT

start_node_track() {
  (
    set -e
    if command -v curl >/dev/null 2>&1 && command -v xz >/dev/null 2>&1; then
      step "node: streaming $node_url"
      curl -fsSL --retry 3 --retry-delay 2 "$node_url" | tar -xJ -C /usr/local --strip-components=1
    elif command -v curl >/dev/null 2>&1; then
      # 有 curl 无 xz：先落盘，等前台 apt 装好 xz 后再解
      step "node: xz missing, downloading $node_url to disk first"
      curl -fsSL --retry 3 --retry-delay 2 "$node_url" -o "$node_tarball_tmp/$node_tarball"
    else
      # curl 也没有：等前台 apt 事务整体完成。不能只等 curl 二进制出现——ca-certificates
      # 的 postinst 还在跑时 curl 就会因为缺 CA 而 TLS 失败；flock 有竞态（apt 轨道可能
      # 还没开始持锁这里就拿锁返回了）。用 apt 轨道写完的哨兵文件做同步，最可靠。
      step "node: curl missing, waiting for apt track"
      for _ in $(seq 1 240); do
        [[ -f /tmp/enso-install-apt.done ]] && break
        sleep 1
      done
      if command -v curl >/dev/null 2>&1 && xz --version >/dev/null 2>&1; then
        step "node: tools ready, streaming $node_url"
        curl -fsSL --retry 3 --retry-delay 2 "$node_url" | tar -xJ -C /usr/local --strip-components=1
      elif command -v curl >/dev/null 2>&1; then
        step "node: xz not ready, downloading to disk for serial extract"
        curl -fsSL --retry 3 --retry-delay 2 "$node_url" -o "$node_tarball_tmp/$node_tarball"
      else
        step "node: curl still missing after wait, giving up background track"
      fi
    fi
  ) &
  node_fetch_pid=$!
}

finish_node_install() {
  # 等后台轨道；若它只完成了下载（或还没开始），在这里用已装好的 curl/xz 收尾
  local rc=0
  if [[ -n "$node_fetch_pid" ]]; then
    wait "$node_fetch_pid" || rc=$?
    if [[ $rc -ne 0 ]]; then
      # 后台轨道失败不直接放弃：前台工具已装好，串行重试一次
      step "node: background track failed (rc=$rc), retrying serially"
    fi
  fi
  hash -r || true
  # 后台轨道可能已成功解压到 /usr/local 但 PATH 里仍被旧 node/bun shim 遮蔽：
  # 先解除遮蔽再判定，避免把合格的安装当成失败而整包重下
  unshadow_node
  if ! node_ok; then
    if [[ -f "$node_tarball_tmp/$node_tarball" ]]; then
      step "node: extracting downloaded tarball"
      tar -xJf "$node_tarball_tmp/$node_tarball" -C /usr/local --strip-components=1
    else
      step "node: downloading and extracting (serial fallback)"
      curl -fsSL --retry 3 --retry-delay 2 "$node_url" | tar -xJ -C /usr/local --strip-components=1
    fi
  fi
  hash -r || true
  unshadow_node
}

# 新 node 装在 /usr/local/bin，但镜像可能把旧 node/bun shim 放在 PATH 更靠前的目录
# （freecad 镜像 /opt/conda/bin 在 /usr/local/bin 前；bun 镜像 shim 在末尾、不遮蔽）。
# 若解析结果不是刚装的 /usr/local/bin/node，把遮蔽点替换成指向新二进制的 symlink。
# 对 npm/npx 同样处理——它们的脚本靠 node 解释，绑在旧 node 上一样崩。
unshadow_node() {
  [[ -x /usr/local/bin/node ]] || return 0
  local name resolved
  for name in node npm npx; do
    [[ -x "/usr/local/bin/$name" ]] || continue
    resolved="$(command -v "$name" 2>/dev/null)" || continue
    [[ -n "$resolved" ]] || continue
    if [[ "$resolved" != "/usr/local/bin/$name" ]]; then
      # 遮蔽点已是解开过的 symlink（指向新二进制）时跳过，保持幂等且日志不重复
      if [[ "$(readlink -f "$resolved" 2>/dev/null)" = "$(readlink -f "/usr/local/bin/$name" 2>/dev/null)" ]]; then
        continue
      fi
      # 只动 symlink 或普通文件所在路径本身，不动目录；替换失败不阻断主流程
      if ln -sf "/usr/local/bin/$name" "$resolved" 2>/dev/null; then
        step "node: $resolved shadowed /usr/local/bin/$name, replaced with symlink"
      else
        step "node: warning: cannot replace shadowing $resolved"
      fi
    fi
  done
  hash -r || true
}

install_rg_fallback() {
  # --ignore-scripts 跳过了 @vscode/ripgrep 的 postinstall，bin/rg 缺失。
  # 发行版仓库的 rg 搭车装好的链进去；没有就放弃（ripgrepCandidates 容忍缺失，退化 PATH 查找）。
  if [[ -n "$rg_install_pid" ]]; then
    wait "$rg_install_pid" 2>/dev/null || true
  fi
  local target_dir
  [[ -d "$(npm root -g)/@ensocode/server" ]] || return 0
  target_dir="$(npm root -g)/@ensocode/server/node_modules/@vscode/ripgrep/bin"
  mkdir -p "$target_dir"
  if [[ -x "$target_dir/rg" ]]; then
    return 0
  fi
  if command -v rg >/dev/null 2>&1; then
    ln -sf "$(command -v rg)" "$target_dir/rg" 2>/dev/null || cp "$(command -v rg)" "$target_dir/rg"
    step "ripgrep: linked distro rg into @vscode/ripgrep/bin"
    return 0
  fi
  step "ripgrep: no rg available; workspace file search will be degraded"
}

server_package="${1:-}"

if need_node; then
  node_tarball_tmp="$(mktemp -d)"
  start_node_track
else
  step "node >= ${node_min_major}.${node_min_minor} already present, skipping node install"
fi

# 前台轨道：缺工具补工具，顺手把 ripgrep 排进同一个 apt 事务
want_rg=false
[[ -n "$server_package" ]] && ! command -v rg >/dev/null 2>&1 && want_rg=true

if command -v curl >/dev/null 2>&1 && command -v xz >/dev/null 2>&1; then
  if $want_rg && command -v apt-get >/dev/null 2>&1; then
    # apt update 本身要 20-60s，后台跑，由 install_rg_fallback 等它收尾
    step "apt: installing ripgrep (background)"
    ( apt-get update -qq && apt-get install -y -qq ripgrep >/dev/null 2>&1 ) &
    rg_install_pid=$!
  fi
  # node 后台轨道从一开始就能流式下载，不需要等任何 apt；哨兵直接写好
  touch /tmp/enso-install-apt.done
else
  pkgs=""
  command -v curl >/dev/null 2>&1 || pkgs="$pkgs curl ca-certificates"
  command -v xz >/dev/null 2>&1 || pkgs="$pkgs xz-utils"
  # shellcheck disable=SC2086
  if command -v apt-get >/dev/null 2>&1; then
    step "apt: installing$pkgs"
    apt-get update -qq
    # ripgrep 在 Debian/Ubuntu 官方源里，搭车同一个 update；装不上不阻断主流程
    if $want_rg; then
      # shellcheck disable=SC2086
      apt-get install -y -qq $pkgs ripgrep >/dev/null 2>&1 || {
        # shellcheck disable=SC2086
        apt-get install -y -qq $pkgs >/dev/null
        step "apt: ripgrep not available in this repo, rg will be missing"
      }
    else
      # shellcheck disable=SC2086
      apt-get install -y -qq $pkgs >/dev/null
    fi
    # 哨兵：告诉后台 node 轨道 apt 事务整体完成（CA/certificates 的 postinst 也跑完了）
    touch /tmp/enso-install-apt.done
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    pm=dnf
    command -v dnf >/dev/null 2>&1 || pm=yum
    rpms="$(echo "$pkgs" | sed 's/xz-utils/xz/')"
    step "$pm: installing$rpms"
    # shellcheck disable=SC2086
    "$pm" install -y $rpms
    $want_rg && { "$pm" install -y ripgrep >/dev/null 2>&1 || true; }
    touch /tmp/enso-install-apt.done
  else
    echo "need curl and xz to install Node.js; unsupported package manager" >&2
    exit 1
  fi
fi

step "finalizing node install"
finish_node_install

if ! node_ok; then
  echo "node >= ${node_min_major}.${node_min_minor} (real node, not a bun shim) is required but could not be installed" >&2
  exit 1
fi
node -v

if [[ -n "$server_package" ]]; then
  step "npm: installing enso-server (scripts skipped; rg provisioned separately)"
  # 从 / 执行：避免镜像默认 cwd（如 /app）干扰 npm 对上下文的解析。
  # --ignore-scripts 跳过 @vscode/ripgrep postinstall 的 GitHub API 下载，rg 由 install_rg_fallback 补
  (cd / && npm install -g --ignore-scripts --no-audit --no-fund "$server_package")
  install_rg_fallback
fi

if ! command -v enso-server >/dev/null 2>&1; then
  echo "enso-server is not on PATH. Pass the packed server tarball to install.sh." >&2
  exit 1
fi
enso-server run --help >/dev/null
step "install done"
