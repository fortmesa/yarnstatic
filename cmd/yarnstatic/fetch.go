package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"

	"yarnstatic/internal/s3client"
	"yarnstatic/internal/verdaccio"
)

func runFetch(args []string) int {
	fs := flag.NewFlagSet("fetch", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	var pkg, out string
	fs.StringVar(&pkg, "package", "", `package to fetch, e.g. "lodash@4.17.21" or "@scope/name@1.0.0" (required)`)
	fs.StringVar(&out, "out", "", "write the tarball to this file instead of stdout")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `Usage: yarnstatic fetch [flags] --package <name>@<version>

A one-shot helper for manual/debug use: downloads a single package's
tarball from S3 and writes it to stdout (default) or --out. This is not
what the Yarn plugin uses at install time - see "yarnstatic serve".

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "yarnstatic fetch: unexpected arguments")
		return 2
	}
	if pkg == "" {
		fmt.Fprintln(os.Stderr, "yarnstatic fetch: --package is required")
		return 2
	}

	spec, err := verdaccio.ParsePackageSpec(pkg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
		return 2
	}

	bucket, keyPrefix, s3opts, err := common.resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
		return 2
	}

	ctx := context.Background()
	client, err := s3client.New(ctx, bucket, s3opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: failed to initialize S3 client: %v\n", err)
		return 2
	}

	var w io.Writer = os.Stdout
	if out != "" {
		f, err := os.Create(out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
			return 2
		}
		defer f.Close()
		w = f
	}

	// fetch is a standalone manual/debug tool with no project directory to
	// read a .yarnrc.yml from (unlike check/serve), so it doesn't support
	// per-scope storage-folder overrides - see docs/s3-layout.md.
	key, err := downloadPackage(ctx, client, keyPrefix, spec, "", w)
	if err != nil {
		if out != "" {
			_ = os.Remove(out)
		}
		switch {
		case s3client.IsNotFound(err):
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: not found: s3://%s/%s (package %s)\n", bucket, key, spec)
		case s3client.IsAccessDenied(err):
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: access denied: s3://%s/%s\n", bucket, key)
		default:
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: failed to download s3://%s/%s: %v\n", bucket, key, err)
		}
		return 1
	}

	return 0
}
