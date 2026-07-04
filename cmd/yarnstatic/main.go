// Command yarnstatic populates a Yarn Berry project's .yarn/cache from
// tarballs stored in a Verdaccio S3 bucket, so `yarn install --immutable`
// can run fully offline. See docs/architecture.md for the full design.
package main

import (
	"fmt"
	"io"
	"os"
)

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

Run "yarnstatic <command> -h" for command-specific flags. See docs/cli.md
for the full reference.
`)
}
