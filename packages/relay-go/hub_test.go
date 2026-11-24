package main

import (
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
