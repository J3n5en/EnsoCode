package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultAPNSTopic       = "com.j3n5en.ensocode"
	apnsMaxCiphertextBytes = 3000
	apnsMaxLiveActBytes    = 3500
	apnsJWTTTL             = 45 * time.Minute
	vapidClockSkewSec      = 60
	vapidMaxExpSec         = 24*3600 + 60
)

type apnsGateway struct {
	privKey *ecdsa.PrivateKey
	keyID   string
	teamID  string
	topic   string

	client       *http.Client
	prodBaseURL  string
	sandBaseURL  string
	now          func() time.Time
	mu           sync.Mutex
	cachedToken  string
	cachedIssued time.Time
}

type apnsConfig struct {
	PrivateKeyPEM string
	KeyID         string
	TeamID        string
	Topic         string
}

func loadAPNSConfigFromEnv() (*apnsConfig, error) {
	keyID := strings.TrimSpace(os.Getenv("RELAY_APNS_KEY_ID"))
	teamID := strings.TrimSpace(os.Getenv("RELAY_APNS_TEAM_ID"))
	keyFile := strings.TrimSpace(os.Getenv("RELAY_APNS_KEY_FILE"))
	keyInline := strings.TrimSpace(os.Getenv("RELAY_APNS_PRIVATE_KEY"))
	if keyID == "" && teamID == "" && keyFile == "" && keyInline == "" {
		return nil, nil
	}
	if keyID == "" || teamID == "" || (keyFile == "" && keyInline == "") {
		return nil, errors.New("incomplete RELAY_APNS_* config: need KEY_ID, TEAM_ID and KEY_FILE or PRIVATE_KEY")
	}
	var pemStr string
	if keyFile != "" {
		raw, err := os.ReadFile(keyFile)
		if err != nil {
			return nil, fmt.Errorf("read RELAY_APNS_KEY_FILE: %w", err)
		}
		pemStr = string(raw)
	} else {
		pemStr = strings.ReplaceAll(keyInline, `\n`, "\n")
	}
	topic := strings.TrimSpace(os.Getenv("RELAY_APNS_TOPIC"))
	if topic == "" {
		topic = defaultAPNSTopic
	}
	return &apnsConfig{
		PrivateKeyPEM: pemStr,
		KeyID:         keyID,
		TeamID:        teamID,
		Topic:         topic,
	}, nil
}

func newAPNSGateway(cfg *apnsConfig) (*apnsGateway, error) {
	if cfg == nil {
		return nil, nil
	}
	priv, err := parseP256PrivateKeyPEM(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	topic := strings.TrimSpace(cfg.Topic)
	if topic == "" {
		topic = defaultAPNSTopic
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ForceAttemptHTTP2 = true
	return &apnsGateway{
		privKey:     priv,
		keyID:       strings.TrimSpace(cfg.KeyID),
		teamID:      strings.TrimSpace(cfg.TeamID),
		topic:       topic,
		client:      &http.Client{Transport: tr, Timeout: 15 * time.Second},
		prodBaseURL: "https://api.push.apple.com",
		sandBaseURL: "https://api.sandbox.push.apple.com",
		now:         time.Now,
	}, nil
}

func parseP256PrivateKeyPEM(pemText string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("invalid APNs PEM private key")
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		ec, ok := parsed.(*ecdsa.PrivateKey)
		if !ok || ec.Curve != elliptic.P256() {
			return nil, errors.New("APNs private key must be P-256 ECDSA")
		}
		return ec, nil
	}
	if ec, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		if ec.Curve != elliptic.P256() {
			return nil, errors.New("APNs private key must be P-256 ECDSA")
		}
		return ec, nil
	}
	return nil, errors.New("failed to parse APNs ECDSA private key")
}

func (g *apnsGateway) providerJWT() (string, error) {
	now := g.now()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cachedToken != "" && now.Sub(g.cachedIssued) < apnsJWTTTL {
		return g.cachedToken, nil
	}
	headerJSON, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": g.keyID})
	claimsJSON, _ := json.Marshal(map[string]any{"iss": g.teamID, "iat": now.Unix()})
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, g.privKey, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	token := signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
	g.cachedToken = token
	g.cachedIssued = now
	return token, nil
}

func parseAPNSPath(p string) (envName, token string, ok bool) {
	const prefix = "/v1/push/apns/"
	if !strings.HasPrefix(p, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(p, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		return "", "", false
	}
	envName, token = parts[0], parts[1]
	if envName != "prod" && envName != "sandbox" {
		return "", "", false
	}
	if !isHexToken(token) {
		return "", "", false
	}
	return envName, token, true
}

func isHexToken(s string) bool {
	if len(s) < 64 || len(s) > 256 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func parseVapidAuth(header string) (jwtToken, pubKeyB64 string, ok bool) {
	trimmed := strings.TrimSpace(header)
	if len(trimmed) < 6 || !strings.EqualFold(trimmed[:5], "vapid") || (trimmed[5] != ' ' && trimmed[5] != '\t') {
		return "", "", false
	}
	rest := strings.TrimSpace(trimmed[5:])
	for _, part := range strings.Split(rest, ",") {
		k, v, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "t":
			jwtToken = strings.TrimSpace(v)
		case "k":
			pubKeyB64 = strings.TrimSpace(v)
		}
	}
	return jwtToken, pubKeyB64, jwtToken != "" && pubKeyB64 != ""
}

func requestOriginFromHTTP(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fp := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); fp != "" {
		scheme = strings.TrimSuffix(fp, ":")
	}
	host := r.Host
	if fh := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); fh != "" {
		host = fh
	}
	return scheme + "://" + host
}

func verifyVapidHTTP(r *http.Request, expectedHash string, now time.Time) (int, string) {
	jwtToken, pubB64, ok := parseVapidAuth(r.Header.Get("Authorization"))
	if !ok {
		return http.StatusUnauthorized, "missing vapid authorization"
	}
	rawPub, err := base64.RawURLEncoding.DecodeString(pubB64)
	if err != nil || len(rawPub) != 65 || rawPub[0] != 0x04 {
		return http.StatusUnauthorized, "invalid vapid public key"
	}
	if _, err := ecdh.P256().NewPublicKey(rawPub); err != nil {
		return http.StatusUnauthorized, "invalid vapid curve point"
	}
	sum := sha256.Sum256(rawPub)
	if base64.RawURLEncoding.EncodeToString(sum[:]) != expectedHash {
		return http.StatusForbidden, "vapid key mismatch"
	}

	segs := strings.Split(jwtToken, ".")
	if len(segs) != 3 {
		return http.StatusUnauthorized, "invalid vapid jwt"
	}
	hBytes, err1 := base64.RawURLEncoding.DecodeString(segs[0])
	pBytes, err2 := base64.RawURLEncoding.DecodeString(segs[1])
	sigBytes, err3 := base64.RawURLEncoding.DecodeString(segs[2])
	if err1 != nil || err2 != nil || err3 != nil || len(sigBytes) != 64 {
		return http.StatusUnauthorized, "invalid vapid jwt encoding"
	}

	var hdr struct {
		Alg string `json:"alg"`
	}
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(hBytes, &hdr) != nil || json.Unmarshal(pBytes, &claims) != nil {
		return http.StatusUnauthorized, "invalid vapid jwt json"
	}
	if hdr.Alg != "ES256" {
		return http.StatusUnauthorized, "unsupported vapid alg"
	}
	nowSec := now.Unix()
	if claims.Exp < nowSec-vapidClockSkewSec || claims.Exp > nowSec+vapidMaxExpSec {
		return http.StatusUnauthorized, "vapid jwt expired"
	}
	expectedAud := requestOriginFromHTTP(r)
	if strings.TrimSuffix(claims.Aud, "/") != expectedAud {
		return http.StatusUnauthorized, "vapid aud mismatch"
	}

	pub := &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(rawPub[1:33]),
		Y:     new(big.Int).SetBytes(rawPub[33:65]),
	}
	signingDigest := sha256.Sum256([]byte(segs[0] + "." + segs[1]))
	rInt := new(big.Int).SetBytes(sigBytes[:32])
	sInt := new(big.Int).SetBytes(sigBytes[32:])
	if !ecdsa.Verify(pub, signingDigest[:], rInt, sInt) {
		return http.StatusUnauthorized, "invalid vapid signature"
	}
	return 0, ""
}

func (s *Server) handleAPNSPush(w http.ResponseWriter, r *http.Request, envName, deviceToken string) {
	if s.apns == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "apns not configured"})
		return
	}
	expectedHash := r.URL.Query().Get("k")
	if len(expectedHash) < 32 || len(expectedHash) > 128 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing vapid key hash"})
		return
	}
	pushKind := r.URL.Query().Get("type")
	if pushKind == "" {
		pushKind = "alert"
	}
	if pushKind != "alert" && pushKind != "liveactivity" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid push type"})
		return
	}

	now := s.apns.now()
	if code, msg := verifyVapidHTTP(r, expectedHash, now); code != 0 {
		writeJSON(w, code, map[string]string{"error": msg})
		return
	}

	limit := int64(apnsMaxCiphertextBytes)
	if pushKind == "liveactivity" {
		limit = apnsMaxLiveActBytes
	}
	rawBody, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read body failed"})
		return
	}
	if len(rawBody) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty payload"})
		return
	}
	if int64(len(rawBody)) > limit {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "payload too large"})
		return
	}

	var apnsPayload []byte
	apnsTopic := s.apns.topic
	apnsPushType := "alert"

	if pushKind == "liveactivity" {
		var check map[string]any
		if err := json.Unmarshal(rawBody, &check); err != nil || check["aps"] == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid liveactivity payload"})
			return
		}
		apnsPayload = rawBody
		apnsPushType = "liveactivity"
		apnsTopic = s.apns.topic + ".push-type.liveactivity"
	} else {
		if !strings.Contains(strings.ToLower(r.Header.Get("Content-Encoding")), "aes128gcm") {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "content-encoding must be aes128gcm"})
			return
		}
		apnsPayload, _ = json.Marshal(map[string]any{
			"aps": map[string]any{
				"mutable-content": 1,
				"alert": map[string]string{
					"title": "EnsoCode",
					"body":  "收到一条新通知",
				},
				"sound": "default",
			},
			"enso": map[string]string{
				"c": base64.StdEncoding.EncodeToString(rawBody),
			},
		})
	}

	jwtToken, err := s.apns.providerJWT()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "apns signing failed"})
		return
	}

	baseURL := s.apns.prodBaseURL
	if envName == "sandbox" {
		baseURL = s.apns.sandBaseURL
	}
	ttl := int64(3600)
	if v := strings.TrimSpace(r.Header.Get("TTL")); v != "" {
		if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed >= 0 {
			if parsed > 7*86400 {
				parsed = 7 * 86400
			}
			ttl = parsed
		}
	}
	expiration := int64(0)
	if ttl > 0 {
		expiration = now.Unix() + ttl
	}

	req, err := http.NewRequestWithContext(
		r.Context(),
		http.MethodPost,
		baseURL+"/3/device/"+strings.ToLower(deviceToken),
		bytes.NewReader(apnsPayload),
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "build apns request failed"})
		return
	}
	req.Header.Set("authorization", "bearer "+jwtToken)
	req.Header.Set("apns-topic", apnsTopic)
	req.Header.Set("apns-push-type", apnsPushType)
	req.Header.Set("apns-priority", "10")
	req.Header.Set("apns-expiration", strconv.FormatInt(expiration, 10))
	req.Header.Set("content-type", "application/json")

	resp, err := s.apns.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "apns upstream unreachable"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		writeCORS(w)
		w.WriteHeader(http.StatusCreated)
		return
	}
	var errBody struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&errBody)
	if resp.StatusCode == http.StatusGone ||
		errBody.Reason == "BadDeviceToken" ||
		errBody.Reason == "Unregistered" ||
		errBody.Reason == "DeviceTokenNotForTopic" {
		writeJSON(w, http.StatusGone, map[string]string{"error": errBody.Reason})
		return
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": errBody.Reason})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": errBody.Reason})
}
