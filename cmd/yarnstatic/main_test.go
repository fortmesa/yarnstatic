package main

import "testing"

func TestRunDispatch(t *testing.T) {
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
