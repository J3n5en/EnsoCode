#!/usr/bin/env bash
set -euo pipefail

# 真实跨语言端到端联调：启动真实 Go quic-go 中继 + WS 模拟 Host，
# 用 Apple Network.framework (NWProtocolQUIC) Swift 测试直连验证：
# 1) TLS 1.3 + ALPN enso-pair/1 建连与三流握手
# 2) control 流 host-online 与 ping/pong
# 3) ctrl (小帧) + bulk (20KB 大帧) 双车道无阻塞往返

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
RELAY_PID=""
HOST_PID=""

cleanup() {
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$TMP_DIR/key.pem" -out "$TMP_DIR/cert.pem" \
  -days 1 -nodes -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>/dev/null

echo "[e2e] building enso-relay..."
(cd "$ROOT/packages/relay-go" && go build -o "$TMP_DIR/enso-relay" .)

HTTP_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
QUIC_PORT="$(python3 -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

"$TMP_DIR/enso-relay" \
  --listen "127.0.0.1:$HTTP_PORT" \
  --quic-listen "127.0.0.1:$QUIC_PORT" \
  --tls-cert "$TMP_DIR/cert.pem" \
  --tls-key "$TMP_DIR/key.pem" \
  --db "$TMP_DIR/relay.sqlite" \
  --auto-update=false >"$TMP_DIR/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 50); do
  if curl -sk "https://127.0.0.1:$HTTP_PORT/healthz" | grep -q '"quic":true'; then
    break
  fi
  sleep 0.1
done

echo "[e2e] healthz: $(curl -sk "https://127.0.0.1:$HTTP_PORT/healthz")"

# 通过 Node.js 配对并启动回声 Host WS（收到任意二进制帧原样回发，校验 QUIC ctrl/bulk 分流）
cat >"$TMP_DIR/host.mjs" <<'EOF'
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = process.env.BASE_URL;
const outFile = process.env.OUT_FILE;

const pubKey = randomBytes(32).toString('base64url');
const r1 = await fetch(`${base}/v1/pair/request`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ publicKey: pubKey }),
}).then((r) => r.json());
const cl = await fetch(`${base}/v1/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ publicKey: pubKey, boxedKey: 'e2e-box', deviceName: 'ios-e2e' }),
}).then((r) => r.json());
const r2 = await fetch(`${base}/v1/pair/request`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ publicKey: pubKey }),
}).then((r) => r.json());

const wsUrl = `${base.replace(/^https/, 'wss')}/v1/pair/${r1.pairId}?role=host&token=${r2.hostToken}`;
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';
ws.onopen = () => {
  fs.writeFileSync(outFile, JSON.stringify({ pairId: r1.pairId, guestToken: cl.deviceToken }));
};
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') return;
  ws.send(ev.data);
};
setInterval(() => {}, 60000);
EOF

BASE_URL="https://127.0.0.1:$HTTP_PORT" OUT_FILE="$TMP_DIR/pair.json" node "$TMP_DIR/host.mjs" &
HOST_PID=$!

for _ in $(seq 1 50); do
  [[ -f "$TMP_DIR/pair.json" ]] && break
  sleep 0.1
done

PAIR_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP_DIR/pair.json','utf8')).pairId)")"
GUEST_TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP_DIR/pair.json','utf8')).guestToken)")"

echo "[e2e] running Swift NWProtocolQUIC <-> Go quic-go interop test (port $QUIC_PORT)..."
(
  cd "$ROOT/packages/ios-app"
  ENSO_QUIC_E2E_PORT="$QUIC_PORT" \
  ENSO_QUIC_E2E_PAIR_ID="$PAIR_ID" \
  ENSO_QUIC_E2E_TOKEN="$GUEST_TOKEN" \
  swift test --filter testLiveQuicInteropWithGoRelay
)
