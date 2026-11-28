package main

import (
	"context"
	"crypto/tls"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed all:frontend
var frontendFS embed.FS

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	flags := flag.NewFlagSet("enso-relay", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	listen := flags.String("listen", envOr("RELAY_LISTEN", ":8787"), "监听地址")
	dbPath := flags.String("db", envOr("RELAY_DB", ""), "SQLite 路径（默认：可执行文件旁边的 relay.sqlite）")
	tlsCert := flags.String("tls-cert", envOr("RELAY_TLS_CERT", ""), "可选 TLS 证书")
	tlsKey := flags.String("tls-key", envOr("RELAY_TLS_KEY", ""), "可选 TLS 私钥")
	quicListen := flags.String("quic-listen", envOr("RELAY_QUIC_LISTEN", ""), "可选原生 QUIC UDP 监听地址（例如 :443，需搭配 --tls-cert 与 --tls-key）")
	showVersion := flags.Bool("version", false, "打印版本")
	autoUpdate := flags.Bool("auto-update", envBool("RELAY_AUTO_UPDATE", true), "检查并安装 GitHub Release 更新")
	updateInterval := flags.Duration("update-interval", envDuration("RELAY_UPDATE_INTERVAL", defaultUpdateInterval), "自动更新检查间隔")
	doUpdate := flags.Bool("update", false, "检查并安装更新后退出")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Println(version)
		return 0
	}

	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	updater := newSelfUpdater(log)
	if *doUpdate {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		applied, err := updater.checkAndApply(ctx)
		if err != nil {
			log.Error("update", "err", err)
			return 1
		}
		if applied {
			log.Info("updated; restart the process")
			return 0
		}
		log.Info("already up to date", "version", version)
		return 0
	}
	if *dbPath == "" {
		*dbPath = defaultDBPath()
	}
	if err := os.MkdirAll(filepath.Dir(*dbPath), 0o755); err != nil && filepath.Dir(*dbPath) != "." {
		log.Error("create db dir", "err", err)
		return 1
	}

	store, err := openStore(*dbPath)
	if err != nil {
		log.Error("open sqlite", "path", *dbPath, "err", err)
		return 1
	}
	defer store.close()

	static, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Error("embed frontend", "err", err)
		return 1
	}

	relaySrv := newServer(store, static, log)
	srv := &http.Server{
		Addr:              *listen,
		Handler:           relaySrv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	var quicSrv *quicServer
	if *quicListen != "" {
		if *tlsCert == "" || *tlsKey == "" {
			log.Error("quic requires --tls-cert and --tls-key")
			return 1
		}
		cert, err := tls.LoadX509KeyPair(*tlsCert, *tlsKey)
		if err != nil {
			log.Error("load quic tls cert", "err", err)
			return 1
		}
		qs, err := startQuicServer(relaySrv, *quicListen, &tls.Config{
			Certificates: []tls.Certificate{cert},
			NextProtos:   []string{quicALPN},
			MinVersion:   tls.VersionTLS13,
		})
		if err != nil {
			log.Error("listen quic", "addr", *quicListen, "err", err)
			return 1
		}
		quicSrv = qs
		log.Info("quic listening", "addr", qs.Addr().String(), "alpn", quicALPN)
	}

	var wantRestart atomic.Bool
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		if quicSrv != nil {
			_ = quicSrv.Close()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	scheme := "http"
	if *tlsCert != "" && *tlsKey != "" {
		scheme = "https"
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Error("listen", "addr", *listen, "err", err)
		return 1
	}
	printBanner(scheme, ln.Addr().String(), *dbPath)
	if *autoUpdate {
		if _, ok := parseSemver(version); !ok || !exeUpdatable(updater.exe) {
			log.Info("auto-update skipped", "version", version)
		} else {
			if *updateInterval < minUpdateInterval {
				*updateInterval = minUpdateInterval
			}
			updater.interval = *updateInterval
			log.Info("auto-update", "interval", updater.interval)
			go updater.loop(ctx, func() {
				wantRestart.Store(true)
				stop()
			})
		}
	}

	var serveErr error
	if scheme == "https" {
		serveErr = srv.ServeTLS(ln, *tlsCert, *tlsKey)
	} else {
		serveErr = srv.Serve(ln)
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		log.Error("serve", "err", serveErr)
		return 1
	}
	if wantRestart.Load() {
		_ = store.close()
		if err := updater.restart(os.Args, os.Environ()); err != nil {
			log.Error("restart after update", "err", err)
			return 1
		}
	}
	return 0
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func defaultDBPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "relay.sqlite"
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	base := strings.ToLower(filepath.Base(dir))
	if strings.Contains(base, "go-build") || strings.HasPrefix(base, "tmp") {
		return "relay.sqlite"
	}
	return filepath.Join(dir, "relay.sqlite")
}

func printBanner(scheme, listen, dbPath string) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		port = "8787"
		host = ""
	}
	fmt.Printf("enso-relay %s\n", version)
	fmt.Printf("  监听    %s://%s\n", scheme, displayAddr(host, port))
	fmt.Printf("  本机    %s://127.0.0.1:%s\n", scheme, port)
	for _, ip := range lanIPs() {
		fmt.Printf("  局域网  %s://%s:%s\n", scheme, ip, port)
	}
	fmt.Printf("  数据库  %s\n", dbPath)
	fmt.Printf("  手机打开上面的地址即可配对（已内嵌 PWA）\n")
}

func displayAddr(host, port string) string {
	if host == "" || host == "0.0.0.0" || host == "::" {
		return "0.0.0.0:" + port
	}
	return net.JoinHostPort(host, port)
}

func lanIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}
