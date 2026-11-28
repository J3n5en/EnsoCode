package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testGenP256PEM(t *testing.T) (*ecdsa.PrivateKey, string, []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})
	rawPub := make([]byte, 65)
	rawPub[0] = 0x04
	priv.PublicKey.X.FillBytes(rawPub[1:33])
	priv.PublicKey.Y.FillBytes(rawPub[33:65])
	return priv, string(pemBytes), rawPub
}

func testSignVapid(t *testing.T, priv *ecdsa.PrivateKey, rawPub []byte, aud string, exp int64) string {
	t.Helper()
	hJSON, _ := json.Marshal(map[string]string{"typ": "JWT", "alg": "ES256"})
	pJSON, _ := json.Marshal(map[string]any{"aud": aud, "exp": exp, "sub": "https://enso.test"})
	input := base64.RawURLEncoding.EncodeToString(hJSON) + "." + base64.RawURLEncoding.EncodeToString(pJSON)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatalf("sign vapid: %v", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + input + "." + base64.RawURLEncoding.EncodeToString(sig) + ", k=" + base64.RawURLEncoding.EncodeToString(rawPub)
}

func TestGoAPNSGatewayE2EAndVapid(t *testing.T) {
	_, apnsPEM, _ := testGenP256PEM(t)
	vapidPriv, _, vapidPub := testGenP256PEM(t)
	otherPriv, _, otherPub := testGenP256PEM(t)
	pubSum := sha256.Sum256(vapidPub)
	kHash := base64.RawURLEncoding.EncodeToString(pubSum[:])

	var gotPath string
	var gotTopic string
	var gotPushType string
	var gotAuth []string
	var gotBody map[string]any
	apnsStatus := http.StatusOK
	apnsRespBody := ""

	mockAPNS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotTopic = r.Header.Get("apns-topic")
		gotPushType = r.Header.Get("apns-push-type")
		gotAuth = append(gotAuth, r.Header.Get("authorization"))
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(apnsStatus)
		if apnsRespBody != "" {
			_, _ = io.WriteString(w, apnsRespBody)
		}
	}))
	defer mockAPNS.Close()

	gw, err := newAPNSGateway(&apnsConfig{
		PrivateKeyPEM: apnsPEM,
		KeyID:         "KEY1234567",
		TeamID:        "69GW9UBCN2",
		Topic:         "com.j3n5en.ensocode",
	})
	if err != nil {
		t.Fatalf("newAPNSGateway: %v", err)
	}
	now := time.Unix(1_760_000_000, 0)
	gw.now = func() time.Time { return now }
	gw.prodBaseURL = mockAPNS.URL
	gw.sandBaseURL = mockAPNS.URL
	gw.client = mockAPNS.Client()

	st, err := openStore(filepath.Join(t.TempDir(), "relay.sqlite"))
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	defer st.close()
	srv := newServer(st, nil, nil)
	srv.apns = gw

	// /healthz 报告 apns: true
	hw := httptest.NewRecorder()
	srv.ServeHTTP(hw, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if hw.Code != http.StatusOK || !strings.Contains(hw.Body.String(), `"apns":true`) {
		t.Fatalf("healthz unexpected: %d %s", hw.Code, hw.Body.String())
	}

	tokenHex := strings.Repeat("b2", 32)
	ciphertext := []byte{10, 20, 30, 40, 50, 60}
	auth := testSignVapid(t, vapidPriv, vapidPub, "https://relay.applekk.com", now.Unix()+3600)

	// 1. 合法请求（带反代 X-Forwarded-Proto）透传密文并返回 201
	req := httptest.NewRequest(http.MethodPost, "http://relay.applekk.com/v1/push/apns/prod/"+tokenHex+"?k="+kHash, bytes.NewReader(ciphertext))
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", "1200")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if gotPath != "/3/device/"+tokenHex || gotTopic != "com.j3n5en.ensocode" || gotPushType != "alert" {
		t.Fatalf("unexpected APNs call: path=%s topic=%s type=%s", gotPath, gotTopic, gotPushType)
	}
	ensoObj, _ := gotBody["enso"].(map[string]any)
	if ensoObj["c"] != base64.StdEncoding.EncodeToString(ciphertext) {
		t.Fatalf("ciphertext mismatch: %+v", gotBody)
	}

	// 2. 再次发送复用 APNs provider JWT
	req2 := httptest.NewRequest(http.MethodPost, "http://relay.applekk.com/v1/push/apns/prod/"+tokenHex+"?k="+kHash, bytes.NewReader(ciphertext))
	req2.Header.Set("X-Forwarded-Proto", "https")
	req2.Header.Set("Authorization", auth)
	req2.Header.Set("Content-Encoding", "aes128gcm")
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, req2)
	if w2.Code != http.StatusCreated || len(gotAuth) != 2 || gotAuth[0] != gotAuth[1] {
		t.Fatalf("expected cached APNs JWT reuse, got code=%d auths=%d", w2.Code, len(gotAuth))
	}

	// 3. 公钥不匹配直接 403
	badAuth := testSignVapid(t, otherPriv, otherPub, "https://relay.applekk.com", now.Unix()+3600)
	req3 := httptest.NewRequest(http.MethodPost, "http://relay.applekk.com/v1/push/apns/prod/"+tokenHex+"?k="+kHash, bytes.NewReader(ciphertext))
	req3.Header.Set("X-Forwarded-Proto", "https")
	req3.Header.Set("Authorization", badAuth)
	req3.Header.Set("Content-Encoding", "aes128gcm")
	w3 := httptest.NewRecorder()
	srv.ServeHTTP(w3, req3)
	if w3.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w3.Code)
	}

	// 4. APNs BadDeviceToken 映射 410
	apnsStatus = http.StatusBadRequest
	apnsRespBody = `{"reason":"BadDeviceToken"}`
	req4 := httptest.NewRequest(http.MethodPost, "http://relay.applekk.com/v1/push/apns/sandbox/"+tokenHex+"?k="+kHash, bytes.NewReader(ciphertext))
	req4.Header.Set("X-Forwarded-Proto", "https")
	req4.Header.Set("Authorization", auth)
	req4.Header.Set("Content-Encoding", "aes128gcm")
	w4 := httptest.NewRecorder()
	srv.ServeHTTP(w4, req4)
	if w4.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d: %s", w4.Code, w4.Body.String())
	}
}
