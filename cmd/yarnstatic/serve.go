package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"yarnstatic/internal/s3client"
	"yarnstatic/internal/verdaccio"
)

const (
	defaultMaxConcurrency = 32
	idleTimeout           = 5 * time.Minute
	shutdownGrace         = 10 * time.Second

	// protocolVersion is this server's current/highest protocol version,
	// sent in the greeting on every connection (see docs/protocol.md). Bump
	// it when the wire format changes in a way older/newer parsers can't
	// just ignore via JSON's normal unknown-field tolerance.
	protocolVersion = "1.0"

	// minSupportedProtocolVersion is the oldest client-declared "ver" this
	// server still accepts requests from - equal to protocolVersion today
	// (nothing has ever been dropped), but distinct from it: as new
	// versions ship, protocolVersion moves forward while
	// minSupportedProtocolVersion only moves forward once support for
	// older clients is deliberately dropped. A request older than this
	// gets a normal {"ok": false, "message": "..."} response telling the
	// caller to upgrade - not a special error type, since it's really just
	// another reason a request can't be served.
	minSupportedProtocolVersion = "1.0"
)

// runServe implements the daemon the Yarn plugin talks to: one S3 client
// built once at startup, then any number of tarball fetches served over a
// Unix socket, one connection per request. See docs/protocol.md.
func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	var socketPath string
	var maxConcurrency int
	fs.StringVar(&socketPath, "socket", "", "unix socket path to listen on (required)")
	fs.IntVar(&maxConcurrency, "max-concurrency", defaultMaxConcurrency, "max concurrent S3 downloads in flight")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `Usage: yarnstatic serve --socket <path> [flags]

Runs a daemon that serves package tarballs over a Unix domain socket. This
is what the Yarn plugin talks to during "yarn install" - not meant to be
invoked directly. See docs/protocol.md for the wire protocol.

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if socketPath == "" {
		fmt.Fprintln(os.Stderr, "yarnstatic serve: --socket is required")
		return 2
	}

	bucket, keyPrefix, s3opts, err := common.resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic serve: %v\n", err)
		return 2
	}

	ctx := context.Background()
	client, err := s3client.New(ctx, bucket, s3opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic serve: failed to initialize S3 client: %v\n", err)
		return 2
	}

	_ = os.Remove(socketPath) // defensive: clear a stale socket file, if any

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic serve: failed to listen on %s: %v\n", socketPath, err)
		return 2
	}
	defer os.Remove(socketPath)

	fmt.Fprintf(os.Stderr, "yarnstatic serve: listening on %s (bucket=%s)\n", socketPath, bucket)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup

	type acceptResult struct {
		conn net.Conn
		err  error
	}
	connCh := make(chan acceptResult)
	go func() {
		for {
			conn, err := listener.Accept()
			connCh <- acceptResult{conn: conn, err: err}
			if err != nil {
				return
			}
		}
	}()

	idleTimer := time.NewTimer(idleTimeout)
	defer idleTimer.Stop()

	shutdown := func(reason string) int {
		fmt.Fprintf(os.Stderr, "yarnstatic serve: %s, shutting down\n", reason)
		listener.Close()
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(shutdownGrace):
			fmt.Fprintln(os.Stderr, "yarnstatic serve: shutdown grace period elapsed, exiting with connections still in flight")
		}
		return 0
	}

	for {
		select {
		case sig := <-sigCh:
			return shutdown(fmt.Sprintf("received %s", sig))
		case <-idleTimer.C:
			// Safety net for ungraceful parent termination (kill -9, OOM):
			// a plain child process doesn't die just because its parent
			// did, so self-terminate if nothing has asked for a fetch in
			// a while rather than leaking indefinitely.
			return shutdown("idle timeout reached")
		case res := <-connCh:
			if res.err != nil {
				fmt.Fprintf(os.Stderr, "yarnstatic serve: listener closed: %v\n", res.err)
				wg.Wait()
				return 0
			}
			if !idleTimer.Stop() {
				<-idleTimer.C
			}
			idleTimer.Reset(idleTimeout)

			wg.Add(1)
			go func(conn net.Conn) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				handleConn(ctx, conn, client, keyPrefix)
			}(res.conn)
		}
	}
}

// request is one line of JSON, {"package": "...", "storageFolder": "...",
// "ver": "..."} - storageFolder is optional, see verdaccio.TarballKey. ver
// is the client's protocolVersion, sent on every request so the server can
// tell old and new clients apart if the protocol ever needs to branch on
// it - see docs/protocol.md. Using JSON (rather than a fixed text format)
// means new optional fields, like this one, can be added later without
// breaking either side's parser.
type request struct {
	Package       string `json:"package"`
	StorageFolder string `json:"storageFolder,omitempty"`
	Ver           string `json:"ver,omitempty"`
}

// response is one line of JSON. Three shapes:
//   - greeting, sent unprompted as the first thing on every connection:
//     {"ok": true, "ver": "1.0", "ready": true}
//   - fetch success: {"ok": true, "length": N} (tarball bytes follow)
//   - fetch failure: {"ok": false, "message": "..."}
type response struct {
	OK      bool   `json:"ok"`
	Ver     string `json:"ver,omitempty"`
	Ready   bool   `json:"ready,omitempty"`
	Length  int    `json:"length,omitempty"`
	Message string `json:"message,omitempty"`
}

// greeting is what handleConn sends immediately upon accepting any
// connection, before reading anything - see docs/protocol.md.
func greeting() response {
	return response{OK: true, Ver: protocolVersion, Ready: true}
}

// parseRequestLine decodes one already-read request line. Trailing "\r\n"
// and bare "\n" are both accepted (nc/telnet-style manual testing tends to
// send "\r\n") - TrimRight strips a trailing "\r" explicitly, and
// encoding/json would silently tolerate one left in anyway (RFC 8259
// treats CR as insignificant whitespace), so this is covered twice over.
func parseRequestLine(line string) (request, error) {
	line = strings.TrimRight(line, "\r\n")

	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return request{}, err
	}
	return req, nil
}

// compareVersions compares "major.minor" version strings numerically
// (unlike a plain string compare, this gets "1.10" > "1.9" right).
// Unparseable components are treated as 0 rather than erroring - an
// invalid version string is handled by the caller deciding what to do
// with the resulting ordering, not by failing here.
func compareVersions(a, b string) int {
	aMajor, aMinor := parseVersion(a)
	bMajor, bMinor := parseVersion(b)
	if aMajor != bMajor {
		return aMajor - bMajor
	}
	return aMinor - bMinor
}

// parseVersion reads only the major and minor components, ignoring a
// third+ component if present (e.g. "1.2.3" parses the same as "1.2") -
// this project's versions are documented and used as "major.minor" only
// (see docs/protocol.md). Using strings.Split (not SplitN with a limit of
// 2) matters here: SplitN would lump "2.3" together as one piece for
// "1.2.3", which then fails strconv.Atoi outright and silently produces
// minor=0 - exactly the same wrong answer for "1.2.3" and "1.3.0".
func parseVersion(v string) (major, minor int) {
	parts := strings.Split(v, ".")
	if len(parts) > 0 {
		major, _ = strconv.Atoi(parts[0])
	}
	if len(parts) > 1 {
		minor, _ = strconv.Atoi(parts[1])
	}
	return major, minor
}

// handleConn services exactly one request per connection: send the
// greeting, read a JSON request line, respond with a JSON response line,
// then tarball bytes on success. See docs/protocol.md.
func handleConn(ctx context.Context, conn net.Conn, client *s3client.Client, keyPrefix string) {
	defer conn.Close()

	if err := writeJSONLine(conn, greeting()); err != nil {
		return
	}

	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		// A connection that reads the greeting and disconnects without
		// sending a request is the plugin's readiness probe, not an error -
		// see docs/plugin.md. Anything other than a clean EOF is still
		// logged, since that's a genuine unexpected I/O failure.
		if !errors.Is(err, io.EOF) {
			fmt.Fprintf(os.Stderr, "yarnstatic serve: failed to read request: %v\n", err)
		}
		return
	}

	req, err := parseRequestLine(line)
	if err != nil {
		writeErr(conn, fmt.Sprintf("malformed request: %v", err))
		fmt.Fprintf(os.Stderr, "yarnstatic serve: malformed request %q: %v\n", line, err)
		return
	}

	// Empty Ver means a client that predates this whole mechanism - treat
	// it as compatible rather than rejecting it outright. This check is a
	// no-op today (minSupportedProtocolVersion == protocolVersion, so
	// nothing has ever been dropped) - it exists so a future version bump
	// that *does* drop support for old clients has somewhere to reject
	// them, with a clear reason, instead of failing in some more confusing
	// way further down.
	if req.Ver != "" && compareVersions(req.Ver, minSupportedProtocolVersion) < 0 {
		msg := fmt.Sprintf(
			"server no longer supports protocol version %s (minimum supported: %s) - please upgrade yarnstatic and the yarn plugin",
			req.Ver, minSupportedProtocolVersion,
		)
		writeErr(conn, msg)
		fmt.Fprintf(os.Stderr, "yarnstatic serve: %s\n", msg)
		return
	}

	spec, err := verdaccio.ParsePackageSpec(req.Package)
	if err != nil {
		writeErr(conn, err.Error())
		fmt.Fprintf(os.Stderr, "yarnstatic serve: %v\n", err)
		return
	}

	// Buffered here (rather than streamed) so the length header required by
	// the protocol can be written before the body; bounded in aggregate by
	// --max-concurrency.
	var buf bytes.Buffer
	key, err := downloadPackage(ctx, client, keyPrefix, spec, req.StorageFolder, &buf)
	if err != nil {
		msg := describeDownloadError(err, key)
		writeErr(conn, msg)
		fmt.Fprintf(os.Stderr, "yarnstatic serve: %s: %s\n", spec, msg)
		return
	}

	if err := writeJSONLine(conn, response{OK: true, Length: buf.Len()}); err != nil {
		return
	}
	_, _ = conn.Write(buf.Bytes())
}

func writeErr(conn net.Conn, msg string) {
	_ = writeJSONLine(conn, response{OK: false, Message: msg})
}

func writeJSONLine(conn net.Conn, resp response) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = conn.Write(data)
	return err
}

func describeDownloadError(err error, key string) string {
	switch {
	case s3client.IsNotFound(err):
		return fmt.Sprintf("not found: %s", key)
	case s3client.IsAccessDenied(err):
		return fmt.Sprintf("access denied: %s", key)
	default:
		return fmt.Sprintf("download failed: %v", err)
	}
}
