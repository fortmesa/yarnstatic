package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"yarnstatic/internal/s3client"
)

// fakeS3 serves path-style HEAD/GET for the given "bucket/key" objects and
// 404s everything else. It also points the AWS SDK at static credentials
// and away from the developer's own config, so nothing here can reach AWS.
func fakeS3(t *testing.T, objects map[string]string) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	for k, v := range map[string]string{
		"AWS_ACCESS_KEY_ID":           "test",
		"AWS_SECRET_ACCESS_KEY":       "test",
		"AWS_REGION":                  "us-east-1",
		"AWS_EC2_METADATA_DISABLED":   "true",
		"AWS_CONFIG_FILE":             filepath.Join(dir, "config"),
		"AWS_SHARED_CREDENTIALS_FILE": filepath.Join(dir, "credentials"),
	} {
		t.Setenv(k, v)
	}
	for _, k := range []string{"AWS_PROFILE", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := objects[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			if r.Method != http.MethodHead {
				_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>no</Message></Error>`)
			}
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, body)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// captureStdout runs fn with os.Stdout redirected, returning its result
// and everything it printed.
func captureStdout(t *testing.T, fn func() int) (int, string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	code := fn()
	w.Close()
	os.Stdout = old
	return code, <-done
}

const checkLock = `__metadata:
  version: 8

"lodash@npm:4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard

"@acme/widgets@npm:1.0.0":
  version: 1.0.0
  resolution: "@acme/widgets@npm:1.0.0"
  checksum: 10c0/bbbb
  languageName: node
  linkType: hard

"@esbuild/darwin-arm64@npm:0.25.12":
  version: 0.25.12
  resolution: "@esbuild/darwin-arm64@npm:0.25.12"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard

"mylib@github:acme/mylib#v1.0.0":
  version: 1.0.0
  resolution: "mylib@https://github.com/acme/mylib.git#commit=0123456789abcdef0123456789abcdef01234567"
  checksum: 10c0/cccc
  languageName: node
  linkType: hard
`

func checkProject(t *testing.T, endpoint string) string {
	t.Helper()
	project := t.TempDir()
	writeRc(t, project, "yarn.lock", checkLock)
	writeRc(t, project, ".yarnrc.yml", "yarnstaticBucket: b\nyarnstaticKeyPrefix: mirror\nyarnstaticEndpoint: "+endpoint+"\nyarnstaticScopeStorage:\n  acme: acme-store\n")
	return project
}

func TestCheckReadsYarnrcAndReportsNoChecksumSeparately(t *testing.T) {
	isolateEnv(t)
	srv := fakeS3(t, map[string]string{
		"b/mirror/lodash/lodash-4.17.21.tgz":                  "x",
		"b/mirror/acme-store/@acme/widgets/widgets-1.0.0.tgz": "y",
	})
	project := checkProject(t, srv.URL)

	code, out := captureStdout(t, func() int { return run([]string{"check", project}) })
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (a missing no-checksum entry doesn't count):\n%s", code, exitOK, out)
	}
	for _, want := range []string{
		"yarn.lock: 2 npm package(s) with checksums, 1 without (skipped: 1 https:)",
		"WARNING: 1 entries resolve from git repositories",
		"  mylib@github:acme/mylib#v1.0.0",
		"Checking s3://b/mirror ...",
		"MISSING, NO CHECKSUM (1) - not counted in the exit code:",
		"s3://b/mirror/@esbuild/darwin-arm64/darwin-arm64-0.25.12.tgz (os=darwin & cpu=arm64)",
		"Summary: 2 present, 0 missing, 0 error (out of 2 checked)",
		"No checksum: 0 present, 1 missing, 0 error (out of 1 checked, not counted in the exit code)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
}

func TestCheckMissingChecksummedEntry(t *testing.T) {
	isolateEnv(t)
	// Without the scope storage folder in the key, widgets is missing.
	srv := fakeS3(t, map[string]string{
		"b/mirror/lodash/lodash-4.17.21.tgz":       "x",
		"b/mirror/@acme/widgets/widgets-1.0.0.tgz": "y",
	})
	project := checkProject(t, srv.URL)

	code, out := captureStdout(t, func() int { return run([]string{"check", project}) })
	if code != exitMissing {
		t.Fatalf("exit = %d, want %d:\n%s", code, exitMissing, out)
	}
	if !strings.Contains(out, "s3://b/mirror/acme-store/@acme/widgets/widgets-1.0.0.tgz") {
		t.Fatalf("output lacks the scope-storage key:\n%s", out)
	}
}

func TestCheckFlagAndEnvOverrideYarnrc(t *testing.T) {
	isolateEnv(t)
	srv := fakeS3(t, map[string]string{
		"other/env-prefix/lodash/lodash-4.17.21.tgz":                  "x",
		"other/env-prefix/acme-store/@acme/widgets/widgets-1.0.0.tgz": "y",
	})
	project := checkProject(t, srv.URL)
	t.Setenv("YARNSTATIC_KEY_PREFIX", "env-prefix")

	code, out := captureStdout(t, func() int { return run([]string{"check", "--bucket", "other", project}) })
	if code != exitOK {
		t.Fatalf("exit = %d, want %d:\n%s", code, exitOK, out)
	}
	if !strings.Contains(out, "Checking s3://other/env-prefix ...") {
		t.Fatalf("flag/env didn't win over .yarnrc.yml:\n%s", out)
	}
}

func TestFetchWriteFailureIsAUsageError(t *testing.T) {
	isolateEnv(t)
	srv := fakeS3(t, map[string]string{"b/verdaccio/lodash/lodash-4.17.21.tgz": "tarball"})
	args := []string{"fetch", "--bucket", "b", "--endpoint", srv.URL, "--package", "lodash@4.17.21"}

	out := filepath.Join(t.TempDir(), "out.tgz")
	if code := run(append(args, "--out", out)); code != exitOK {
		t.Fatalf("fetch to a file: exit %d, want %d", code, exitOK)
	}
	if b, _ := os.ReadFile(out); string(b) != "tarball" {
		t.Fatalf("fetched %q, want %q", b, "tarball")
	}

	if _, err := os.Stat("/dev/full"); err != nil {
		t.Skip("/dev/full not available")
	}
	if code := run(append(args, "--out", "/dev/full")); code != exitUsage {
		t.Fatalf("fetch to /dev/full: exit %d, want %d (a local write failure)", code, exitUsage)
	}
}

// TestServeSendsZeroLength checks that an empty object still gets a
// "length" field, which the plugin requires on every success response.
func TestServeSendsZeroLength(t *testing.T) {
	isolateEnv(t)
	srv := fakeS3(t, map[string]string{"b/verdaccio/empty/empty-1.0.0.tgz": ""})
	ctx := context.Background()
	client, err := s3client.New(ctx, "b", s3client.Options{Endpoint: srv.URL})
	if err != nil {
		t.Fatal(err)
	}

	serverConn, clientConn := net.Pipe()
	go handleConn(ctx, serverConn, client, "verdaccio")
	defer clientConn.Close()

	r := bufio.NewReader(clientConn)
	if _, err := r.ReadString('\n'); err != nil {
		t.Fatalf("reading greeting: %v", err)
	}
	if _, err := io.WriteString(clientConn, `{"package": "empty@1.0.0", "ver": "1.0"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	line, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("reading response: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("response %q: %v", line, err)
	}
	if got["ok"] != true || got["length"] != float64(0) || len(got) != 2 {
		t.Fatalf("response = %v, want {ok: true, length: 0}", got)
	}
}
