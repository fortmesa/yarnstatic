// Command yarnstatic populates a Yarn Berry project's .yarn/cache from
// tarballs stored in a Verdaccio S3 bucket, so `yarn install --immutable`
// can run fully offline. See docs/architecture.md for the full design.
package main

import (
	"fmt"
	"io"
	"os"
)

// version is set at release build time via -ldflags "-X main.version=...",
// to the same git tag (github.ref_name) the release itself is published
// under -- see .github/workflows/release.yml. Left at "dev" for a plain
// `go build`/`go test`/`go run` (local development, CI's own `go vet`/
// `go test` in the test job), so `yarnstatic version` never silently
// reports an empty string when it isn't actually a released build.
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) < 1 {
		printUsage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "check":
		return runCheck(args[1:])
	case "fetch":
		return runFetch(args[1:])
	case "serve":
		return runServe(args[1:])
	case "version":
		fmt.Println(version)
		return 0
	case "-h", "--help", "help":
		printUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "yarnstatic: unknown command %q\n\n", args[0])
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `yarnstatic - populate a Yarn Berry .yarn/cache from a Verdaccio S3 bucket

Usage:
  yarnstatic check [flags] [path]
  yarnstatic fetch [flags] --package <name>@<version>
  yarnstatic serve [flags] --socket <path>
  yarnstatic version

Run "yarnstatic <command> -h" for command-specific flags. See docs/cli.md
for the full reference.
`)
}
