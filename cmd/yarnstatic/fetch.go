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
		return exitUsage
	}
	if fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "yarnstatic fetch: unexpected arguments")
		return exitUsage
	}
	if pkg == "" {
		fmt.Fprintln(os.Stderr, "yarnstatic fetch: --package is required")
		return exitUsage
	}

	spec, err := verdaccio.ParsePackageSpec(pkg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
		return exitUsage
	}

	// requireBucket (inside resolve) is the "missing bucket name" case the
	// exitConfiguration code exists for - see config.go.
	bucket, keyPrefix, s3opts, err := common.resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
		return exitConfiguration
	}

	ctx := context.Background()
	client, err := s3client.New(ctx, bucket, s3opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yarnstatic fetch: failed to initialize S3 client: %v\n", err)
		return exitConfiguration
	}

	var f *os.File
	dest := "stdout"
	w := &localWriter{w: os.Stdout}
	if out != "" {
		f, err = os.Create(out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: %v\n", err)
			return exitUsage
		}
		dest = out
		w.w = f
	}

	// fetch is a standalone manual/debug tool with no project directory to
	// read a .yarnrc.yml from (unlike check/serve), so it doesn't support
	// per-scope storage-folder overrides - see docs/s3-layout.md.
	key, err := downloadPackage(ctx, client, keyPrefix, spec, "", w)
	if err == nil && f != nil {
		// Some filesystems (NFS, quota-limited ones) only report a failed
		// write when the file is closed.
		if cerr := f.Close(); cerr != nil {
			w.err = cerr
			err = cerr
		}
	} else if f != nil {
		_ = f.Close()
	}
	if err != nil {
		if out != "" {
			_ = os.Remove(out)
		}
		if w.err != nil {
			// A local write failure, not an S3 one - see docs/cli.md's fetch
			// exit codes.
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: writing %s: %v\n", dest, w.err)
			return exitUsage
		}
		kind := s3client.Classify(err)
		switch kind {
		case s3client.KindNotFound:
			// Note: without s3:ListBucket permission this might actually
			// come back as KindAccessDenied instead - see
			// s3client.Classify's doc comment.
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: not found: s3://%s/%s (package %s)\n", bucket, key, spec)
		case s3client.KindAccessDenied:
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: access denied: s3://%s/%s\n", bucket, key)
		case s3client.KindNoCredentials:
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: no credentials available to sign the request: %v\n", err)
		case s3client.KindConfiguration:
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: invalid configuration: %v\n", err)
		default:
			fmt.Fprintf(os.Stderr, "yarnstatic fetch: failed to download s3://%s/%s: %v\n", bucket, key, err)
		}
		return exitCodeForKind(kind)
	}

	return exitOK
}

// localWriter records a failure writing the output, so runFetch can tell it
// apart from an S3 failure once the download returns its error.
type localWriter struct {
	w   io.Writer
	err error
}

func (l *localWriter) Write(p []byte) (int, error) {
	n, err := l.w.Write(p)
	if err != nil && l.err == nil {
		l.err = err
	}
	return n, err
}
