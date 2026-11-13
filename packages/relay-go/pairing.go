package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
)

const (
	pairTTLMS           int64 = 60_000
	credentialWindowMS  int64 = 120_000
	maxFrameBytes             = 1_048_576
	pairPhaseRequested        = "requested"
	pairPhaseAuthorized       = "authorized"
	roleHost                  = "host"
	roleGuest                 = "guest"
)

type PairState struct {
	Phase         string `json:"phase"`
	HostPublicKey string `json:"hostPublicKey"`
	CreatedAt     int64  `json:"createdAt"`
	BoxedKey      string `json:"boxedKey,omitempty"`
	DeviceName    string `json:"deviceName,omitempty"`
	HostToken     string `json:"hostToken,omitempty"`
	DeviceToken   string `json:"deviceToken,omitempty"`
	AuthorizedAt  int64  `json:"authorizedAt,omitempty"`
}

func toBase64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func randomToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return toBase64URL(b[:])
}

// validPublicKey：客户端（@enso/pair startHostPairing）上报的是 32 字节 NaCl box 公钥的
// base64url（无填充），恒为 43 字符。request 不鉴权且会落库，只收这一种格式，
// 挡住任意内容写进存储。
func validPublicKey(publicKey string) bool {
	if len(publicKey) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(publicKey)
	return err == nil && len(b) == 32
}

func pairIDFromPublicKey(publicKey string) string {
	sum := sha256.Sum256([]byte(publicKey))
	return toBase64URL(sum[:16])
}

func isExpired(state PairState, now int64) bool {
	return state.Phase == pairPhaseRequested && now-state.CreatedAt > pairTTLMS
}

func request(prev *PairState, now int64, hostPublicKey string) (PairState, bool) {
	if prev == nil || isExpired(*prev, now) {
		return PairState{
			Phase:         pairPhaseRequested,
			HostPublicKey: hostPublicKey,
			CreatedAt:     now,
		}, true
	}
	return *prev, false
}

type claimResult struct {
	ok    bool
	next  PairState
	error string
}

func claim(prev *PairState, now int64, boxedKey, deviceName string) claimResult {
	if prev == nil {
		return claimResult{error: "no pending pair"}
	}
	if isExpired(*prev, now) {
		return claimResult{error: "pair code expired"}
	}
	if prev.Phase == pairPhaseAuthorized {
		return claimResult{error: "already claimed"}
	}
	next := *prev
	next.Phase = pairPhaseAuthorized
	next.AuthorizedAt = now
	next.BoxedKey = boxedKey
	next.DeviceName = deviceName
	next.HostToken = randomToken()
	next.DeviceToken = randomToken()
	return claimResult{ok: true, next: next}
}

func canFetchCredentials(state PairState, now int64) bool {
	if state.Phase != pairPhaseAuthorized {
		return false
	}
	start := state.AuthorizedAt
	if start == 0 {
		start = state.CreatedAt
	}
	return now-start <= credentialWindowMS
}

func tokenValid(state *PairState, role, token string) bool {
	if state == nil || state.Phase != pairPhaseAuthorized || token == "" {
		return false
	}
	want := state.DeviceToken
	if role == roleHost {
		want = state.HostToken
	}
	if want == "" || len(want) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(token)) == 1
}

func normalizeDeviceName(name string) string {
	runes := []rune(name)
	if len(runes) > 64 {
		name = string(runes[:64])
	}
	if name == "" {
		return "phone"
	}
	return name
}
