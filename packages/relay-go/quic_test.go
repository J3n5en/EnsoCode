package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go"
)

func generateTestTLSConfig(t *testing.T) *tls.Config {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	cert := tls.Certificate{
		Certificate: [][]byte{der},
		PrivateKey:  priv,
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{quicALPN},
		MinVersion:   tls.VersionTLS13,
	}
}

type testQuicClient struct {
	conn *quic.Conn
	ctl  *quic.Stream
	ctrl *quic.Stream
	bulk *quic.Stream
}

func dialTestQuicClient(t *testing.T, addr string, hello quicHello) *testQuicClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := quic.DialAddr(ctx, addr, &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{quicALPN},
		MinVersion:         tls.VersionTLS13,
	}, &quic.Config{
		MaxIdleTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("dial quic: %v", err)
	}
	openTyped := func(streamType byte) *quic.Stream {
		st, err := conn.OpenStreamSync(ctx)
		if err != nil {
			t.Fatalf("open stream %d: %v", streamType, err)
		}
		if _, err := st.Write([]byte{streamType}); err != nil {
			t.Fatalf("write stream type %d: %v", streamType, err)
		}
		return st
	}
	ctrl := openTyped(quicStreamCtrl)
	bulk := openTyped(quicStreamBulk)
	ctl := openTyped(quicStreamControl)

	b, err := json.Marshal(hello)
	if err != nil {
		t.Fatalf("marshal hello: %v", err)
	}
	if err := writeQuicFrame(ctl, b); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	return &testQuicClient{conn: conn, ctl: ctl, ctrl: ctrl, bulk: bulk}
}

func (c *testQuicClient) close() {
	_ = c.conn.CloseWithError(0, "done")
}

func readQuicControl(t *testing.T, st *quic.Stream) map[string]any {
	t.Helper()
	_ = st.SetReadDeadline(time.Now().Add(3 * time.Second))
	data, err := readQuicFrame(st)
	if err != nil {
		t.Fatalf("read control frame: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal control %q: %v", string(data), err)
	}
	return m
}

func readQuicData(t *testing.T, st *quic.Stream) []byte {
	t.Helper()
	_ = st.SetReadDeadline(time.Now().Add(3 * time.Second))
	data, err := readQuicFrame(st)
	if err != nil {
		t.Fatalf("read data frame: %v", err)
	}
	return data
}

func TestQuicGuestWithWsHostInteroperability(t *testing.T) {
	ts, srv := testServer(t)
	qs, err := startQuicServer(srv, "127.0.0.1:0", generateTestTLSConfig(t))
	if err != nil {
		t.Fatalf("start quic server: %v", err)
	}
	defer qs.Close()

	pairID, hostToken, guestToken := pairOnURL(t, ts.URL)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")
	hostWS, _, err := websocket.DefaultDialer.Dial(wsBase+"/v1/pair/"+pairID+"?role=host&token="+hostToken, nil)
	if err != nil {
		t.Fatalf("dial host ws: %v", err)
	}
	defer hostWS.Close()

	qc := dialTestQuicClient(t, qs.Addr().String(), quicHello{
		PairID: pairID,
		Role:   roleGuest,
		Token:  guestToken,
	})
	defer qc.close()

	online := readQuicControl(t, qc.ctl)
	if online["type"] != "host-online" {
		t.Fatalf("expected host-online, got %+v", online)
	}
	joined := readControlJSON(t, hostWS, 3*time.Second)
	if joined["type"] != "peer-joined" {
		t.Fatalf("expected peer-joined on host ws, got %+v", joined)
	}

	// Ping/Pong over QUIC control stream
	if err := writeQuicFrame(qc.ctl, []byte(`{"type":"ping","id":42}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	pong := readQuicControl(t, qc.ctl)
	if pong["type"] != "pong" || pong["id"] != float64(42) {
		t.Fatalf("expected pong id=42, got %+v", pong)
	}

	// Host WS -> QUIC Guest: small frame goes to ctrl stream, large frame (>=16KB) goes to bulk stream
	small := []byte("small-rpc-frame")
	large := bytes.Repeat([]byte("B"), quicBulkThreshold+128)
	if err := hostWS.WriteMessage(websocket.BinaryMessage, small); err != nil {
		t.Fatalf("host write small: %v", err)
	}
	if err := hostWS.WriteMessage(websocket.BinaryMessage, large); err != nil {
		t.Fatalf("host write large: %v", err)
	}
	gotSmall := readQuicData(t, qc.ctrl)
	if !bytes.Equal(gotSmall, small) {
		t.Fatalf("ctrl stream payload mismatch: got %q", string(gotSmall))
	}
	gotLarge := readQuicData(t, qc.bulk)
	if !bytes.Equal(gotLarge, large) {
		t.Fatalf("bulk stream payload mismatch: got len=%d", len(gotLarge))
	}

	// QUIC Guest -> Host WS: both ctrl and bulk arrive as WS binary frames
	upCtrl := []byte("guest-ctrl-cmd")
	upBulk := bytes.Repeat([]byte("U"), quicBulkThreshold+64)
	if err := writeQuicFrame(qc.ctrl, upCtrl); err != nil {
		t.Fatalf("guest write ctrl: %v", err)
	}
	if err := writeQuicFrame(qc.bulk, upBulk); err != nil {
		t.Fatalf("guest write bulk: %v", err)
	}
	received := map[int][]byte{}
	for i := 0; i < 2; i++ {
		_ = hostWS.SetReadDeadline(time.Now().Add(3 * time.Second))
		mt, data, err := hostWS.ReadMessage()
		if err != nil {
			t.Fatalf("host read %d: %v", i, err)
		}
		if mt != websocket.BinaryMessage {
			t.Fatalf("expected binary message, got %d", mt)
		}
		received[len(data)] = data
	}
	if !bytes.Equal(received[len(upCtrl)], upCtrl) || !bytes.Equal(received[len(upBulk)], upBulk) {
		t.Fatalf("host did not receive both ctrl and bulk payloads")
	}
}

func TestQuicHotBufResumeReplay(t *testing.T) {
	ts, srv := testServer(t)
	qs, err := startQuicServer(srv, "127.0.0.1:0", generateTestTLSConfig(t))
	if err != nil {
		t.Fatalf("start quic server: %v", err)
	}
	defer qs.Close()

	pairID, hostToken, guestToken := pairOnURL(t, ts.URL)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")
	hostWS, _, err := websocket.DefaultDialer.Dial(wsBase+"/v1/pair/"+pairID+"?role=host&token="+hostToken, nil)
	if err != nil {
		t.Fatalf("dial host ws: %v", err)
	}
	defer hostWS.Close()

	qc1 := dialTestQuicClient(t, qs.Addr().String(), quicHello{
		PairID: pairID,
		Role:   roleGuest,
		Token:  guestToken,
	})
	online1 := readQuicControl(t, qc1.ctl)
	epoch, _ := online1["relayEpoch"].(string)
	if epoch == "" {
		t.Fatalf("expected non-empty relayEpoch, got %+v", online1)
	}
	_ = readControlJSON(t, hostWS, 3*time.Second) // peer-joined

	// First frame received before disconnect
	if err := hostWS.WriteMessage(websocket.BinaryMessage, []byte("f1")); err != nil {
		t.Fatalf("write f1: %v", err)
	}
	if got := readQuicData(t, qc1.ctrl); string(got) != "f1" {
		t.Fatalf("expected f1, got %q", string(got))
	}
	qc1.close()
	_ = readControlJSON(t, hostWS, 3*time.Second) // peer-left

	// Host sends 2 frames while guest is disconnected
	if err := hostWS.WriteMessage(websocket.BinaryMessage, []byte("f2")); err != nil {
		t.Fatalf("write f2: %v", err)
	}
	if err := hostWS.WriteMessage(websocket.BinaryMessage, []byte("f3")); err != nil {
		t.Fatalf("write f3: %v", err)
	}
	time.Sleep(30 * time.Millisecond)

	since := uint64(1)
	qc2 := dialTestQuicClient(t, qs.Addr().String(), quicHello{
		PairID:        pairID,
		Role:          roleGuest,
		Token:         guestToken,
		RelayEpoch:    epoch,
		SinceRelaySeq: &since,
	})
	defer qc2.close()

	online2 := readQuicControl(t, qc2.ctl)
	if online2["type"] != "host-online" || online2["replayedFrom"] != float64(1) || online2["relaySeq"] != float64(3) {
		t.Fatalf("unexpected resume host-online: %+v", online2)
	}
	if got := readQuicData(t, qc2.ctrl); string(got) != "f2" {
		t.Fatalf("expected replayed f2, got %q", string(got))
	}
	if got := readQuicData(t, qc2.ctrl); string(got) != "f3" {
		t.Fatalf("expected replayed f3, got %q", string(got))
	}
}

func TestQuicAuthRejectedAndRevoke(t *testing.T) {
	ts, srv := testServer(t)
	qs, err := startQuicServer(srv, "127.0.0.1:0", generateTestTLSConfig(t))
	if err != nil {
		t.Fatalf("start quic server: %v", err)
	}
	defer qs.Close()

	pairID, _, guestToken := pairOnURL(t, ts.URL)

	// Bad token -> revoked
	bad := dialTestQuicClient(t, qs.Addr().String(), quicHello{
		PairID: pairID,
		Role:   roleGuest,
		Token:  "wrong-token",
	})
	defer bad.close()
	msg := readQuicControl(t, bad.ctl)
	if msg["type"] != "revoked" {
		t.Fatalf("expected revoked for bad token, got %+v", msg)
	}

	// Valid guest, then HTTP DELETE revokes active QUIC peer
	good := dialTestQuicClient(t, qs.Addr().String(), quicHello{
		PairID: pairID,
		Role:   roleGuest,
		Token:  guestToken,
	})
	defer good.close()
	if m := readQuicControl(t, good.ctl); m["type"] != "host-offline" {
		t.Fatalf("expected host-offline, got %+v", m)
	}

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/v1/pair/"+pairID+"?token="+guestToken, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("delete pair failed: %v %v", err, resp)
	}
	_ = resp.Body.Close()

	rev := readQuicControl(t, good.ctl)
	if rev["type"] != "revoked" {
		t.Fatalf("expected revoked on active quic peer, got %+v", rev)
	}
}

func TestHealthzReportsQuicPort(t *testing.T) {
	ts, srv := testServer(t)
	qs, err := startQuicServer(srv, "127.0.0.1:0", generateTestTLSConfig(t))
	if err != nil {
		t.Fatalf("start quic server: %v", err)
	}
	defer qs.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode healthz: %v", err)
	}
	expectedPort := qs.Addr().(*net.UDPAddr).Port
	if body["ok"] != true || body["quic"] != true || int(body["quicPort"].(float64)) != expectedPort || body["alpn"] != quicALPN {
		t.Fatalf("unexpected healthz body: %+v (expected port %d)", body, expectedPort)
	}
}

func pairOnURL(t *testing.T, baseURL string) (string, string, string) {
	t.Helper()
	code, req1 := postJSON(t, baseURL+"/v1/pair/request", map[string]string{"publicKey": testPublicKey})
	if code != http.StatusOK {
		t.Fatalf("request1 status=%d", code)
	}
	pairID := req1["pairId"].(string)
	code, claim := postJSON(t, baseURL+"/v1/pair/claim", map[string]string{
		"publicKey":  testPublicKey,
		"boxedKey":   "boxed-key",
		"deviceName": "ios-test",
	})
	if code != http.StatusOK {
		t.Fatalf("claim status=%d", code)
	}
	guestToken := claim["deviceToken"].(string)
	code, req2 := postJSON(t, baseURL+"/v1/pair/request", map[string]string{"publicKey": testPublicKey})
	if code != http.StatusOK {
		t.Fatalf("request2 status=%d", code)
	}
	hostToken := req2["hostToken"].(string)
	return pairID, hostToken, guestToken
}

func writeTempSelfSignedPEM(t *testing.T, dir, prefix, cn string) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	keyDer, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPath := filepath.Join(dir, prefix+".crt")
	keyPath := filepath.Join(dir, prefix+".key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer}), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath
}

func TestReloadingCertHotReloadAndFallback(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeTempSelfSignedPEM(t, dir, "relay", "first.example.com")
	loader, err := newReloadingCert(certPath, keyPath, nil)
	if err != nil {
		t.Fatalf("newReloadingCert: %v", err)
	}
	loader.checkInterval = 0

	c1, err := loader.getCertificate(nil)
	if err != nil || c1 == nil {
		t.Fatalf("getCertificate #1: %v", err)
	}
	x1, _ := x509.ParseCertificate(c1.Certificate[0])
	if x1.Subject.CommonName != "first.example.com" {
		t.Fatalf("expected CN first.example.com, got %s", x1.Subject.CommonName)
	}

	newCert, newKey := writeTempSelfSignedPEM(t, dir, "next", "renewed.example.com")
	bCert, _ := os.ReadFile(newCert)
	bKey, _ := os.ReadFile(newKey)
	_ = os.WriteFile(certPath, bCert, 0o600)
	_ = os.WriteFile(keyPath, bKey, 0o600)
	future := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(certPath, future, future)
	_ = os.Chtimes(keyPath, future, future)

	c2, err := loader.getCertificate(nil)
	if err != nil || c2 == nil {
		t.Fatalf("getCertificate #2: %v", err)
	}
	x2, _ := x509.ParseCertificate(c2.Certificate[0])
	if x2.Subject.CommonName != "renewed.example.com" {
		t.Fatalf("expected reloaded CN renewed.example.com, got %s", x2.Subject.CommonName)
	}

	_ = os.WriteFile(certPath, []byte("corrupted"), 0o600)
	future2 := future.Add(2 * time.Second)
	_ = os.Chtimes(certPath, future2, future2)
	c3, err := loader.getCertificate(nil)
	if err != nil || c3 == nil {
		t.Fatalf("expected fallback cert on corrupt reload, got err=%v", err)
	}
	x3, _ := x509.ParseCertificate(c3.Certificate[0])
	if x3.Subject.CommonName != "renewed.example.com" {
		t.Fatalf("expected fallback CN renewed.example.com, got %s", x3.Subject.CommonName)
	}
}
