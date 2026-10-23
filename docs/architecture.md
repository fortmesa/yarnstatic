# Architecture

## The problem

Let `yarn install --immutable` run with **zero network access** in CI/build
environments, by pre-populating a Yarn Berry project's `.yarn/cache` from
npm package tarballs that already live in a private S3 bucket - Verdaccio's
storage backend, via the `verdaccio-aws-s3-storage` plugin. Only direct S3
access is available in the target environment, not even a running Verdaccio
server.

## The rejected approach: hand-build `.yarn/cache` zips directly

The obvious-looking design is: read `yarn.lock`, compute the `.yarn/cache`
zip filename for each package, download the matching object from S3, done.
This doesn't work, for reasons found by reading Yarn Berry's actual source
(`yarnpkg/berry` on GitHub):

- Yarn Berry's `.yarn/cache/*.zip` files are **not** raw npm tarballs.
  Yarn re-packs each downloaded tarball into its own zip via its own
  `libzip` bindings (`packages/yarnpkg-libzip`, a WASM-compiled C library) -
  stripping the tarball's `package/` prefix, re-rooting contents under
  `node_modules/<name>`, and normalizing file permissions and timestamps
  (`tgzUtils.convertToZip`, `stripComponents: 1`, fixed `SAFE_TIME`).
- The `checksum:` field recorded in `yarn.lock` is the **full sha512 of
  that repacked zip's bytes** - not the raw tarball, not the npm registry's
  published integrity hash. Yarn recomputes and compares this full hash on
  **every normal install**, not just under an opt-in `--check-cache` flag:
  see `Cache.ts`'s `validateFile`, whose `checksumBehavior` config defaults
  to `throw`. The cache filename's 10-hex-char suffix is only there for
  filename disambiguation - the actual accept/reject decision is the full
  sha512 comparison.
- Go's `compress/flate`/`archive/zip` cannot be assumed to produce
  byte-identical output to libzip's DEFLATE implementation, even when every
  logical setting (stripComponents, path prefix, fixed timestamps,
  permissions) is replicated exactly - the compressed bitstream itself is
  implementation-specific. A hand-built Go zip placed at the correctly
  computed filename would very likely fail Yarn's checksum validation.
- Verdaccio's S3 storage (confirmed by reading `verdaccio-aws-s3-storage`
  v12.1.1's source directly) holds the **raw, untransformed npm tarballs**
  (`.tgz`, gzip+tar) exactly as published - not Yarn's zip format, and not
  even stored at paths that resemble `.yarn/cache` filenames.

A second idea - override the built-in `@yarnpkg/plugin-npm` by naming a
third-party plugin identically, exploiting the fact that
`Configuration.activatePlugin()` stores plugins in a `Map` keyed by name
(so a same-named third-party plugin's `Map.set` call overwrites the
built-in one) - was also considered and rejected. It works mechanically,
but it's an unsupported, undocumented consequence of an implementation
detail (not a real extension point), and a full override means
re-implementing plugin-npm's resolvers, configuration schema, and commands
wholesale, not just its fetcher. Any Yarn upgrade could silently break it.

## The chosen approach: intercept the byte source, let Yarn do the rest

Yarn Berry has a real, documented hook for this: `wrapNetworkRequest`
(`packages/yarnpkg-core/sources/Plugin.ts`), which wraps every HTTP request
made through Yarn core's own `httpUtils.request()`. Yarn's built-in
`NpmSemverFetcher`/`NpmHttpFetcher` construct npm tarball URLs directly from
locator data - `{registry}/{identUrl}/-/{basename}-{version}.tgz` - with
**no prior metadata/packument call needed**, and fetch them through that
same `httpUtils` path.

So a small Yarn plugin can recognize that URL pattern and, instead of
letting the (unreachable) real network request happen, fetch the matching
raw tarball bytes from S3 and resolve the hook with a synthetic
`{body, statusCode: 200, headers: {}}` response. Yarn's own tar-to-zip
conversion, checksum computation, and `.yarn/cache` writing all happen
**afterward, completely untouched** - this is what guarantees correctness:
it's Yarn's own already-self-consistent code doing that part, not a
reimplementation that has to match it byte-for-byte.

This works because Yarn's **resolution** phase, for descriptors already
pinned in an existing `yarn.lock`, reads resolutions straight from the
lockfile with no network call at all (that's the entire point of a
lockfile) - only the **fetch** phase's tarball GETs need interception. It
also means the recorded checksum will actually match: as long as the
tarball bytes Verdaccio stored in S3 are the same bytes originally fetched
when that checksum was first generated (true by construction - Verdaccio
doesn't transform tarballs, see [s3-layout.md](s3-layout.md)) and the same
Yarn/libzip build performs the conversion both times, the recomputed
checksum matches, because it's the *same code* doing the *same conversion*
on the *same bytes* - just sourced from S3 instead of HTTP.

## Scope boundaries (intentional)

- **Only fetching, not resolving.** This doesn't intercept package-metadata
  (packument) requests, so it doesn't help `yarn add <new-package>` or
  resolving not-yet-locked ranges - those need real registry access.
  `yarn install --immutable` against an existing, fully-resolved lockfile
  is the only supported scenario.
- **Strict network blocking, not best-effort passthrough.** When enabled
  (`YARNSTATIC_BUCKET` is set - see [plugin.md](plugin.md)),
  `wrapNetworkRequest` either serves a recognized tarball request from S3,
  or throws. It never falls through to the real network. An unexpected
  request (e.g. because the lockfile turned out not to be fully resolved)
  fails loudly and immediately instead of silently attempting real network
  access.
- **Only requests that flow through `httpUtils`.** The hook wraps Yarn
  core's own HTTP layer, which is what the standard npm fetch path uses.
  It does **not** catch a fetcher that shells out to an external binary.
  Yarn clones git dependencies with the system `git` binary, GitHub ones
  too once their blocked tarball download fails, and `exec:` dependencies
  run a script. If your `yarn.lock` contains only `npm:`-protocol
  dependencies (the common case), this doesn't apply; `yarnstatic check`
  warns explicitly if it finds any git or `exec:` entries, since they'd
  otherwise silently need real network access despite `YARNSTATIC_BUCKET`
  being set.

## Exec-once, socket-based fetching

Spawning a fresh `yarnstatic fetch` process per tarball - re-resolving AWS
credentials and reconstructing an S3 client every time - doesn't scale: a
real install fetches hundreds of packages, mostly in parallel. Instead, the
plugin spawns **one** long-lived `yarnstatic serve` daemon per
`yarn install` invocation (lazily, on the first intercepted request), which
builds its S3 client exactly once and services any number of fetches over
a Unix domain socket. Each fetch is still its own short-lived socket
**connection** - cheap, a local `connect()` syscall, no process spawn, no
new credential resolution - so concurrent fetches remain trivially
supported without a request-multiplexing protocol. See
[protocol.md](protocol.md) for the wire format and [plugin.md](plugin.md)
for the daemon's spawn/reuse/teardown lifecycle.

## Component map

- **`cmd/yarnstatic`** (Go) - `check` (pre-flight: verify everything
  `yarn.lock` needs exists in S3), `fetch` (one-shot manual download), and
  `serve` (the daemon the plugin actually talks to). See [cli.md](cli.md).
- **`internal/lockfile`** - parses `yarn.lock`, extracting npm-protocol
  entries, with and without a checksum, and reporting what's skipped and
  why.
- **`internal/verdaccio`** - npm identifier parsing and the
  `verdaccio-aws-s3-storage` S3 key formula. See [s3-layout.md](s3-layout.md).
- **`internal/s3client`** - a thin AWS SDK v2 wrapper (existence checks,
  streamed downloads, error classification).
- **`plugins/yarn-plugin-yarnstatic`** (JS) - the Yarn plugin described
  above. See [plugin.md](plugin.md).
- **`cli-node`** (JS) - a Node.js port of `cmd/yarnstatic`, same four
  subcommands including `serve` against the identical wire protocol (see
  [protocol.md](protocol.md)), published as `@fortmesa/yarnstatic`. Not a
  replacement for the Go binary - an alternative for Node-only
  environments, and bundles `yarn-plugin-yarnstatic-s3` for a
  daemon-free setup. See [`../cli-node/README.md`](../cli-node/README.md).
