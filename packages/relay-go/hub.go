package main

import (
	"encoding/json"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type frame struct {
	messageType int
	data        []byte
	closeCode   int
	closeText   string
}

// 单个连接发送队列的上限，帧数或字节任一超出即视为慢端。字节按 16 个满载帧
// （16MB）封顶，限住单连接的最坏内存；帧数给足余量，免得一阵小帧（流式输出、
// 重连后的目录 / 快照、完整版回前台按 seq 补发的上千条保留帧）就把只是稍慢的手机
// 拆掉、陷入反复重连。
const (
	peerQueueFrames = 4096
	peerQueueBytes  = 16 * maxFrameBytes

	hotBufMaxBytes  = 1024 * 1024
	hotBufMaxFrames = 512
	hotBufTTL       = 90 * time.Second
)

type hotFrame struct {
	seq  uint64
	data []byte
	at   time.Time
}

type peer struct {
	id        uint64
	role      string
	closer    io.Closer
	send      chan frame
	done      chan struct{}
	kill      chan struct{} // abort 关掉它，writePump 不必干等下一轮 ping
	closeOnce sync.Once
	queued    atomic.Int64 // 已入队、尚未写出的字节
	dead      atomic.Bool  // 已按慢端拆链：不再入队，也不再写
}

func newPeer(role string, conn *websocket.Conn) *peer {
	return newPeerWithCloser(role, conn)
}

func newPeerWithCloser(role string, closer io.Closer) *peer {
	return &peer{
		id:     peerSeq.Add(1),
		role:   role,
		closer: closer,
		send:   make(chan frame, peerQueueFrames),
		done:   make(chan struct{}),
		kill:   make(chan struct{}),
	}
}

var peerSeq atomic.Uint64

// trySend 绝不阻塞调用方：调用方多是对端的读循环，它一卡住，同循环里的
// ping→pong 也停了，对端心跳会误判死链（CF 版 send 同样不阻塞）。
// 队列满时拆掉本连接，而不是静默丢这一帧：中继不知道帧里是什么，丢一帧可能
// 让快照残缺而两端都察觉不到；拆链后客户端重连，靠 peer-joined / session-sync
// 重新同步，送达的始终是不带缺口的前缀。
func (p *peer) trySend(fr frame) {
	if p.dead.Load() {
		return
	}
	n := int64(len(fr.data))
	if p.queued.Add(n) > peerQueueBytes {
		p.queued.Add(-n)
		p.abort()
		return
	}
	select {
	case p.send <- fr:
	case <-p.done:
		p.queued.Add(-n)
	default:
		p.queued.Add(-n)
		p.abort()
	}
}

// abort 按慢端拆链。关连接放进 goroutine：TLS 连接没有在途写时 Close 会同步发
// close_notify，发送缓冲已满时可能卡住调用方。关掉后在途的阻塞写立即返回，
// writePump 退出；readPump 随之读失败，照常走 leave 通知对端。
func (p *peer) abort() {
	if p.dead.CompareAndSwap(false, true) {
		close(p.kill)
		if p.closer != nil {
			go func() { _ = p.closer.Close() }()
		}
	}
}

func (p *peer) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	p.trySend(frame{messageType: websocket.TextMessage, data: b})
}

func (p *peer) close(code int, reason string) {
	p.closeOnce.Do(func() {
		p.trySend(frame{closeCode: code, closeText: reason})
	})
}

func (p *peer) writePump(conn *websocket.Conn) {
	ticker := time.NewTicker(60 * time.Second)
	defer func() {
		ticker.Stop()
		close(p.done)
		_ = conn.Close()
	}()
	for {
		select {
		case fr, ok := <-p.send:
			if !ok {
				return
			}
			p.queued.Add(-int64(len(fr.data)))
			if p.dead.Load() {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if fr.closeCode != 0 {
				_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(fr.closeCode, fr.closeText))
				return
			}
			if err := conn.WriteMessage(fr.messageType, fr.data); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-p.kill:
			return
		}
	}
}

type room struct {
	mu       sync.Mutex
	host     *peer
	guest    *peer
	epoch    string
	hostSeq  uint64
	hotBuf   []hotFrame
	hotBytes int
}

type hub struct {
	mu       sync.Mutex
	rooms    map[string]*room
	now      func() time.Time
	epochSeq atomic.Uint64
}

func newHub() *hub {
	return &hub{
		rooms: make(map[string]*room),
		now:   time.Now,
	}
}

func (h *hub) currentTime() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

func (h *hub) nextEpoch() string {
	return randomToken()[:16] + "-" + strconv.FormatUint(h.epochSeq.Add(1), 36)
}

func clearHotBufLocked(r *room) {
	r.hotBuf = nil
	r.hotBytes = 0
}

func pruneHotBufLocked(r *room, now time.Time) {
	drop := 0
	for drop < len(r.hotBuf) && now.Sub(r.hotBuf[drop].at) > hotBufTTL {
		r.hotBytes -= len(r.hotBuf[drop].data)
		drop++
	}
	if drop > 0 {
		if drop == len(r.hotBuf) {
			clearHotBufLocked(r)
			return
		}
		r.hotBuf = append([]hotFrame(nil), r.hotBuf[drop:]...)
	}
}

func appendHotBufLocked(r *room, data []byte, now time.Time) {
	r.hostSeq++
	pruneHotBufLocked(r, now)
	if len(data) > hotBufMaxBytes {
		clearHotBufLocked(r)
		return
	}
	cp := append([]byte(nil), data...)
	r.hotBuf = append(r.hotBuf, hotFrame{seq: r.hostSeq, data: cp, at: now})
	r.hotBytes += len(cp)
	drop := 0
	for len(r.hotBuf)-drop > hotBufMaxFrames || r.hotBytes > hotBufMaxBytes {
		r.hotBytes -= len(r.hotBuf[drop].data)
		drop++
	}
	if drop > 0 {
		r.hotBuf = append([]hotFrame(nil), r.hotBuf[drop:]...)
	}
}

// roomLocked 取或建房间，调用方须持有 h.mu。
func (h *hub) roomLocked(pairID string) *room {
	r := h.rooms[pairID]
	if r == nil {
		r = &room{}
		h.rooms[pairID] = r
	}
	return r
}

func (h *hub) join(pairID, role string, p *peer) {
	h.joinWithResume(pairID, role, p, "", 0, false)
}

func (h *hub) joinWithResume(pairID, role string, p *peer, sinceEpoch string, sinceSeq uint64, hasSince bool) {
	// 取房间与入座在 h.mu 下一次完成（锁序 h.mu → r.mu，与 leave 一致）：分两步时，
	// leave 可能在中间把这间当时为空的房间从 map 删掉，新 peer 就落进孤儿房间，
	// 对端再进房分到另一间新房，两端转发一边通一边不通，直到重连。
	h.mu.Lock()
	r := h.roomLocked(pairID)
	r.mu.Lock()
	var stale *peer
	var other *peer
	if role == roleHost {
		stale = r.host
		r.host = p
		r.epoch = h.nextEpoch()
		r.hostSeq = 0
		clearHotBufLocked(r)
		other = r.guest
		if other != nil {
			other.sendJSON(map[string]any{
				"type":       "host-online",
				"relayEpoch": r.epoch,
				"relaySeq":   uint64(0),
			})
		}
	} else {
		stale = r.guest
		r.guest = p
		other = r.host
		if other != nil {
			pruneHotBufLocked(r, h.currentTime())
			hostOnline := map[string]any{
				"type":       "host-online",
				"relayEpoch": r.epoch,
				"relaySeq":   r.hostSeq,
			}
			var replay []hotFrame
			if hasSince && sinceEpoch != "" && sinceEpoch == r.epoch && sinceSeq < r.hostSeq &&
				len(r.hotBuf) > 0 && r.hotBuf[0].seq <= sinceSeq+1 {
				for _, entry := range r.hotBuf {
					if entry.seq > sinceSeq {
						replay = append(replay, entry)
					}
				}
				if len(replay) > 0 {
					hostOnline["replayedFrom"] = sinceSeq
				}
			}
			// Hold r.mu across host-online + replay enqueue so concurrent forward() frames stay strictly ordered after replay.
			p.sendJSON(hostOnline)
			for _, entry := range replay {
				p.trySend(frame{messageType: websocket.BinaryMessage, data: entry.data})
			}
		}
	}
	r.mu.Unlock()
	h.mu.Unlock()

	if stale != nil {
		stale.close(websocket.CloseNormalClosure, "replaced")
	}
	if role == roleHost {
		if other != nil {
			p.sendJSON(map[string]string{"type": "peer-joined"})
		}
	} else {
		if other != nil {
			other.sendJSON(map[string]string{"type": "peer-joined"})
		} else {
			p.sendJSON(map[string]string{"type": "host-offline"})
		}
	}
}

func (h *hub) leave(pairID, role string, id uint64) {
	// 判空与删除全程持有 h.mu，与 join 的「取房间 + 入座」互斥，见 join。
	h.mu.Lock()
	r := h.rooms[pairID]
	if r == nil {
		h.mu.Unlock()
		return
	}
	r.mu.Lock()
	var cur **peer
	var other *peer
	offline := map[string]string{"type": "peer-left"}
	if role == roleHost {
		cur = &r.host
		other = r.guest
		offline = map[string]string{"type": "host-offline"}
	} else {
		cur = &r.guest
		other = r.host
	}
	if *cur == nil || (*cur).id != id {
		r.mu.Unlock()
		h.mu.Unlock()
		return
	}
	*cur = nil
	if role == roleHost {
		r.epoch = ""
		r.hostSeq = 0
		clearHotBufLocked(r)
	}
	if r.host == nil && r.guest == nil {
		delete(h.rooms, pairID)
	}
	r.mu.Unlock()
	h.mu.Unlock()
	if other != nil {
		other.sendJSON(offline)
	}
}

func (h *hub) forward(pairID, fromRole string, messageType int, data []byte) {
	h.mu.Lock()
	r := h.rooms[pairID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	var dst *peer
	if fromRole == roleHost {
		if messageType == websocket.BinaryMessage {
			appendHotBufLocked(r, data, h.currentTime())
		}
		dst = r.guest
		if dst != nil {
			dst.trySend(frame{messageType: messageType, data: data})
		}
		r.mu.Unlock()
		return
	}
	dst = r.host
	r.mu.Unlock()
	if dst != nil {
		dst.trySend(frame{messageType: messageType, data: data})
	}
}

func (h *hub) revoke(pairID string) {
	h.mu.Lock()
	r := h.rooms[pairID]
	delete(h.rooms, pairID)
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	host, guest := r.host, r.guest
	r.host, r.guest = nil, nil
	r.epoch = ""
	r.hostSeq = 0
	clearHotBufLocked(r)
	r.mu.Unlock()
	msg := map[string]string{"type": "revoked"}
	for _, p := range []*peer{host, guest} {
		if p == nil {
			continue
		}
		p.sendJSON(msg)
		p.close(websocket.ClosePolicyViolation, "revoked")
	}
}
