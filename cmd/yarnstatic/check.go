package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sync/errgroup"

	"yarnstatic/internal/lockfile"
	"yarnstatic/internal/s3client"
	"yarnstatic/internal/verdaccio"
)

const checkConcurrency = 16

// networkBypassProtocols bypass the plugin's wrapNetworkRequest block
// entirely (they don't fetch tarballs over httpUtils), so they deserve a
// louder warning than the routine workspace:/portal:/link: skip summary.
var networkBypassProtocols = []string{"git", "github", "exec"}

func runCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `Usage: yarnstatic check [flags] [path]

Parses <path>/yarn.lock (path defaults to the current directory) and
verifies that every npm-protocol, checksummed package it references exists
in the configured S3 bucket. Exits non-zero if anything is missing or
errored, listing every problem - not just the first.

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}

	path := "."
	switch fs.NArg() {
	case 0:
	case 1:
		path = fs.Arg(0)
	default:
		fmt.Fprintln(os.Stderr, "yarnstatic check: too many arguments (usage: check [flags] [path])")
		return 2
	}

	bucket, keyPrefix, s3opts, err := common.resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return 2
	}

	lockPath := filepath.Join(path, "yarn.lock")
	result, err := lockfile.ParseFile(lockPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return 2
	}

	scopeStorage, err := loadScopeStorage(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return 2
	}

	printSkipSummary(os.Stdout, result)

	if len(result.Entries) == 0 {
		fmt.Println("no npm packages with checksums found to verify")
		return 0
	}

	ctx := context.Background()
	client, err := s3client.New(ctx, bucket, s3opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: failed to initialize S3 client: %v\n", err)
		return 2
	}

	fmt.Printf("Checking s3://%s/%s ...\n\n", bucket, keyPrefix)

	type outcome struct {
		entry  lockfile.Entry
		key    string
		exists bool
		err    error
	}
	results := make([]outcome, len(result.Entries))

	var g errgroup.Group
	g.SetLimit(checkConcurrency)
	for i, entry := range result.Entries {
		i, entry := i, entry
		g.Go(func() error {
			key := verdaccio.TarballKey(keyPrefix, verdaccio.PackageSpec{
				Scope: entry.Scope, Name: entry.Name, Version: entry.Version,
			}, scopeStorage[entry.Scope])
			exists, err := client.Exists(ctx, key)
			// Never propagate the error through the group - that would
			// fail-fast cancel siblings, but the whole point is reporting
			// every missing/errored object, not just the first.
			results[i] = outcome{entry: entry, key: key, exists: exists, err: err}
			return nil
		})
	}
	_ = g.Wait()

	var missing, errored []outcome
	present := 0
	for _, r := range results {
		switch {
		case r.err != nil:
			errored = append(errored, r)
		case r.exists:
			present++
		default:
			missing = append(missing, r)
		}
	}

	if len(missing) > 0 {
		fmt.Printf("MISSING (%d):\n", len(missing))
		for _, r := range missing {
			fmt.Printf("  %-30s s3://%s/%s\n", r.entry.Descriptor, bucket, r.key)
		}
		fmt.Println()
	}
	if len(errored) > 0 {
		fmt.Printf("ERRORS (%d):\n", len(errored))
		for _, r := range errored {
			fmt.Printf("  %-30s %v\n", r.entry.Descriptor, r.err)
		}
		fmt.Println()
	}

	fmt.Printf("Summary: %d present, %d missing, %d error (out of %d checked)\n", present, len(missing), len(errored), len(results))

	if len(missing) > 0 || len(errored) > 0 {
		return 1
	}
	return 0
}

func printSkipSummary(w io.Writer, result *lockfile.Result) {
	counts := result.SkippedCounts()
	if len(counts) == 0 {
		fmt.Fprintf(w, "yarn.lock: %d npm package(s) with checksums (no entries skipped)\n", len(result.Entries))
		return
	}

	protos := make([]string, 0, len(counts))
	for p := range counts {
		protos = append(protos, string(p))
	}
	sort.Strings(protos)

	parts := make([]string, 0, len(protos))
	for _, p := range protos {
		parts = append(parts, fmt.Sprintf("%d %s:", counts[lockfile.Protocol(p)], p))
	}
	fmt.Fprintf(w, "yarn.lock: %d npm package(s) with checksums (skipped: %s)\n", len(result.Entries), strings.Join(parts, ", "))

	for _, p := range networkBypassProtocols {
		if n := counts[lockfile.Protocol(p)]; n > 0 {
			fmt.Fprintf(w, "WARNING: %d entries resolve via the %q protocol, which the yarnstatic plugin's network block does not cover - they may still require real network access during install\n", n, p)
		}
	}
}
