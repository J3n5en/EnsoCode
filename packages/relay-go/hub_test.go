package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// 真实场景（窄窗口）：手机断开（leave 把房间判空并删除）的同时桌面重连（join 已取到这间房、还没入座）。
// 新 peer 若落进已从 hub 删掉的孤儿房间，手机再进房会分到另一间新房：两端转发一边通一边不通，直到重连。
func TestHubJoinRacingLeaveNoOrphanRoom(t *testing.T) {
	const pairID = "p"
	for i := 0; i < 5000; i++ {
		h := newHub()
		guest := newPeer(roleGuest, nil)
		h.join(pairID, roleGuest, guest)
		host := newPeer(roleHost, nil)
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			h.join(pairID, roleHost, host)
		}()
		go func() {
			defer wg.Done()
			<-start
			h.leave(pairID, roleGuest, guest.id)
		}()
		close(start)
		wg.Wait()

		h.mu.Lock()
		r := h.rooms[pairID]
		h.mu.Unlock()
		if r == nil {
			t.Fatalf("第 %d 轮：host 已入座，但 hub 里没有这间房（落进了孤儿房间）", i)
		}
		r.mu.Lock()
		seated := r.host == host
		r.mu.Unlock()
		if !seated {
			t.Fatalf("第 %d 轮：hub 里的房间没有刚入座的 host", i)
		}
	}
}

// 回前台续上时宿主按 seq 一次补发上千条小帧，手机链路慢时还没写出：只要字节没超限就不能按慢端拆链。
func TestReplayBurstOfSmallFramesNotAborted(t *testing.T) {
	p := newPeer(roleGuest, nil)
	for i := 0; i < 4000; i++ {
		p.trySend(frame{messageType: websocket.BinaryMessage, data: make([]byte, 300)})
	}
	if p.dead.Load() {
		t.Fatal("4000 条小帧（约 1.2MB）在途就被当成慢端拆链")
	}
}

// abort 关掉连接后，writePump 不能干等下一轮 ping 才退出。
func TestAbortStopsWritePump(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	result := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		p := newPeer(roleGuest, conn)
		go p.writePump(conn)
		time.Sleep(20 * time.Millisecond)
		p.abort()
		select {
		case <-p.done:
			result <- nil
		case <-time.After(time.Second):
			result <- errors.New("abort 后 p.done 没有在 1s 内关闭")
		}
	}))
	defer srv.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("超时")
	}
}

func drainFrames(p *peer) []frame {
	var out []frame
	for {
		select {
		case fr := <-p.send:
			out = append(out, fr)
		default:
			return out
		}
	}
}

func decodeControl(t *testing.T, fr frame) map[string]any {
	t.Helper()
	if fr.messageType != websocket.TextMessage {
		t.Fatalf("expected text frame, got mt=%d", fr.messageType)
	}
	var out map[string]any
	if err := json.Unmarshal(fr.data, &out); err != nil {
		t.Fatalf("unmarshal control: %v", err)
	}
	return out
}

func TestHubHotBufReplayAndInvalidation(t *testing.T) {
	const pairID = "hot"
	now := time.Unix(1000, 0)
	h := newHub()
	h.now = func() time.Time { return now }

	host := newPeer(roleHost, nil)
	h.join(pairID, roleHost, host)
	guest1 := newPeer(roleGuest, nil)
	h.join(pairID, roleGuest, guest1)

	ctrl1 := decodeControl(t, drainFrames(guest1)[0])
	epoch, _ := ctrl1["relayEpoch"].(string)
	if epoch == "" || ctrl1["relaySeq"] != float64(0) {
		t.Fatalf("unexpected initial host-online: %#v", ctrl1)
	}
	_ = drainFrames(host) // peer-joined

	// Host sends 2 binary frames while guest1 is connected; both are forwarded AND buffered.
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("f1"))
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("f2"))
	g1Frames := drainFrames(guest1)
	if len(g1Frames) != 2 || string(g1Frames[0].data) != "f1" || string(g1Frames[1].data) != "f2" {
		t.Fatalf("unexpected live forward: %#v", g1Frames)
	}

	// Simulate guest1 half-open (OS eats frame 3 & 4 before leave); guest1 had received seq 2.
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("f3"))
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("f4"))
	h.leave(pairID, roleGuest, guest1.id)

	// guest2 reconnects with relayEpoch + sinceRelaySeq=2 -> receives host-online + f3 + f4 immediately.
	guest2 := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guest2, epoch, 2, true)
	g2Frames := drainFrames(guest2)
	if len(g2Frames) != 3 {
		t.Fatalf("expected 3 frames (host-online + 2 replay), got %d", len(g2Frames))
	}
	ctrl2 := decodeControl(t, g2Frames[0])
	if ctrl2["type"] != "host-online" || ctrl2["relayEpoch"] != epoch || ctrl2["relaySeq"] != float64(4) || ctrl2["replayedFrom"] != float64(2) {
		t.Fatalf("unexpected replay host-online: %#v", ctrl2)
	}
	if string(g2Frames[1].data) != "f3" || string(g2Frames[2].data) != "f4" {
		t.Fatalf("unexpected replayed frames: %q %q", g2Frames[1].data, g2Frames[2].data)
	}

	// Half-open replacement without leave(): guest3 replaces guest2 at sinceRelaySeq=3.
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("f5"))
	guest3 := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guest3, epoch, 3, true)
	g3Frames := drainFrames(guest3)
	if len(g3Frames) != 3 || string(g3Frames[1].data) != "f4" || string(g3Frames[2].data) != "f5" {
		t.Fatalf("expected half-open replacement replay [f4 f5], got %d frames", len(g3Frames))
	}
	ctrl3 := decodeControl(t, g3Frames[0])
	if ctrl3["replayedFrom"] != float64(3) || ctrl3["relaySeq"] != float64(5) {
		t.Fatalf("unexpected half-open ctrl: %#v", ctrl3)
	}

	// Wrong epoch -> no replay, replayedFrom omitted.
	guestWrongEpoch := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guestWrongEpoch, "other-epoch", 2, true)
	wrongFrames := drainFrames(guestWrongEpoch)
	if len(wrongFrames) != 1 {
		t.Fatalf("wrong epoch should not replay, got %d", len(wrongFrames))
	}
	ctrlWrong := decodeControl(t, wrongFrames[0])
	if _, has := ctrlWrong["replayedFrom"]; has || ctrlWrong["relaySeq"] != float64(5) {
		t.Fatalf("unexpected wrong epoch ctrl: %#v", ctrlWrong)
	}

	// TTL expiry (> 90s) -> expired frames pruned, no partial gap replay.
	now = now.Add(hotBufTTL + time.Second)
	guestExpired := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guestExpired, epoch, 4, true)
	if expFrames := drainFrames(guestExpired); len(expFrames) != 1 {
		t.Fatalf("expired hotbuf should not replay, got %d frames", len(expFrames))
	}

	// Fresh host reconnect rotates epoch and resets hostSeq to 0 + clears hotBuf.
	host2 := newPeer(roleHost, nil)
	h.join(pairID, roleHost, host2)
	ctrlHost2 := decodeControl(t, drainFrames(guestExpired)[0])
	epoch2, _ := ctrlHost2["relayEpoch"].(string)
	if epoch2 == "" || epoch2 == epoch || ctrlHost2["relaySeq"] != float64(0) {
		t.Fatalf("host reconnect should rotate epoch and reset seq: %#v", ctrlHost2)
	}

	// Eviction by hotBufMaxBytes / hotBufMaxFrames preserves contiguity: gap disables replay.
	for i := 0; i < hotBufMaxFrames+5; i++ {
		h.forward(pairID, roleHost, websocket.BinaryMessage, []byte{byte(i)})
	}
	guestGap := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guestGap, epoch2, 1, true)
	if gapFrames := drainFrames(guestGap); len(gapFrames) != 1 {
		t.Fatalf("evicted prefix should prevent gapped replay, got %d", len(gapFrames))
	}
}

func TestHubHotBufClearedOnRevoke(t *testing.T) {
	const pairID = "rev"
	h := newHub()
	host := newPeer(roleHost, nil)
	h.join(pairID, roleHost, host)
	h.forward(pairID, roleHost, websocket.BinaryMessage, []byte("secret-cipher"))
	h.revoke(pairID)
	guest := newPeer(roleGuest, nil)
	h.joinWithResume(pairID, roleGuest, guest, "anything", 0, true)
	frames := drainFrames(guest)
	if len(frames) != 1 || decodeControl(t, frames[0])["type"] != "host-offline" {
		t.Fatalf("revoked room must not retain hotbuf: %#v", frames)
	}
}
