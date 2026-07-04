package main

import "testing"

func TestRunDispatch(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"no args", []string{}, 2},
		{"unknown command", []string{"bogus"}, 2},
		{"help", []string{"--help"}, 0},
		{"check missing bucket", []string{"check", "--bucket=", "/nonexistent"}, 2},
		{"fetch missing package", []string{"fetch", "--bucket", "b"}, 2},
		{"serve missing socket", []string{"serve", "--bucket", "b"}, 2},
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
