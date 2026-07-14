package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestParseRequestLine(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		want    request
		wantErr bool
	}{
		{
			"bare LF line ending",
			`{"package": "lodash@4.17.21"}` + "\n",
			request{Package: "lodash@4.17.21"},
			false,
		},
		{
			"CRLF line ending - nc/telnet-style manual testing",
			`{"package": "lodash@4.17.21"}` + "\r\n",
			request{Package: "lodash@4.17.21"},
			false,
		},
		{
			"CRLF with storageFolder",
			`{"package": "@acme/widgets@1.0.0", "storageFolder": "acme-storage"}` + "\r\n",
			request{Package: "@acme/widgets@1.0.0", StorageFolder: "acme-storage"},
			false,
		},
		{
			"with ver field",
			`{"package": "lodash@4.17.21", "ver": "1.0"}` + "\n",
			request{Package: "lodash@4.17.21", Ver: "1.0"},
			false,
		},
		{
			"unrecognized ver value is not a parse error - the server doesn't reject on it",
			`{"package": "lodash@4.17.21", "ver": "99.0"}` + "\n",
			request{Package: "lodash@4.17.21", Ver: "99.0"},
			false,
		},
		{
			"no trailing newline at all",
			`{"package": "lodash@4.17.21"}`,
			request{Package: "lodash@4.17.21"},
			false,
		},
		{
			"malformed JSON",
			"lodash@4.17.21\n",
			request{},
			true,
		},
		{
			"empty line",
			"\n",
			request{},
			true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRequestLine(tc.line)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int // sign only - exact magnitude isn't part of the contract
	}{
		{"1.0", "1.0", 0},
		{"1.0", "1.1", -1},
		{"1.1", "1.0", 1},
		{"1.9", "2.0", -1},
		{"2.0", "1.9", 1},
		// numeric, not lexicographic, comparison - "1.10" > "1.9"
		{"1.10", "1.9", 1},
		{"1.9", "1.10", -1},
		{"1", "1.0", 0}, // missing minor defaults to 0
		// a third+ component is ignored, not compared - this project's
		// versions are "major.minor" only (see docs/protocol.md). Regression
		// test: an earlier version of parseVersion used strings.SplitN with a
		// limit of 2, which lumped "2.3" together as one piece for "1.2.3"
		// and failed to parse it as an integer at all, silently treating
		// both "1.2.3" and "1.3.0" as minor=0 (falsely equal).
		{"1.2.3", "1.3.0", -1},
		{"1.2.3", "1.2.9", 0}, // same major.minor once the 3rd component is ignored
		// malformed input degrades to 0, not an error - and, critically,
		// not a value that breaks comparison against a well-formed version
		{"abc", "1.0", -1},
		{"1.0", "abc", 1},
	}
	for _, tc := range cases {
		t.Run(tc.a+"_vs_"+tc.b, func(t *testing.T) {
			got := compareVersions(tc.a, tc.b)
			gotSign := sign(got)
			if gotSign != tc.want {
				t.Fatalf("compareVersions(%q, %q) = %d (sign %d), want sign %d", tc.a, tc.b, got, gotSign, tc.want)
			}
		})
	}
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}

// TestGreetingShape locks in the exact wire shape the plugin's
// checkGreeting() depends on (docs/protocol.md) - a change here without a
// matching plugin-side change is exactly the kind of skew this whole
// mechanism exists to catch.
func TestGreetingShape(t *testing.T) {
	data, err := json.Marshal(greeting())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[string]any{"ok": true, "ver": protocolVersion, "ready": true}
	if len(got) != len(want) {
		t.Fatalf("got %d fields %v, want %d fields %v", len(got), got, len(want), want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("field %q: got %v, want %v (full: %v)", k, got[k], v, got)
		}
	}
}

// TestListenOnUnixSocketRestrictsPermissions is the actual regression test
// for the fix: under a permissive umask (0, common in root-run
// containers/some CI images) that would otherwise leave the socket
// world-writable, listenOnUnixSocket() must still produce a 0600 socket.
// Explicitly sets umask 0 rather than trusting whatever the test runner
// happens to have, so this fails loudly if the chmod is ever removed
// instead of silently depending on the ambient environment.
func TestListenOnUnixSocketRestrictsPermissions(t *testing.T) {
	oldUmask := syscall.Umask(0)
	defer syscall.Umask(oldUmask)

	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")

	listener, err := listenOnUnixSocket(socketPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer listener.Close()

	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatalf("unexpected error stat'ing socket: %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("socket permissions = %#o, want 0600 (umask was set to 0, so without the chmod this would be 0777)", got)
	}
}

// TestListenOnUnixSocketClearsStaleSocketFile confirms the pre-existing
// "remove a stale socket file left by a crashed prior run" behavior still
// works after extracting this into its own function.
func TestListenOnUnixSocketClearsStaleSocketFile(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")

	if err := os.WriteFile(socketPath, []byte("stale"), 0644); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	listener, err := listenOnUnixSocket(socketPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer listener.Close()
}
