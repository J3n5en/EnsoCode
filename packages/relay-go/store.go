package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"

	_ "modernc.org/sqlite"
)

type Store struct {
	mu       sync.Mutex
	db       *sql.DB
	prunedAt int64 // 上次清理过期配对码的时刻（毫秒）
}

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS pairs (id TEXT PRIMARY KEY, state TEXT NOT NULL);`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) close() error {
	return s.db.Close()
}

func (s *Store) get(id string) (*PairState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLocked(id)
}

func (s *Store) put(id string, st PairState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.putLocked(id, st)
}

func (s *Store) delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleteLocked(id)
}

func (s *Store) requestPair(id, hostPublicKey string, now int64) (PairState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, err := s.getLocked(id)
	if err != nil {
		return PairState{}, err
	}
	next, changed := request(prev, now, hostPublicKey)
	if changed {
		if err := s.putLocked(id, next); err != nil {
			return PairState{}, err
		}
	}
	return next, nil
}

// pruneExpired 删掉过期未认领的配对码，口径同 isExpired（过期码已不能被认领）。
// /v1/pair/request 不鉴权，不清理的话循环 POST 新公钥能让 relay.sqlite 无限增长。
// 每个 TTL 至多扫一次全表，免得每次请求都扫；authorized 记录重连要用，不动。
func (s *Store) pruneExpired(now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now-s.prunedAt < pairTTLMS {
		return nil
	}
	rows, err := s.db.Query(`SELECT id, state FROM pairs`)
	if err != nil {
		return err
	}
	var expired []string
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			_ = rows.Close()
			return err
		}
		var st PairState
		// 解析不了的行跳过：一行坏数据不能卡住整个清理
		if json.Unmarshal([]byte(raw), &st) == nil && isExpired(st, now) {
			expired = append(expired, id)
		}
	}
	// 只有一个连接（SetMaxOpenConns(1)）：先读完并关掉 rows 再删，否则删除拿不到连接会自锁
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, id := range expired {
		if err := s.deleteLocked(id); err != nil {
			return err
		}
	}
	s.prunedAt = now
	return nil
}

func (s *Store) claimPair(id, boxedKey, deviceName string, now int64) (PairState, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, err := s.getLocked(id)
	if err != nil {
		return PairState{}, "", err
	}
	res := claim(prev, now, boxedKey, deviceName)
	if !res.ok {
		return PairState{}, res.error, nil
	}
	if err := s.putLocked(id, res.next); err != nil {
		return PairState{}, "", err
	}
	return res.next, "", nil
}

func (s *Store) revokePair(id, token string) (ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.getLocked(id)
	if err != nil {
		return false, err
	}
	if !tokenValid(st, roleHost, token) && !tokenValid(st, roleGuest, token) {
		return false, nil
	}
	if err := s.deleteLocked(id); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) getLocked(id string) (*PairState, error) {
	var raw string
	err := s.db.QueryRow(`SELECT state FROM pairs WHERE id = ?`, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var st PairState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return nil, fmt.Errorf("pair %s: %w", id, err)
	}
	return &st, nil
}

func (s *Store) putLocked(id string, st PairState) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO pairs (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state`, id, string(raw))
	return err
}

func (s *Store) deleteLocked(id string) error {
	_, err := s.db.Exec(`DELETE FROM pairs WHERE id = ?`, id)
	return err
}
