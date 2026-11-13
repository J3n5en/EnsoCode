package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

// 真实客户端（@enso/pair startHostPairing）上报的格式：32 字节 NaCl box 公钥的 base64url，43 字符
var testPublicKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))

func testServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	st, err := openStore(filepath.Join(t.TempDir(), "relay.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.close() })
	static, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		t.Fatal(err)
	}
	srv := newServer(st, static, nil)
	var now int64 = 1000
	srv.now = func() int64 { return now }
	hs := httptest.NewServer(srv)
	t.Cleanup(hs.Close)
	return hs, srv
}

func postJSON(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Post(url, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]any{}
	if len(bytes.TrimSpace(b)) > 0 && bytes.Contains(bytes.TrimSpace(b), []byte("{")) {
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatalf("json %s: %v", b, err)
		}
	}
	return res.StatusCode, out
}

func TestOptionsCORS(t *testing.T) {
	hs, _ := testServer(t)
	req, _ := http.NewRequest(http.MethodOptions, hs.URL+"/v1/pair/request", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", res.StatusCode)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("cors %q", res.Header.Get("Access-Control-Allow-Origin"))
	}
}

func TestRequestValidation(t *testing.T) {
	hs, _ := testServer(t)
	res, err := http.Post(hs.URL+"/v1/pair/request", "application/json", strings.NewReader("{"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid json status %d", res.StatusCode)
	}
	code, body := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{})
	if code != http.StatusBadRequest || body["error"] != "missing publicKey" {
		t.Fatalf("%d %#v", code, body)
	}
}

func TestPairHandshakeAndCredentialWindow(t *testing.T) {
	hs, srv := testServer(t)
	code, body := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	if code != 200 || body["state"] != "requested" {
		t.Fatalf("request %#v", body)
	}
	pairID := body["pairId"].(string)
	if pairID != pairIDFromPublicKey(testPublicKey) {
		t.Fatalf("pairId %s", pairID)
	}

	code, body = postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{"publicKey": testPublicKey})
	if code != http.StatusBadRequest || body["error"] != "missing boxedKey" {
		t.Fatalf("claim missing boxedKey %d %#v", code, body)
	}

	code, body = postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{
		"publicKey":  testPublicKey,
		"boxedKey":   "boxed",
		"deviceName": "iphone",
	})
	if code != 200 || body["state"] != "authorized" || body["deviceToken"] == nil {
		t.Fatalf("claim %#v", body)
	}
	deviceToken := body["deviceToken"].(string)

	code, body = postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	if code != 200 || body["hostToken"] == nil || body["response"] != "boxed" || body["deviceName"] != "iphone" {
		t.Fatalf("credentials %#v", body)
	}
	hostToken := body["hostToken"].(string)

	code, body = postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{
		"publicKey": testPublicKey,
		"boxedKey":  "other",
	})
	if code != http.StatusConflict || body["error"] != "already claimed" {
		t.Fatalf("second claim %d %#v", code, body)
	}

	srv.now = func() int64 { return 1000 + credentialWindowMS + 1 }
	code, body = postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	if code != 200 || body["state"] != "authorized" || body["hostToken"] != nil {
		t.Fatalf("closed window %#v", body)
	}

	req, _ := http.NewRequest(http.MethodDelete, hs.URL+"/v1/pair/"+pairID+"?token=nope", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("delete unauth %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodDelete, hs.URL+"/v1/pair/"+pairID+"?token="+deviceToken, nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("delete %d", res.StatusCode)
	}
	_ = hostToken
}

func TestClaimNoPending(t *testing.T) {
	hs, _ := testServer(t)
	code, body := postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{
		"publicKey": "nobody",
		"boxedKey":  "boxed",
	})
	if code != http.StatusConflict || body["error"] != "no pending pair" {
		t.Fatalf("%d %#v", code, body)
	}
}

func TestHTTPClaimExpired(t *testing.T) {
	hs, srv := testServer(t)
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	srv.now = func() int64 { return 1000 + pairTTLMS + 1 }
	code, body := postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{
		"publicKey": testPublicKey,
		"boxedKey":  "boxed",
	})
	if code != http.StatusConflict || body["error"] != "pair code expired" {
		t.Fatalf("%d %#v", code, body)
	}
}

func keyOf(b byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{b}, 32))
}

// /v1/pair/request 不鉴权且会落库：只收真实客户端的公钥格式，否则任意内容（最长约 1MB）
// 都会以 sha256 为键永久写进 relay.sqlite，循环 POST 就能写满磁盘。
func TestRequestRejectsMalformedPublicKey(t *testing.T) {
	hs, srv := testServer(t)
	cases := map[string]string{
		"过短":            "abc123",
		"超长":            strings.Repeat("A", 512<<10),
		"多一个字符":         testPublicKey + "A",
		"少一个字符":         testPublicKey[1:],
		"含标准 base64 字符": "+" + testPublicKey[1:],
		"带填充":           testPublicKey[:42] + "=",
	}
	for name, pk := range cases {
		code, body := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": pk})
		if code != http.StatusBadRequest || body["error"] != "invalid publicKey" {
			t.Fatalf("%s: %d %#v", name, code, body)
		}
		if st, err := srv.store.get(pairIDFromPublicKey(pk)); err != nil || st != nil {
			t.Fatalf("%s: 不该落库 %#v %v", name, st, err)
		}
	}
}

// 过期未认领的配对码不能永久占着存储：之后任意一次 request 顺带清掉（口径同 isExpired），
// 未过期的码与已认领的配对（重连要用）保留。
func TestRequestPrunesExpiredPairs(t *testing.T) {
	hs, srv := testServer(t)
	expired, paired, fresh, later := keyOf(1), keyOf(2), keyOf(3), keyOf(4)
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": expired})
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": paired})
	postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{"publicKey": paired, "boxedKey": "boxed"})
	srv.now = func() int64 { return 1000 + pairTTLMS/2 }
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": fresh})
	srv.now = func() int64 { return 1000 + pairTTLMS + 1 }
	if code, body := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": later}); code != 200 {
		t.Fatalf("request %d %#v", code, body)
	}

	for pk, keep := range map[string]bool{expired: false, paired: true, fresh: true, later: true} {
		st, err := srv.store.get(pairIDFromPublicKey(pk))
		if err != nil {
			t.Fatal(err)
		}
		if (st != nil) != keep {
			t.Fatalf("publicKey %s: 期望保留=%v，实际 %#v", pk, keep, st)
		}
	}
}

// 坏数据不能卡住清理：解析不了的行原样跳过，其余过期码照删，请求照常成功。
func TestRequestPruneSkipsCorruptRow(t *testing.T) {
	hs, srv := testServer(t)
	if _, err := srv.store.db.Exec(`INSERT INTO pairs (id, state) VALUES ('corrupt', '{')`); err != nil {
		t.Fatal(err)
	}
	expired := keyOf(1)
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": expired})
	srv.now = func() int64 { return 1000 + pairTTLMS + 1 }
	if code, body := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": keyOf(2)}); code != 200 {
		t.Fatalf("request %d %#v", code, body)
	}
	if st, err := srv.store.get(pairIDFromPublicKey(expired)); err != nil || st != nil {
		t.Fatalf("过期码未被清理 %#v %v", st, err)
	}
}

func TestStaticIndex(t *testing.T) {
	hs, _ := testServer(t)
	res, err := http.Get(hs.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !bytes.Contains(b, []byte("enso-relay")) && !bytes.Contains(b, []byte("EnsoCode")) {
		t.Fatalf("index %d %s", res.StatusCode, b)
	}
	res, err = http.Get(hs.URL + "/not-a-real-route")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("spa fallback %d", res.StatusCode)
	}
}

func TestStaticDeskShellNotCached(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "relay.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.close() })
	static := fstest.MapFS{
		"index.html":      {Data: []byte("phone")},
		"desk.html":       {Data: []byte("desk")},
		"assets/app-1.js": {Data: []byte("js")},
	}
	hs := httptest.NewServer(newServer(st, static, nil))
	t.Cleanup(hs.Close)
	get := func(p string) (string, string) {
		res, err := http.Get(hs.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return string(b), res.Header.Get("Cache-Control")
	}
	for _, p := range []string{"/desk.html", "/desk"} {
		if body, cc := get(p); body != "desk" || cc != "no-cache" {
			t.Fatalf("%s => %q %q", p, body, cc)
		}
	}
	if _, cc := get("/assets/app-1.js"); !strings.Contains(cc, "immutable") {
		t.Fatalf("asset cache %q", cc)
	}
}

func pairRoom(t *testing.T) (hs *httptest.Server, pairID, hostToken, deviceToken string) {
	t.Helper()
	hs, _ = testServer(t)
	postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	_, claimBody := postJSON(t, hs.URL+"/v1/pair/claim", map[string]any{
		"publicKey":  testPublicKey,
		"boxedKey":   "boxed",
		"deviceName": "phone",
	})
	_, reqBody := postJSON(t, hs.URL+"/v1/pair/request", map[string]any{"publicKey": testPublicKey})
	return hs, reqBody["pairId"].(string), reqBody["hostToken"].(string), claimBody["deviceToken"].(string)
}

func dialWS(t *testing.T, hs *httptest.Server, pairID, role, token string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(hs.URL, "http") + "/v1/pair/" + pairID + "?role=" + role + "&token=" + token
	conn, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readJSONType(t *testing.T, conn *websocket.Conn, timeout time.Duration) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var msg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("ws json %s: %v", data, err)
	}
	return msg.Type
}

func TestWSRevokedHandshake(t *testing.T) {
	hs, pairID, _, _ := pairRoom(t)
	u := "ws" + strings.TrimPrefix(hs.URL, "http") + "/v1/pair/" + pairID + "?role=host&token=nope"
	conn, res, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", res.StatusCode)
	}
	_, _, err = conn.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("close %v", err)
	}
	if ce.Text != "revoked" {
		t.Fatalf("reason %q", ce.Text)
	}
}

func TestWSBadRole(t *testing.T) {
	hs, pairID, hostToken, _ := pairRoom(t)
	u := "ws" + strings.TrimPrefix(hs.URL, "http") + "/v1/pair/" + pairID + "?role=other&token=" + hostToken
	_, res, err := websocket.DefaultDialer.Dial(u, nil)
	if err == nil {
		t.Fatal("expected reject")
	}
	if res == nil || res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %#v %v", res, err)
	}
}

func TestWSPingPongAndForward(t *testing.T) {
	hs, pairID, hostToken, deviceToken := pairRoom(t)
	guest := dialWS(t, hs, pairID, roleGuest, deviceToken)
	if got := readJSONType(t, guest, time.Second); got != "host-offline" {
		t.Fatalf("guest first %s", got)
	}
	host := dialWS(t, hs, pairID, roleHost, hostToken)
	if got := readJSONType(t, guest, time.Second); got != "host-online" {
		t.Fatalf("guest host-online %s", got)
	}
	if got := readJSONType(t, host, time.Second); got != "peer-joined" {
		t.Fatalf("host peer-joined %s", got)
	}

	if err := host.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_ = host.SetReadDeadline(time.Now().Add(time.Second))
	mt, data, err := host.ReadMessage()
	if err != nil || mt != websocket.TextMessage || string(data) != "pong" {
		t.Fatalf("pong %d %q %v", mt, data, err)
	}
	time.Sleep(30 * time.Millisecond)
	if err := host.WriteMessage(websocket.TextMessage, []byte(`{"enc":1}`)); err != nil {
		t.Fatal(err)
	}
	_ = guest.SetReadDeadline(time.Now().Add(time.Second))
	mt, data, err = guest.ReadMessage()
	if err != nil || mt != websocket.TextMessage || string(data) != `{"enc":1}` {
		t.Fatalf("forward %d %q %v", mt, data, err)
	}

	if err := guest.WriteMessage(websocket.BinaryMessage, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	_ = host.SetReadDeadline(time.Now().Add(time.Second))
	mt, data, err = host.ReadMessage()
	if err != nil || mt != websocket.BinaryMessage || string(data) != "\x01\x02\x03" {
		t.Fatalf("binary %d %q %v", mt, data, err)
	}
}

func TestWSReplaceDoesNotBroadcastOffline(t *testing.T) {
	hs, pairID, hostToken, deviceToken := pairRoom(t)
	guest := dialWS(t, hs, pairID, roleGuest, deviceToken)
	_ = readJSONType(t, guest, time.Second) // host-offline
	host1 := dialWS(t, hs, pairID, roleHost, hostToken)
	_ = readJSONType(t, guest, time.Second) // host-online
	_ = readJSONType(t, host1, time.Second) // peer-joined

	host2 := dialWS(t, hs, pairID, roleHost, hostToken)
	_, _, err := host1.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != websocket.CloseNormalClosure {
		t.Fatalf("replaced close %v", err)
	}
	if got := readJSONType(t, guest, time.Second); got != "host-online" {
		t.Fatalf("guest after replace %s", got)
	}
	if got := readJSONType(t, host2, time.Second); got != "peer-joined" {
		t.Fatalf("new host %s", got)
	}
	if err := host2.WriteMessage(websocket.TextMessage, []byte("still")); err != nil {
		t.Fatal(err)
	}
	_ = guest.SetReadDeadline(time.Now().Add(time.Second))
	_, data, err := guest.ReadMessage()
	if err != nil || string(data) != "still" {
		t.Fatalf("new host forward %q %v", data, err)
	}
}

func TestWSRevokeFrame(t *testing.T) {
	hs, pairID, hostToken, deviceToken := pairRoom(t)
	guest := dialWS(t, hs, pairID, roleGuest, deviceToken)
	_ = readJSONType(t, guest, time.Second)
	host := dialWS(t, hs, pairID, roleHost, hostToken)
	_ = readJSONType(t, guest, time.Second)
	_ = readJSONType(t, host, time.Second)

	req, _ := http.NewRequest(http.MethodDelete, hs.URL+"/v1/pair/"+pairID+"?token="+hostToken, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("delete %d", res.StatusCode)
	}
	if got := readJSONType(t, guest, time.Second); got != "revoked" {
		t.Fatalf("guest %s", got)
	}
	if got := readJSONType(t, host, time.Second); got != "revoked" {
		t.Fatalf("host %s", got)
	}
	_, _, err = guest.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("guest close %v", err)
	}
}

// flood 让 conn 连发 n 帧 512KB 业务帧，最后发 ping；写被堵住时最多卡到写超时。
func flood(conn *websocket.Conn, n int) {
	go func() {
		_ = conn.SetWriteDeadline(time.Now().Add(8 * time.Second))
		payload := make([]byte, 512<<10)
		for i := 0; i < n; i++ {
			if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				return
			}
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte("ping"))
	}()
}

// waitFrame 一直读到 match 为真的帧（跳过其余帧）；超时或连接出错返回 false。
func waitFrame(conn *websocket.Conn, timeout time.Duration, match func(mt int, data []byte) bool) bool {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return false
		}
		if match(mt, data) {
			return true
		}
	}
}

func isText(want string) func(int, []byte) bool {
	return func(mt int, data []byte) bool { return mt == websocket.TextMessage && string(data) == want }
}

// slowGuestRoom 建好房间：guest 读完首帧后不再读，模拟弱网下收不动的手机。
func slowGuestRoom(t *testing.T) (host, guest *websocket.Conn) {
	t.Helper()
	hs, pairID, hostToken, deviceToken := pairRoom(t)
	guest = dialWS(t, hs, pairID, roleGuest, deviceToken)
	_ = readJSONType(t, guest, time.Second) // host-offline
	host = dialWS(t, hs, pairID, roleHost, hostToken)
	_ = readJSONType(t, host, time.Second) // peer-joined
	return host, guest
}

// 真实场景：手机弱网收得慢，桌面在流式输出 / 下发大快照。中继读循环若因对端队列满而阻塞，
// 同一循环里的 ping→pong 也跟着停，桌面 8s 心跳判死、拆链重连。
func TestWSSlowGuestDoesNotBlockHostPing(t *testing.T) {
	host, _ := slowGuestRoom(t)
	flood(host, 96)
	if !waitFrame(host, 5*time.Second, isText("pong")) {
		t.Fatal("host 的 ping 没有及时收到 pong：读循环被慢接收端堵住")
	}
}

// 慢端积压超限就拆掉它，而不是静默丢帧：业务帧要么按序送达，要么断线后靠重连重新同步，
// 不会留下两端都察觉不到的缺口（残缺快照）。对端随之收到 peer-left。
func TestWSSlowGuestIsDisconnected(t *testing.T) {
	host, guest := slowGuestRoom(t)
	flood(host, 96)
	peerLeft := func(mt int, data []byte) bool {
		return mt == websocket.TextMessage && string(data) == `{"type":"peer-left"}`
	}
	if !waitFrame(host, 5*time.Second, peerLeft) {
		t.Fatal("慢接收端积压超限后没有被拆链")
	}
	_ = guest.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, _, err := guest.ReadMessage()
		if err == nil {
			continue // 拆链前已在内核缓冲里的帧照常读完
		}
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatal("慢接收端的连接没有被中继关闭")
		}
		break
	}
}

func TestWSPeerLeft(t *testing.T) {
	hs, pairID, hostToken, deviceToken := pairRoom(t)
	guest := dialWS(t, hs, pairID, roleGuest, deviceToken)
	_ = readJSONType(t, guest, time.Second)
	host := dialWS(t, hs, pairID, roleHost, hostToken)
	_ = readJSONType(t, guest, time.Second)
	_ = readJSONType(t, host, time.Second)
	_ = guest.Close()
	if got := readJSONType(t, host, time.Second); got != "peer-left" {
		t.Fatalf("host %s", got)
	}
}
