package main

import (
	"os"
	"strings"
	"testing"
)

// isolateEnv clears every YARNSTATIC_*, YARN_YARNSTATIC_* and
// YARN_RC_FILENAME variable and points HOME at an empty directory, for the
// length of the test. A shell that exported YARNSTATIC_BUCKET (the README's
// quick start does) would otherwise turn a "missing bucket" case into a
// real S3 request, and ~/.yarnrc.yml would leak into check.
func isolateEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		upper := strings.ToUpper(k)
		if strings.HasPrefix(upper, "YARNSTATIC_") || strings.HasPrefix(upper, "YARN_YARNSTATIC_") || upper == "YARN_RC_FILENAME" {
			t.Setenv(k, "") // registers the restore
			os.Unsetenv(k)
		}
	}
	t.Setenv("HOME", t.TempDir())
}

func TestRunDispatch(t *testing.T) {
	isolateEnv(t)
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"no args", []string{}, exitUsage},
		{"unknown command", []string{"bogus"}, exitUsage},
		{"help", []string{"--help"}, exitOK},
		{"version", []string{"version"}, exitOK},
		// Missing --bucket is an invalid-configuration problem, not a
		// usage problem - see config.go's exitConfiguration doc comment.
		{"check missing bucket", []string{"check", "--bucket=", "/nonexistent"}, exitConfiguration},
		{"check no yarn.lock is a usage error, not a config one", []string{"check", "--bucket", "b", "/nonexistent"}, exitUsage},
		{"fetch missing package is a usage error (checked before --bucket)", []string{"fetch", "--bucket", "b"}, exitUsage},
		{"fetch missing bucket", []string{"fetch", "--package", "lodash@4.17.21"}, exitConfiguration},
		{"serve missing socket is a usage error (checked before --bucket)", []string{"serve", "--bucket", "b"}, exitUsage},
		{"serve missing bucket", []string{"serve", "--socket", "/tmp/does-not-matter.sock"}, exitConfiguration},
		{"serve zero max-concurrency", []string{"serve", "--socket", "/tmp/does-not-matter.sock", "--max-concurrency", "0"}, exitUsage},
		{"serve negative max-concurrency", []string{"serve", "--socket", "/tmp/does-not-matter.sock", "--max-concurrency", "-1"}, exitUsage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := run(tc.args)
			if got != tc.want {
				t.Fatalf("run(%v) = %d, want %d", tc.args, got, tc.want)
			}
		})
	}
}
