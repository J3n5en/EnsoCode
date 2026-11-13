package main

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

type Server struct {
	store  *Store
	hub    *hub
	static fs.FS
	desk   func() *deskBundle
	now    func() int64
	log    *slog.Logger
}

func newServer(store *Store, static fs.FS, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		store:  store,
		hub:    newHub(),
		static: static,
		desk:   sync.OnceValue(func() *deskBundle { return loadDeskBundle(static) }),
		now:    func() int64 { return time.Now().UnixMilli() },
		log:    log,
	}
}

func writeCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	h.Set("Access-Control-Allow-Headers", "content-type")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	writeCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeText(w http.ResponseWriter, status int, body string) {
	writeCORS(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		writeCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	p := r.URL.Path
	switch {
	case p == "/v1/pair/request" && r.Method == http.MethodPost:
		s.handleRequest(w, r)
	case p == "/v1/pair/claim" && r.Method == http.MethodPost:
		s.handleClaim(w, r)
	case p == "/healthz" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case strings.HasPrefix(p, "/"+deskBundleDir+"/") && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		s.desk().serve(w, r, strings.TrimPrefix(p, "/"+deskBundleDir+"/"))
	default:
		if pairID, ok := pairIDFromPath(p); ok {
			if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
				s.handleConnect(w, r, pairID)
				return
			}
			if r.Method == http.MethodDelete {
				s.handleDelete(w, r, pairID)
				return
			}
		}
		if strings.HasPrefix(p, "/v1/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		s.serveStatic(w, r)
	}
}

func pairIDFromPath(p string) (string, bool) {
	const prefix = "/v1/pair/"
	if !strings.HasPrefix(p, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(p, prefix)
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	if unesc, err := pathUnescape(id); err == nil {
		return unesc, true
	}
	return id, true
}

func pathUnescape(s string) (string, error) {
	return urlPathUnescape(s)
}

func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PublicKey string `json:"publicKey"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.PublicKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing publicKey"})
		return
	}
	if !validPublicKey(body.PublicKey) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid publicKey"})
		return
	}
	pairID := pairIDFromPublicKey(body.PublicKey)
	now := s.now()
	// 顺带清理过期配对码；清理失败只记日志，不耽误本次配对
	if err := s.store.pruneExpired(now); err != nil {
		s.log.Warn("prune expired pairs", "err", err)
	}
	next, err := s.store.requestPair(pairID, body.PublicKey, now)
	if err != nil {
		s.log.Error("store request", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store"})
		return
	}
	if next.Phase == pairPhaseAuthorized {
		if !canFetchCredentials(next, now) {
			writeJSON(w, http.StatusOK, map[string]any{"pairId": pairID, "state": pairPhaseAuthorized})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"pairId":     pairID,
			"state":      pairPhaseAuthorized,
			"hostToken":  next.HostToken,
			"response":   next.BoxedKey,
			"deviceName": next.DeviceName,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairId": pairID, "state": pairPhaseRequested})
}

func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PublicKey  string `json:"publicKey"`
		BoxedKey   string `json:"boxedKey"`
		DeviceName string `json:"deviceName"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.PublicKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing publicKey"})
		return
	}
	if body.BoxedKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing boxedKey"})
		return
	}
	pairID := pairIDFromPublicKey(body.PublicKey)
	next, claimErr, err := s.store.claimPair(pairID, body.BoxedKey, normalizeDeviceName(body.DeviceName), s.now())
	if err != nil {
		s.log.Error("store claim", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store"})
		return
	}
	if claimErr != "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": claimErr})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pairId":      pairID,
		"state":       pairPhaseAuthorized,
		"deviceToken": next.DeviceToken,
	})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request, pairID string) {
	token := r.URL.Query().Get("token")
	ok, err := s.store.revokePair(pairID, token)
	if err != nil {
		s.log.Error("store revoke", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	s.hub.revoke(pairID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request, pairID string) {
	role := r.URL.Query().Get("role")
	token := r.URL.Query().Get("token")
	if role != roleHost && role != roleGuest {
		writeText(w, http.StatusBadRequest, "bad role")
		return
	}
	st, err := s.store.get(pairID)
	if err != nil {
		s.log.Error("store get", "err", err)
		writeText(w, http.StatusInternalServerError, "store")
		return
	}
	if !tokenValid(st, role, token) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "revoked"))
		_ = conn.Close()
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrameBytes)
	p := newPeer(role, conn)
	go p.writePump(conn)
	s.hub.join(pairID, role, p)
	s.readPump(conn, pairID, role, p)
}

func (s *Server) readPump(conn *websocket.Conn, pairID, role string, p *peer) {
	defer func() {
		s.hub.leave(pairID, role, p.id)
		p.close(websocket.CloseGoingAway, "")
		_ = conn.Close()
	}()
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage && string(data) == "ping" {
			p.trySend(frame{messageType: websocket.TextMessage, data: []byte("pong")})
			continue
		}
		if len(data) > maxFrameBytes {
			continue
		}
		s.hub.forward(pairID, role, mt, data)
	}
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeText(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeCORS(w)
	rel := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if rel == "" || rel == "." {
		rel = "index.html"
	}
	b, err := fs.ReadFile(s.static, rel)
	if err != nil && path.Ext(rel) == "" {
		// Cloudflare 等前置会把 /desk.html 规范成 /desk
		if hb, herr := fs.ReadFile(s.static, rel+".html"); herr == nil {
			b, err, rel = hb, nil, rel+".html"
		}
	}
	if err != nil {
		b, err = fs.ReadFile(s.static, "index.html")
		rel = "index.html"
		if err != nil {
			http.NotFound(w, r)
			return
		}
	}
	if path.Ext(rel) == ".html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	ctype := mime.TypeByExtension(path.Ext(rel))
	if ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	http.ServeContent(w, r, rel, time.Time{}, bytes.NewReader(b))
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	return dec.Decode(dst)
}
