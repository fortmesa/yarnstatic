# yarnstatic

Lets `yarn install --immutable` run with **zero network access**, by
serving npm tarballs from a private S3 bucket (a Verdaccio registry's
storage backend) instead of the real npm registry.

Two parts:
- **`yarnstatic`** (this Go module) - a CLI with three subcommands:
  `check` (verify everything a `yarn.lock` needs exists in S3), `fetch`
  (one-shot manual download), and `serve` (a small daemon that a Yarn
  plugin talks to during install).
- **A companion Yarn Berry plugin** (`plugins/yarn-plugin-yarnstatic`) that
  intercepts npm tarball downloads and redirects them to the `serve`
  daemon, while leaving all of Yarn's own zip-building and checksum logic
  untouched.

See [`docs/architecture.md`](docs/architecture.md) for the full design
rationale - in particular, why this *isn't* "just download the right zip
files into `.yarn/cache`" (that approach was tried and rejected; the
reasoning is worth reading before changing this).

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
are required for the plugin to find it.

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
- [`docs/cli.md`](docs/cli.md) - `check`/`fetch`/`serve` usage, full flag
  and environment variable reference, exit codes.
- [`docs/protocol.md`](docs/protocol.md) - the `serve` daemon's wire
  protocol (shared source of truth for the Go server and JS client).
- [`docs/plugin.md`](docs/plugin.md) - how the Yarn plugin works
  internally: the network-blocking guarantee, binary resolution, daemon
  lifecycle.
- [`plugins/yarn-plugin-yarnstatic/README.md`](plugins/yarn-plugin-yarnstatic/README.md) -
  consumer-facing install/wiring instructions for the plugin.

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

