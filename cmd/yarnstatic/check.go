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

func runCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `Usage: yarnstatic check [flags] [path]

Parses <path>/yarn.lock (path defaults to the current directory) and
verifies that every npm-protocol, checksummed package it references exists
in the configured S3 bucket. Exits non-zero if anything is missing or
errored, listing every problem - not just the first. npm entries without a
checksum (platform-specific packages) are checked too and reported
separately, without affecting the exit code.

Settings left unset by flags and YARNSTATIC_* env vars are read from the
same .yarnrc.yml files Yarn loads for <path> (yarnstaticBucket,
yarnstaticKeyPrefix, yarnstaticRegion, yarnstaticEndpoint,
yarnstaticProfile, yarnstaticScopeStorage).

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}

	path := "."
	switch fs.NArg() {
	case 0:
	case 1:
		path = fs.Arg(0)
	default:
		fmt.Fprintln(os.Stderr, "yarnstatic check: too many arguments (usage: check [flags] [path])")
		return exitUsage
	}

	rc, err := loadYarnrc(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return exitUsage
	}

	// requireBucket (inside resolveWith) is the "missing bucket name" case
	// the exitConfiguration code exists for - see config.go.
	bucket, keyPrefix, s3opts, err := common.resolveWith(rc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return exitConfiguration
	}

	lockPath := filepath.Join(path, "yarn.lock")
	result, err := lockfile.ParseFile(lockPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic check: %v\n", err)
		return exitUsage
	}

	printSkipSummary(os.Stdout, result)

	if len(result.Entries) == 0 && len(result.NoChecksum) == 0 {
		fmt.Println("no npm packages found to verify")
		return exitOK
	}

	ctx := context.Background()
	client, err := s3client.New(ctx, bucket, s3opts)
	if err != nil {
		// Anything that can fail here (bad --profile, a malformed shared
		// config/credentials file, ...) is a setup problem, not a rejected
		// connection attempt - see exitConfiguration's own doc comment.
		fmt.Fprintf(os.Stderr, "yarnstatic check: failed to initialize S3 client: %v\n", err)
		return exitConfiguration
	}

	fmt.Printf("Checking s3://%s/%s ...\n\n", bucket, keyPrefix)

	// Both groups share one errgroup, so the concurrency limit covers all
	// HEAD requests in flight.
	all := append(append([]lockfile.Entry{}, result.Entries...), result.NoChecksum...)
	allResults := make([]checkOutcome, len(all))

	var g errgroup.Group
	g.SetLimit(checkConcurrency)
	for i, entry := range all {
		i, entry := i, entry
		g.Go(func() error {
			key := verdaccio.TarballKey(keyPrefix, verdaccio.PackageSpec{
				Scope: entry.Scope, Name: entry.Name, Version: entry.Version,
			}, rc.ScopeStorage[entry.Scope])
			exists, err := client.Exists(ctx, key)
			// Never propagate the error through the group - that would
			// fail-fast cancel siblings, but the whole point is reporting
			// every missing/errored object, not just the first.
			allResults[i] = checkOutcome{entry: entry, key: key, exists: exists, err: err}
			return nil
		})
	}
	_ = g.Wait()

	results := allResults[:len(result.Entries)]
	noChecksumResults := allResults[len(result.Entries):]

	present, missing, errored, kindCounts := tallyOutcomes(results)

	if len(missing) > 0 {
		fmt.Printf("MISSING (%d):\n", len(missing))
		for _, r := range missing {
			fmt.Printf("  %-30s s3://%s/%s\n", r.entry.Descriptor, bucket, r.key)
		}
		fmt.Println()
	}
	if len(errored) > 0 {
		// Note: without s3:ListBucket permission, an "access denied" here
		// might actually be a missing object S3 won't confirm/deny the
		// existence of to this role - see s3client.Classify's doc comment.
		fmt.Printf("ERRORS (%d):\n", len(errored))
		for _, r := range errored {
			fmt.Printf("  %-30s [%s] %v\n", r.entry.Descriptor, s3client.Classify(r.err), r.err)
		}
		fmt.Println()
	}

	ncPresent, ncMissing, ncErrored, _ := tallyOutcomes(noChecksumResults)
	if len(ncMissing) > 0 {
		fmt.Printf("MISSING, NO CHECKSUM (%d) - not counted in the exit code:\n", len(ncMissing))
		for _, r := range ncMissing {
			fmt.Printf("  %-30s s3://%s/%s%s\n", r.entry.Descriptor, bucket, r.key, conditionsSuffix(r.entry))
		}
		fmt.Println()
	}
	if len(ncErrored) > 0 {
		fmt.Printf("ERRORS, NO CHECKSUM (%d) - not counted in the exit code:\n", len(ncErrored))
		for _, r := range ncErrored {
			fmt.Printf("  %-30s [%s] %v%s\n", r.entry.Descriptor, s3client.Classify(r.err), r.err, conditionsSuffix(r.entry))
		}
		fmt.Println()
	}

	fmt.Printf("Summary: %d present, %d missing, %d error (out of %d checked)\n", present, len(missing), len(errored), len(results))
	if len(errored) > 0 {
		fmt.Printf("  errors by kind: %s\n", formatKindCounts(kindCounts))
	}
	if len(noChecksumResults) > 0 {
		fmt.Printf("No checksum: %d present, %d missing, %d error (out of %d checked, not counted in the exit code)\n",
			ncPresent, len(ncMissing), len(ncErrored), len(noChecksumResults))
	}

	// Priority order, most to least fundamental: a misconfigured
	// connection or a wholesale inability to authenticate means nothing in
	// this run can be trusted, so those outrank a merely-denied or
	// merely-unclassified error, which in turn outrank a confirmed-missing
	// object - the most common and least alarming outcome. See
	// exitCodeForKind and config.go's own doc comment on this ordering.
	switch {
	case kindCounts[s3client.KindConfiguration] > 0:
		return exitConfiguration
	case kindCounts[s3client.KindNoCredentials] > 0:
		return exitNoCredentials
	case kindCounts[s3client.KindAccessDenied] > 0:
		return exitAccessDenied
	case kindCounts[s3client.KindOther] > 0:
		return exitOtherError
	case len(missing) > 0:
		return exitMissing
	}
	return exitOK
}

type checkOutcome struct {
	entry  lockfile.Entry
	key    string
	exists bool
	err    error
}

func tallyOutcomes(results []checkOutcome) (present int, missing, errored []checkOutcome, kindCounts map[s3client.ErrorKind]int) {
	kindCounts = map[s3client.ErrorKind]int{}
	for _, r := range results {
		switch {
		case r.err != nil:
			errored = append(errored, r)
			kindCounts[s3client.Classify(r.err)]++
		case r.exists:
			present++
		default:
			missing = append(missing, r)
		}
	}
	return present, missing, errored, kindCounts
}

// conditionsSuffix shows which platforms a no-checksum entry is for.
func conditionsSuffix(e lockfile.Entry) string {
	if e.Conditions == "" {
		return ""
	}
	return fmt.Sprintf(" (%s)", e.Conditions)
}

// formatKindCounts renders a fixed, priority order (matching the exit-code
// priority above) rather than map iteration order, so the summary line is
// deterministic across runs.
func formatKindCounts(counts map[s3client.ErrorKind]int) string {
	kinds := []s3client.ErrorKind{
		s3client.KindConfiguration,
		s3client.KindNoCredentials,
		s3client.KindAccessDenied,
		s3client.KindOther,
	}
	var parts []string
	for _, k := range kinds {
		if n := counts[k]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, k))
		}
	}
	return strings.Join(parts, ", ")
}

func printSkipSummary(w io.Writer, result *lockfile.Result) {
	packages := fmt.Sprintf("%d npm package(s) with checksums, %d without", len(result.Entries), len(result.NoChecksum))

	counts := result.SkippedCounts()
	if len(counts) == 0 {
		fmt.Fprintf(w, "yarn.lock: %s (no entries skipped)\n", packages)
	} else {
		protos := make([]string, 0, len(counts))
		for p := range counts {
			protos = append(protos, string(p))
		}
		sort.Strings(protos)

		parts := make([]string, 0, len(protos))
		for _, p := range protos {
			parts = append(parts, fmt.Sprintf("%d %s:", counts[lockfile.Protocol(p)], p))
		}
		fmt.Fprintf(w, "yarn.lock: %s (skipped: %s)\n", packages, strings.Join(parts, ", "))
	}

	// Git and exec: entries never reach the network hook the plugins wrap
	// (Yarn clones git dependencies with git itself, and runs exec: scripts),
	// so they deserve a louder warning than the routine skip summary. An
	// npm entry whose __archiveUrl the plugins can't parse is blocked at
	// install time.
	var git, exec, archive []lockfile.Skipped
	for _, s := range result.Skipped {
		switch {
		case s.Reason == lockfile.SkipArchiveURL:
			archive = append(archive, s)
		case lockfile.IsGitReference(s.Reference):
			git = append(git, s)
		case s.Protocol == "exec":
			exec = append(exec, s)
		}
	}
	if len(git) > 0 {
		fmt.Fprintf(w, "WARNING: %d entries resolve from git repositories, which Yarn clones with git outside the yarnstatic plugin's network block - they need real network access during install:\n", len(git))
		for _, s := range git {
			fmt.Fprintf(w, "  %s\n", s.Descriptor)
		}
	}
	if len(exec) > 0 {
		fmt.Fprintf(w, "WARNING: %d entries resolve via the \"exec\" protocol, which the yarnstatic plugin's network block does not cover - they may still require real network access during install:\n", len(exec))
		for _, s := range exec {
			fmt.Fprintf(w, "  %s\n", s.Descriptor)
		}
	}
	if len(archive) > 0 {
		fmt.Fprintf(w, "WARNING: %d npm entries carry an __archiveUrl that isn't an npm tarball URL, so the yarnstatic plugin blocks the fetch during install:\n", len(archive))
		for _, s := range archive {
			fmt.Fprintf(w, "  %s %s\n", s.Descriptor, s.Reference)
		}
	}
}
