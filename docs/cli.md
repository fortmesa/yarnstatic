# CLI reference

## Configuration: flags and environment variables

Every *connection* setting is an environment variable first; each
command's flags are just explicit overrides of the same values. This is
what lets the manually-run `check` command and the plugin-invoked `serve`
daemon share one identical configuration contract without the plugin
needing to translate or forward anything (see [plugin.md](plugin.md)). The
one exception is `yarnstaticScopeStorage`, which lives in `.yarnrc.yml`
instead - see `check`'s entry below and [plugin.md](plugin.md)'s "Scope
storage overrides" section.

| Env var | Flag | Required? | Fallback if unset |
|---|---|---|---|
| `YARNSTATIC_BUCKET` | `--bucket` | **Yes** - from flag or env, either satisfies it | none - hard error |
| `YARNSTATIC_KEY_PREFIX` | `--key-prefix` | No | `"verdaccio"` (matches our production bucket's layout; pass `--key-prefix` explicitly if yours differs - see note below) |
| `YARNSTATIC_REGION` | `--region` | No | AWS SDK default resolution |
| `YARNSTATIC_ENDPOINT` | `--endpoint` | No | real AWS S3 (only needed for non-AWS S3-compatible backends, e.g. MinIO) |
| `YARNSTATIC_PROFILE` | `--profile` | No | AWS SDK default credential chain |
| `YARNSTATIC_BIN` | n/a (plugin-only) | No | plugin searches several conventional locations, then falls back to `yarnstatic` on `PATH` - see [plugin.md](plugin.md) |

If `--endpoint` is set, path-style addressing is used automatically
(`UsePathStyle = true`) - virtual-hosted-style addressing generally doesn't
work against non-AWS S3-compatible endpoints.

Note on `--key-prefix`: an empty flag value and "flag not passed at all"
are indistinguishable (same for `YARNSTATIC_KEY_PREFIX=""` vs. unset), so
there's currently no way to explicitly request *no* prefix once a non-empty
default exists - pass any other prefix to override, or ask if a bucket
with no prefix at all needs to be supported.

## `yarnstatic check [flags] [path]`

Flags must precede the positional `path` argument (Go's `flag` package
stops parsing at the first non-flag token). `path` defaults to `.`.

Parses `<path>/yarn.lock`, filters to `npm:`-protocol entries with a
`checksum` field, and concurrently `HeadObject`-checks each one's S3 key.
Prints a full report - every missing/errored object, not just the first -
and exits accordingly.

Entries with a non-`npm` resolution protocol (`workspace:`, `portal:`,
`link:`, `patch:`, `file:`, ...) or missing a checksum are skipped and
summarized by protocol. `git:`/`github:`/`exec:` entries get an additional,
louder warning: they bypass the plugin's network-blocking guarantee
entirely (see [architecture.md](architecture.md)), so their presence means
"fully offline" isn't actually guaranteed even if this check otherwise
passes.

```
$ yarnstatic check --bucket my-verdaccio-bucket .
yarn.lock: 52 npm package(s) with checksums (skipped: 1 link:, 2 patch:, 1 portal:, 3 workspace:)
Checking s3://my-verdaccio-bucket/verdaccio ...

MISSING (2):
  left-pad@npm:1.3.0            s3://my-verdaccio-bucket/verdaccio/left-pad/left-pad-1.3.0.tgz
  @acme/widgets@npm:2.1.0       s3://my-verdaccio-bucket/verdaccio/@acme/widgets/widgets-2.1.0.tgz

Summary: 50 present, 2 missing, 0 error (out of 52 checked)
```

(`verdaccio` here is the default `--key-prefix` - pass a different value with `--key-prefix` if your bucket doesn't use that layout.)

If `<path>/.yarnrc.yml` exists and has a `yarnstaticScopeStorage` map (the
same setting the Yarn plugin registers - see [plugin.md](plugin.md) and
[s3-layout.md](s3-layout.md)), `check` uses it to compute the correct S3
key for scopes with a Verdaccio `packages[...].storage` override. A
missing file, or a file without that key, is not an error - it just means
no scope needs the override, which is the common case. There's no flag or
env var for this; `.yarnrc.yml` is the only source, so it can't drift out
of sync with what the plugin itself reads.

Each errored entry is also tagged with its error kind (see below), and the
`ERRORS` section's summary line breaks the count down by kind, so a script
doesn't have to parse individual error messages to tell "we couldn't even
log in" apart from "these specific objects are missing."

| Exit code | Meaning |
|---|---|
| 0 | every entry present |
| 1 | one or more entries confirmed missing from the bucket, nothing worse |
| 2 | bad flags, too many arguments, no `yarn.lock` found, or unparseable `.yarnrc.yml` |
| 3 | invalid S3 configuration - missing `--bucket`/`YARNSTATIC_BUCKET`, or `s3client.New`/a request failed for a locally-detectable reason (bad region, malformed `--endpoint`, a `--profile` that doesn't exist) |
| 4 | no AWS credentials could be resolved at all on one or more entries |
| 5 | one or more entries were denied on auth/permission grounds (and none hit 3 or 4) |
| 6 | some other S3 error on one or more entries (throttling, a transient server error, an archived object needing a restore, ...) |

When a run's errors span more than one kind, the exit code reflects the
single most fundamental problem present, in the order listed above (3 > 4 >
5 > 6 > 1) - e.g. if some entries are confirmed missing and others hit
access denied, the run exits 5, not 1, since "some objects are outright
denied" is a bigger problem than "some objects are missing," and the full
per-kind breakdown is still in the printed report either way.

**Important caveat**: AWS's own `HeadObject`/`GetObject` documentation
states that if the calling role doesn't also have `s3:ListBucket` on the
bucket, a request for a **missing** key returns `403 Forbidden` instead of
`404 Not Found` - S3 won't confirm or deny an object's existence to a
caller that can't list the bucket. With a `check`-only role scoped to just
`s3:GetObject` (the common minimal case), every genuinely-missing entry
will therefore show up as exit code 5 ("access denied"), not 1 - not
because anything is actually broken, but because that's the only signal
S3 will give back. Grant `s3:ListBucket` on the bucket too if you want
`check`'s missing-vs-denied distinction (and its exit code) to be
meaningful; without it, exit code 5 is ambiguous between "genuinely no
permission" and "these are just missing."

## `yarnstatic fetch [flags] --package <name>@<version>`

A one-shot helper for manual/debug use - not what the plugin uses at
install time (that's `serve`, below). Downloads a single package's tarball
and writes it to stdout (default) or `--out <file>`.

```
$ yarnstatic fetch --bucket my-verdaccio-bucket --package lodash@4.17.21 > lodash-4.17.21.tgz
$ yarnstatic fetch --bucket my-verdaccio-bucket --package "@babel/core@7.20.0" --out core.tgz
```

Stdout carries **only** raw tarball bytes on success - all human-facing
text goes to stderr, so `fetch ... > file.tgz` is always safe.

| Exit code | Meaning |
|---|---|
| 0 | tarball written successfully |
| 1 | not found (see `check`'s own note above on this being ambiguous with access denied if the role lacks `s3:ListBucket`) |
| 2 | bad flags, bad `--package`, or a local (non-S3) failure writing `--out` |
| 3 | invalid S3 configuration - missing `--bucket`/`YARNSTATIC_BUCKET`, or the same locally-detectable `s3client.New`/request failures described under `check` |
| 4 | no AWS credentials could be resolved at all |
| 5 | access denied |
| 6 | some other S3 error (throttling, a transient server error, an archived object needing a restore, ...) |

## `yarnstatic serve --socket <path> [flags] [--max-concurrency N]`

The daemon the Yarn plugin actually talks to (see
[protocol.md](protocol.md) for the wire format and [plugin.md](plugin.md)
for how the plugin spawns and manages it). Not meant to be invoked
directly, though running it manually is useful for debugging - see the
verification steps below.

Builds one S3 client at startup, listens on the given Unix socket, and
services requests until `SIGINT`/`SIGTERM` (graceful: stop accepting, drain
in-flight connections within a bounded grace period, remove the socket
file, exit) or an idle timeout with no new connections (5 minutes,
hardcoded) - the latter is a safety net in case whatever spawned it is
killed ungracefully and never sends a signal.

`--max-concurrency` (default 32) bounds how many downloads run at once,
independent of how many connections are accepted.

| Exit code | Meaning |
|---|---|
| 0 | clean shutdown on `SIGINT`/`SIGTERM`/idle timeout |
| 2 | bad flags, `--socket` missing, or failure to bind the socket |
| 3 | invalid S3 configuration at startup - missing `--bucket`/`YARNSTATIC_BUCKET`, or `s3client.New` failed (bad region, malformed `--endpoint`, a `--profile` that doesn't exist) |

Per-request errors are never a process exit code - they go back to the
client as `{"ok": false, "message": "..."}` over the socket (see
[protocol.md](protocol.md)). A single bad request never crashes the daemon
or affects other in-flight connections. The message text does distinguish
not-found/access-denied/no-credentials/invalid-configuration (the same
classification `check`/`fetch` use for their exit codes), purely so
whatever's reading the message - typically a developer staring at a failed
`yarn install` - has something more actionable than "download failed."

## `yarnstatic version`

Prints the version this binary was built at and exits 0 - nothing else,
no flags. A binary built via a plain `go build`/`go test`/`go run`
(local development, or the `test` job's own `go vet`/`go test`, which
never runs the release build step at all) reports `dev`, since there's no
real release tag to embed at that point.

A release binary gets its version baked in at build time
(`-ldflags "-X main.version=..."` in `.github/workflows/release.yml`'s
`build` job), set to the exact git tag (`github.ref_name`) that release is
published under - the same value `softprops/action-gh-release` uses for
the release itself, so a binary's own `yarnstatic version` output and the
GitHub Release it was downloaded from can never disagree. Useful for
confirming exactly which build ended up on a given machine/CI runner,
independent of whatever URL or script fetched it.

## Manual verification (no AWS access needed for the plumbing)

You can sanity-check `serve`'s socket handling without real S3 credentials
by pointing `--endpoint` at an address nothing is listening on - every
request will fail, but you can confirm the daemon starts, accepts
connections, frames responses correctly, and shuts down cleanly:

```sh
yarnstatic serve --bucket test --endpoint http://127.0.0.1:1 --socket /tmp/test.sock &
printf '{"package": "lodash@4.17.21", "ver": "1.0"}\n' | nc -U /tmp/test.sock
# expect two lines: the greeting ({"ok":true,"ver":"1.0","ready":true} -
# see protocol.md), then the fetch response ({"ok":false,...})
kill -TERM %1   # expect a clean shutdown, socket file removed
```

Full verification against a real bucket (required before relying on this
for an actual offline install) is `scripts/e2e-test.sh` - see the
top-level [README.md](../README.md)'s Development section.
