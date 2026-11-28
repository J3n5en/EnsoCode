package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go"
)

const (
	quicALPN = "enso-pair/1"

	quicStreamControl byte = 0x00
	quicStreamCtrl    byte = 0x01
	quicStreamBulk    byte = 0x02

	// Matches packages/pair/src/direct/link.ts BULK_THRESHOLD_BYTES
	quicBulkThreshold = 16 * 1024

	quicHandshakeTimeout = 10 * time.Second
	quicWriteTimeout     = 10 * time.Second
)

type quicHello struct {
	PairID        string  `json:"pairId"`
	Role          string  `json:"role"`
	Token         string  `json:"token"`
	RelayEpoch    string  `json:"relayEpoch,omitempty"`
	SinceRelaySeq *uint64 `json:"sinceRelaySeq,omitempty"`
}

type quicServer struct {
	srv      *Server
	listener *quic.EarlyListener
	udpConn  *net.UDPConn
	ctx      context.Context
	cancel   context.CancelFunc
}

func startQuicServer(srv *Server, addr string, tlsConf *tls.Config) (*quicServer, error) {
	if tlsConf == nil {
		return nil, errors.New("tls config required for quic")
	}
	clonedTLS := tlsConf.Clone()
	hasALPN := false
	for _, proto := range clonedTLS.NextProtos {
		if proto == quicALPN {
			hasALPN = true
			break
		}
	}
	if !hasALPN {
		clonedTLS.NextProtos = append([]string{quicALPN}, clonedTLS.NextProtos...)
	}
	if clonedTLS.MinVersion < tls.VersionTLS13 {
		clonedTLS.MinVersion = tls.VersionTLS13
	}

	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, err
	}
	udpConn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, err
	}
	qConf := &quic.Config{
		Allow0RTT:       true,
		MaxIdleTimeout:  60 * time.Second,
		KeepAlivePeriod: 20 * time.Second,
	}
	listener, err := quic.ListenEarly(udpConn, clonedTLS, qConf)
	if err != nil {
		_ = udpConn.Close()
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	qs := &quicServer{
		srv:      srv,
		listener: listener,
		udpConn:  udpConn,
		ctx:      ctx,
		cancel:   cancel,
	}
	if ua, ok := udpConn.LocalAddr().(*net.UDPAddr); ok && ua.Port > 0 {
		srv.quicPort.Store(int32(ua.Port))
	}
	go qs.acceptLoop()
	return qs, nil
}

func (q *quicServer) Addr() net.Addr {
	return q.udpConn.LocalAddr()
}

func (q *quicServer) Close() error {
	q.srv.quicPort.Store(0)
	q.cancel()
	err1 := q.listener.Close()
	err2 := q.udpConn.Close()
	if err1 != nil {
		return err1
	}
	return err2
}

func (q *quicServer) acceptLoop() {
	for {
		conn, err := q.listener.Accept(q.ctx)
		if err != nil {
			return
		}
		go q.handleConn(conn)
	}
}

type quicConnCloser struct {
	conn *quic.Conn
}

func (c quicConnCloser) Close() error {
	return c.conn.CloseWithError(0, "closed")
}

func writeQuicFrame(w io.Writer, data []byte) error {
	if len(data) > maxFrameBytes {
		return fmt.Errorf("frame too large: %d", len(data))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(data)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	_, err := w.Write(data)
	return err
}

func readQuicFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint32(hdr[:]))
	if n > maxFrameBytes {
		return nil, fmt.Errorf("frame exceeds maxFrameBytes: %d", n)
	}
	if n == 0 {
		return nil, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func (q *quicServer) handleConn(conn *quic.Conn) {
	defer func() { _ = conn.CloseWithError(0, "bye") }()

	var (
		mu        sync.Mutex
		ctlStream *quic.Stream
		ctrlLane  *quic.Stream
		bulkLane  *quic.Stream
		helloCh   = make(chan struct{})
		helloOnce sync.Once
		hello     quicHello
		helloErr  error
	)

	peerReady := make(chan struct{})
	var (
		peerPairID string
		peerRole   string
		joinedPeer *peer
	)

	// Accept streams concurrently: client opens ctrl(0x01), bulk(0x02), and control(0x00) in any order.
	acceptCtx, cancelAccept := context.WithCancel(q.ctx)
	defer cancelAccept()

	go func() {
		for {
			st, err := conn.AcceptStream(acceptCtx)
			if err != nil {
				helloOnce.Do(func() {
					helloErr = err
					close(helloCh)
				})
				return
			}
			go func(stream *quic.Stream) {
				_ = stream.SetReadDeadline(time.Now().Add(quicHandshakeTimeout))
				var kind [1]byte
				if _, err := io.ReadFull(stream, kind[:]); err != nil {
					_ = stream.Close()
					return
				}
				_ = stream.SetReadDeadline(time.Time{})

				switch kind[0] {
				case quicStreamControl:
					_ = stream.SetReadDeadline(time.Now().Add(quicHandshakeTimeout))
					raw, err := readQuicFrame(stream)
					_ = stream.SetReadDeadline(time.Time{})
					if err != nil {
						helloOnce.Do(func() {
							helloErr = err
							close(helloCh)
						})
						return
					}
					var h quicHello
					if err := json.Unmarshal(raw, &h); err != nil {
						helloOnce.Do(func() {
							helloErr = err
							close(helloCh)
						})
						return
					}
					mu.Lock()
					ctlStream = stream
					hello = h
					mu.Unlock()
					helloOnce.Do(func() { close(helloCh) })

					<-peerReady
					if joinedPeer == nil {
						return
					}
					q.readControlStream(stream, joinedPeer)
				case quicStreamCtrl:
					mu.Lock()
					ctrlLane = stream
					mu.Unlock()
					<-peerReady
					if joinedPeer == nil {
						return
					}
					q.readDataStream(stream, peerPairID, peerRole, joinedPeer)
				case quicStreamBulk:
					mu.Lock()
					bulkLane = stream
					mu.Unlock()
					<-peerReady
					if joinedPeer == nil {
						return
					}
					q.readDataStream(stream, peerPairID, peerRole, joinedPeer)
				default:
					_ = stream.Close()
				}
			}(st)
		}
	}()

	select {
	case <-helloCh:
	case <-time.After(quicHandshakeTimeout):
		return
	case <-q.ctx.Done():
		return
	}
	if helloErr != nil || ctlStream == nil {
		close(peerReady)
		return
	}

	if hello.Role != roleHost && hello.Role != roleGuest {
		_ = writeQuicFrame(ctlStream, []byte(`{"type":"error","error":"bad role"}`))
		close(peerReady)
		return
	}
	st, err := q.srv.store.get(hello.PairID)
	if err != nil || !tokenValid(st, hello.Role, hello.Token) {
		_ = writeQuicFrame(ctlStream, []byte(`{"type":"revoked"}`))
		_ = ctlStream.Close()
		close(peerReady)
		time.Sleep(50 * time.Millisecond)
		return
	}

	// Brief wait if ctrl stream hasn't arrived yet (typically already open before control hello).
	waitDeadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(waitDeadline) {
		mu.Lock()
		hasCtrl := ctrlLane != nil
		mu.Unlock()
		if hasCtrl {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	p := newPeerWithCloser(hello.Role, quicConnCloser{conn: conn})
	peerPairID = hello.PairID
	peerRole = hello.Role
	joinedPeer = p
	close(peerReady)

	// Per-stream mutexes so ctrl/bulk writes never block each other.
	var (
		ctlWriteMu  sync.Mutex
		ctrlWriteMu sync.Mutex
		bulkWriteMu sync.Mutex
	)
	writeToStream := func(s *quic.Stream, wmu *sync.Mutex, data []byte) error {
		if s == nil {
			return io.ErrClosedPipe
		}
		wmu.Lock()
		defer wmu.Unlock()
		_ = s.SetWriteDeadline(time.Now().Add(quicWriteTimeout))
		return writeQuicFrame(s, data)
	}

	pumpDone := make(chan struct{})
	go func() {
		defer func() {
			close(p.done)
			close(pumpDone)
			_ = conn.CloseWithError(0, "pump-done")
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
				if fr.closeCode != 0 {
					msg, _ := json.Marshal(map[string]any{
						"type":   "close",
						"code":   fr.closeCode,
						"reason": fr.closeText,
					})
					_ = writeToStream(ctlStream, &ctlWriteMu, msg)
					// Wait briefly for the client to read/ACK the final control frame (revoked/close)
					// before sending QUIC CONNECTION_CLOSE which immediately discards unread stream data.
					_ = ctlStream.Close()
					select {
					case <-conn.Context().Done():
					case <-time.After(150 * time.Millisecond):
					}
					return
				}
				if fr.messageType == websocket.TextMessage {
					if err := writeToStream(ctlStream, &ctlWriteMu, fr.data); err != nil {
						return
					}
					continue
				}
				mu.Lock()
				cLane := ctrlLane
				bLane := bulkLane
				mu.Unlock()
				if len(fr.data) >= quicBulkThreshold && bLane != nil {
					if err := writeToStream(bLane, &bulkWriteMu, fr.data); err != nil {
						return
					}
				} else if cLane != nil {
					if err := writeToStream(cLane, &ctrlWriteMu, fr.data); err != nil {
						return
					}
				} else {
					return
				}
			case <-p.kill:
				return
			case <-q.ctx.Done():
				return
			}
		}
	}()

	relayEpoch := hello.RelayEpoch
	if len(relayEpoch) > 64 {
		relayEpoch = ""
	}
	var sinceSeq uint64
	hasSince := false
	if hello.SinceRelaySeq != nil {
		sinceSeq = *hello.SinceRelaySeq
		hasSince = true
	}
	q.srv.hub.joinWithResume(hello.PairID, hello.Role, p, relayEpoch, sinceSeq, hasSince)

	defer func() {
		q.srv.hub.leave(hello.PairID, hello.Role, p.id)
		p.abort()
		<-pumpDone
	}()

	select {
	case <-conn.Context().Done():
	case <-pumpDone:
	case <-q.ctx.Done():
	}
}

func (q *quicServer) readControlStream(stream *quic.Stream, p *peer) {
	defer p.abort()
	for {
		data, err := readQuicFrame(stream)
		if err != nil {
			return
		}
		if len(data) == 0 {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg["type"] == "ping" {
			pong := map[string]any{"type": "pong"}
			if id, ok := msg["id"]; ok {
				pong["id"] = id
			}
			p.sendJSON(pong)
		}
	}
}

func (q *quicServer) readDataStream(stream *quic.Stream, pairID, role string, p *peer) {
	defer p.abort()
	for {
		data, err := readQuicFrame(stream)
		if err != nil {
			return
		}
		if len(data) == 0 || len(data) > maxFrameBytes {
			continue
		}
		q.srv.hub.forward(pairID, role, websocket.BinaryMessage, data)
	}
}
