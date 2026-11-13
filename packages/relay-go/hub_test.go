package main

import (
	"sync"
	"testing"
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
