# yarnstatic

Lets `yarn install --immutable` run with **zero network access**, by
serving npm tarballs from a private S3 bucket (a Verdaccio registry's
storage backend) instead of the real npm registry.

Three parts:
- **`yarnstatic`** (this Go module) - a CLI with four subcommands:
  `check` (verify everything a `yarn.lock` needs exists in S3), `fetch`
  (one-shot manual download), `serve` (a small daemon that a Yarn plugin
  talks to during install), and `version` (prints the release tag this
  binary was built at, for debugging which build ended up where).
- **A companion Yarn Berry plugin** (`plugins/yarn-plugin-yarnstatic`) that
  intercepts npm tarball downloads and redirects them to the `serve`
  daemon, while leaving all of Yarn's own zip-building and checksum logic
  untouched.
- **`cli-node`** - a Node.js port of the Go CLI with the same four
  subcommands, published as the npm package `@fortmesa/yarnstatic` (bin
  name `yarnstatic`), for environments that have Node but not Go. Its
  `serve` implements the exact same wire protocol as the Go daemon (see
  [`docs/protocol.md`](docs/protocol.md)), verified as a genuine drop-in
  replacement against the unmodified `yarn-plugin-yarnstatic` plugin
  client. It also bundles `yarn-plugin-yarnstatic-s3` (below) for a
  self-contained, Node-only setup with no daemon at all. See
  [`cli-node/README.md`](cli-node/README.md).

See [`docs/architecture.md`](docs/architecture.md) for the full design
rationale - in particular, why this *isn't* "just download the right zip
files into `.yarn/cache`" (that approach was tried and rejected; the
reasoning is worth reading before changing this).

## Yarn version support

Both plugins (`yarn-plugin-yarnstatic` and its dependency-free sibling
`plugins/yarn-plugin-yarnstatic-s3`, which talks to S3 directly via the AWS
SDK instead of the `serve` daemon) depend entirely on Yarn Berry's
`wrapNetworkRequest` hook, so **only Yarn 3.x and 4.x are supported**. Yarn
2.x doesn't have this hook at all - confirmed directly against yarn 2.4.3's
own bundled `yarn.js` (zero references to `wrapNetworkRequest`, vs one in
3.8.7 and two in 4.17.0). `yarn plugin import` still succeeds on 2.x with no
error in that case; it's a silent no-op, not a loud failure, so don't rely
on an error to catch a 2.x project. Yarn Classic (1.x) isn't Yarn Berry at
all and was never a candidate.

## Quick start

Prebuilt binaries are published on [GitHub releases](https://github.com/fortmesa/yarnstatic/releases)
for every `vX.Y.Z` tag. Install the latest one (and the plugin, if run
inside a project with a `.yarnrc.yml`) with:

```sh
curl -fsSL https://raw.githubusercontent.com/fortmesa/yarnstatic/main/install.sh | sh
```

This places the binary at `~/.yarn/bin/yarnstatic`, one of the locations
the Yarn plugin already searches (see
[`docs/plugin.md`](docs/plugin.md#binary-resolution)), so no `PATH` changes
are required for the plugin to find it. The script checks each download
against the release's `checksums.txt` before anything reaches its final
path, so a mismatch leaves an earlier install as it was.

Or build from source:

```sh
go build -o yarnstatic ./cmd/yarnstatic

# Verify a project's yarn.lock is fully mirrored in S3 before relying on
# an offline install. --key-prefix defaults to "verdaccio" (our production
# bucket's layout); pass --key-prefix explicitly for a bucket that uses a
# different one:
./yarnstatic check --bucket my-verdaccio-bucket /path/to/project

# Install the plugin (see plugins/yarn-plugin-yarnstatic/README.md for
# per-project vs. machine-wide install), then:
export YARNSTATIC_BUCKET=my-verdaccio-bucket
cd /path/to/project
yarn install --immutable
```

Full CLI/environment-variable reference: [`docs/cli.md`](docs/cli.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) - why this is built the
  way it is, including the rejected direct-zip-construction approach.
- [`docs/s3-layout.md`](docs/s3-layout.md) - the Verdaccio S3 key layout
  this tool relies on.
- [`docs/cli.md`](docs/cli.md) - `check`/`fetch`/`serve`/`version` usage,
  full flag and environment variable reference, exit codes.
- [`docs/protocol.md`](docs/protocol.md) - the `serve` daemon's wire
  protocol (shared source of truth for the Go server and JS client).
- [`docs/plugin.md`](docs/plugin.md) - how the Yarn plugin works
  internally: the network-blocking guarantee, binary resolution, daemon
  lifecycle.
- [`plugins/yarn-plugin-yarnstatic/README.md`](plugins/yarn-plugin-yarnstatic/README.md) -
  consumer-facing install/wiring instructions for the plugin.
- [`cli-node/README.md`](cli-node/README.md) - the Node.js CLI port
  (`@fortmesa/yarnstatic`): install, usage, and its bundled
  `yarn-plugin-yarnstatic-s3` wiring step.
- [`BENCHMARKS.md`](BENCHMARKS.md) - install-time comparison across both
  plugins (daemon and direct-S3), the daemon's AWS CLI fallback path, and
  plain `yarn`/`npm install` against the real registry.

## Development

```sh
go build ./...
go vet ./...
go test ./...
```

`scripts/e2e-test.sh` runs a real `yarn install --immutable` through the
plugin and daemon against a real S3 bucket (see the script's header for
what it checks and why it's a separate opt-in step rather than part of
`go test ./...`, which must not depend on real AWS credentials):

```sh
YARNSTATIC_BUCKET=my-verdaccio-bucket AWS_PROFILE=my-profile ./scripts/e2e-test.sh
```

`scripts/benchmark.sh` compares install wall-clock time across both
plugins, the daemon's AWS CLI fallback, and plain `yarn`/`npm install` -
see [`BENCHMARKS.md`](BENCHMARKS.md) for a written-up run and
`scripts/benchmark.sh`'s own header for the full set of options. Also a
real-infra script, not part of `go test ./...`:

```sh
YARNSTATIC_BUCKET=my-verdaccio-bucket AWS_PROFILE=my-profile ./scripts/benchmark.sh
```

