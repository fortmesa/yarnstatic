# The Yarn plugin

`plugins/yarn-plugin-yarnstatic/sources/index.js` is a single, dependency-free
CommonJS file (Yarn plugins can only run as JS - see
[architecture.md](architecture.md) for why the actual S3/AWS logic still
lives in Go, reached via a subprocess). For install/wiring instructions see
[the plugin's own README](../plugins/yarn-plugin-yarnstatic/README.md);
this document explains how it's built and why.

`yarn build` bundles it into `bundles/@yarnpkg/plugin-yarnstatic.js` with
`@yarnpkg/builder`, and releases ship that bundle as
`plugin-yarnstatic.cjs`. Import the bundle. `yarn plugin import` reads a
plugin's name by running it in a sandbox with no `require`, so the
top-level `require` calls in `sources/index.js` make the raw source fail
to import.

## Enablement: environment variable presence, not `.yarnrc.yml` config

The plugin's `wrapNetworkRequest` hook checks `process.env.YARNSTATIC_BUCKET`
first. If it's unset or empty, the hook returns the real `executor`
unchanged - a complete no-op, real network calls proceed exactly as they
would without this plugin installed. If it's set, strict mode activates for
every request for the rest of that `yarn` invocation.

Every *connection* setting yarnstatic needs (bucket, prefix, region,
endpoint, profile) is an environment variable (see [cli.md](cli.md)'s
table), shared identically by the Go CLI and the plugin - no `.yarnrc.yml`
schema is needed for any of that, which is also what makes the plugin safe
to install globally (see the README) without accidentally affecting
projects/builds that don't opt in. The one exception is
`yarnstaticScopeStorage` (below), which isn't a connection setting - it's
project-specific data about how a particular scope's packages are laid out
in *this* Verdaccio, so it lives in `.yarnrc.yml` rather than the
environment.

## Strict network blocking, not passthrough-by-default

When enabled, `wrapNetworkRequest`:

1. Checks `extra.target` against the tarball URL pattern
   (`parseTarballUrl` in the plugin source - see
   [protocol.md](protocol.md)'s neighbor, the URL-side parsing logic lives
   here since it's Yarn-specific, not part of the S3 wire protocol). On a
   match, it fetches the package via the daemon (below) and resolves
   `{body, statusCode: 200, headers: {}}`. The registry URL may carry a
   path of its own, as Artifactory, Nexus and a path-mounted Verdaccio
   do. The package name comes from the one or two path segments right
   before the last `/-/`, so a registry path whose last segment starts
   with `@` would read as a scope.
2. On **no match**, it throws immediately rather than falling through to
   the real executor.

That second point is what makes this a hard guarantee instead of a
best-effort one: an unexpected request (e.g. because the lockfile turned
out not to be fully resolved) fails loudly right away, instead of silently
attempting real network access that might succeed on a dev machine but
fail - or worse, silently defeat the purpose of the guarantee - in the
actually-offline environment this is meant for.

**Caveat**: `wrapNetworkRequest` only wraps requests that flow through
Yarn core's own `httpUtils.request()`. Git dependencies get past it. For a
GitHub repository, Yarn's GitHub plugin first tries a tarball download
through `httpUtils`, which this plugin blocks, but it catches that error
and gives up quietly, and Yarn then runs `git clone` itself. Other git
hosts go straight to `git clone`, and `exec:` dependencies run a script.
`yarnstatic check` warns explicitly if any of these are found in a
project's `yarn.lock` (see [cli.md](cli.md)), since their presence means
this guarantee has a gap for that project.

## Scope storage overrides (`yarnstaticScopeStorage`)

Verdaccio's `packages['@scope/*'].storage` option inserts an extra folder
segment into a scope's S3 key layout (see [s3-layout.md](s3-layout.md)),
and there's no way to derive that from the package spec alone - it's
admin-configured data that only exists in Verdaccio's own config.

The plugin registers a matching `.yarnrc.yml` setting, `yarnstaticScopeStorage`
(a `SettingsType.MAP` - the same mechanism Yarn's own `npmScopes` setting
uses, confirmed against `@yarnpkg/core`'s `Configuration.js`: an
unregistered top-level key would otherwise throw `"Unrecognized...
configuration settings found"`):

```yaml
yarnstaticScopeStorage:
  myscope: myscope-storage-folder
```

Keyed by scope *without* the leading `@` (matching `verdaccio.PackageSpec.Scope`
and the protocol field below). In `wrapNetworkRequest`, once a request's
target resolves to a package spec, the plugin looks up that package's scope
in this map and - only if present - includes it as `storageFolder` in the
request sent to the daemon (see [protocol.md](protocol.md)). There's no Go
CLI flag or `YARNSTATIC_*` env var for this. `.yarnrc.yml` is the only
place it lives, and `yarnstatic check` reads it from the same files Yarn
loads and merges them the same way, so the plugin and `check` compute the
same keys (see [cli.md](cli.md)). `yarnstatic fetch` doesn't support it -
it has no project directory to read a `.yarnrc.yml` from at all, being a
standalone single-package debug tool.

`yarn-plugin-yarnstatic-s3` registers `yarnstaticScopeStorage` as well,
and Yarn refuses to load two plugins that register the same setting.
With both loaded, every `yarn` command fails at startup with `Cannot
redefine settings "yarnstaticScopeStorage"`, and that includes this plugin
in `~/.yarnrc.yml` with the S3 plugin in a project's `.yarnrc.yml`. Use
one plugin or the other.

Deliberately *not* passed to `yarnstatic serve` at spawn time (as an env
var or flag): whether a package needs this override is resolved by the
plugin, per request, from whichever project's `.yarnrc.yml` is asking - the
daemon itself holds no scope-to-storage state and never needs to know which
project a connection came from, which is what keeps it correct even if a
single `serve` process were ever asked to handle requests from more than
one consumer at once (see [protocol.md](protocol.md)'s "why this shape").

## Binary resolution

`resolveBinary()` checks, in order:

1. `YARNSTATIC_BIN` env var - explicit override, always wins.
2. `<projectRoot>/node_modules/.bin/yarnstatic`, but only when it
   resolves into `node_modules/@fortmesa/yarnstatic`. Any dependency can
   declare a `yarnstatic` bin, and the plugin would run it with the
   install's AWS environment even under `enableScripts: false`, so a bin
   from any other package is skipped.
3. `$GOBIN/yarnstatic`, else `$GOPATH/bin/yarnstatic`, else
   `~/go/bin/yarnstatic` - the standard `go install` output location,
   which often isn't on `PATH` on a fresh machine.
4. `~/.yarn/bin/yarnstatic` - Yarn's own per-user bin directory (the same
   one classic Yarn 1.x's `yarn global add` installs into), reused here
   instead of inventing a new directory, since it's often already on
   `PATH` on machines that have used Yarn before.
5. `~/.local/bin/yarnstatic` - the XDG-ish per-user binary directory on
   Linux, often already on `PATH` by default on modern distros.
6. Bare `"yarnstatic"`, resolved via `PATH` by `child_process.spawn` itself
   - covers Homebrew, system package managers, or a binary baked into a CI
   image's `/usr/local/bin`.

`projectRoot` is taken from `extra.configuration.projectCwd` when
available, falling back to `process.cwd()`.

Candidate 2 (`node_modules/.bin/yarnstatic`) is no longer just a harmless
check against an empty path: `cli-node/` is a Node.js port of the Go CLI,
published as the npm package `@fortmesa/yarnstatic` (bin name `yarnstatic`
- see [`../cli-node/README.md`](../cli-node/README.md)), and it implements
`serve` against the exact same wire protocol documented in
[protocol.md](protocol.md). A project with `@fortmesa/yarnstatic` installed
as a devDependency gets this binary at exactly that path, and
`resolveBinary()` will find and spawn it - a genuine, verified drop-in
replacement for the Go daemon from this plugin's point of view, not just a
theoretical possibility. `cli-node/` deliberately bundles only
`yarn-plugin-yarnstatic-s3` (see its own README), not this plugin - a
project that wants this plugin's daemon path with the Node binary needs
`yarn-plugin-yarnstatic` from this repo directly (or `YARNSTATIC_BIN`
pointed explicitly at the Node binary).

No Windows-specific paths are checked. This is CI/CD-only tooling (not
something installed on developer desktops), and Windows CI runners are not
a target - the `serve` daemon's Unix domain socket design is Unix-only by
design, not an interim gap.

## Daemon lifecycle - spawned once, reused, torn down deterministically

The plugin module is loaded exactly once per `yarn` process (Node's
`require` cache), so module-level state naturally persists across every
`wrapNetworkRequest` call within one `yarn install` run. This is the
mechanism the whole lifecycle rests on:

- **Exactly one spawn, even under concurrent requests.** A module-level
  `let daemonPromise = null`. `ensureDaemon()`'s first statement,
  synchronously, is the check-and-set: `if (!daemonPromise) daemonPromise =
  startDaemon(...)`. Because JS is single-threaded, there's no window for
  two concurrent `wrapNetworkRequest` calls (Yarn fetches many tarballs in
  parallel) to both observe `daemonPromise === null` - the first caller
  sets it before yielding control, so every other concurrent caller just
  awaits the same in-flight promise.
- **Socket path continuity.** `startDaemon()` creates a private directory
  once, `fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-'))`, which is
  mode 0700 under a random name, and puts the socket at `daemon.sock`
  inside it. No other user can create that path first or connect to the
  socket. It resolves `daemonPromise` to `{socketPath, child}`. Every later
  call destructures the same object - the path isn't rediscovered
  per-request, it's held in memory for the process's lifetime.
- **Startup.** `startDaemon()` spawns `yarnstatic serve --socket
  <socketPath>` (bucket/prefix/region/etc. need no explicit passing - the
  daemon inherits and reads the same `YARNSTATIC_*` env vars itself), then
  poll-connects to the socket (50ms interval, 10s overall timeout) until a
  connection succeeds, the child exits early (its captured stderr becomes
  the startup error), or the timeout elapses. A successful `connect()`
  isn't enough on its own to call the daemon ready: the probe then waits
  for and validates the greeting line (`checkGreeting()` - see
  [protocol.md](protocol.md)), rejecting only a structurally broken
  greeting - a version *difference* alone isn't a failure here, since
  `checkGreeting()` negotiates rather than requiring an exact match (see
  protocol.md's "Why this shape"). The probe doesn't send a request, so
  it doesn't need the negotiated version `checkGreeting()` returns - each
  real fetch (`fetchFromDaemon`) negotiates its own on its own
  connection. The 10s deadline covers the whole wait, reading the greeting
  included, so a listener that accepts and never answers fails the start
  instead of hanging the install. A connection that closes before a full
  greeting line counts as not ready yet and is retried.
- **`child.unref()` / `child.stderr.unref()`, called right after spawn.**
  Without these, the running daemon - and its still-open `stderr` pipe -
  keeps this process's event loop non-empty indefinitely, since Node
  counts a live child process (and any piped stdio attached to it) as a
  reason to keep running. That means the process never reaches the point
  of naturally exiting, so the `process.on('exit')` handler below (which
  is what actually stops the daemon) would never fire - `yarn install`
  would print its final "Done" line and then hang forever instead of
  returning control to the shell. `unref()` tells Node not to count these
  handles when deciding whether the event loop is empty, so the process
  exits as soon as Yarn's own work is done, triggering the `exit` handler
  and killing the daemon.
- **Shutdown, scoped to one `yarn install` run.** Right after spawning, the
  plugin registers `process.on('exit', () => { try { child.kill() } catch
  {} })`. Node's `exit` event fires synchronously just before the process
  terminates, for both normal completion and errors - that's what tells
  the daemon to stop. It receives `SIGTERM` and runs its own
  graceful-shutdown path (see [cli.md](cli.md)'s `serve` section). The same
  handler then removes the socket directory. This
  deliberately scopes one daemon to one `yarn install` invocation, not a
  persistent multi-consumer service - that would need its own coordination
  (well-known socket path, "is one already running" races, config drift)
  that isn't needed here.
- **Safety net for ungraceful termination.** A plain (non-`detached`)
  child process does not automatically die just because its parent did -
  `process.on('exit')` only fires for the parent's own normal/erroring
  shutdown path, not a `kill -9`/OOM-kill, which would skip it entirely and
  leak the daemon. `yarnstatic serve`'s own idle-timeout (5 minutes,
  hardcoded - see [cli.md](cli.md)) is the defense-in-depth for that case,
  not this plugin's responsibility. The daemon removes its socket file
  when it exits, but the empty `yarnstatic-*` directory stays in the temp
  directory after a hard kill.

## Verification notes

`scripts/e2e-test.sh` exercises the full plugin live: `wrapNetworkRequest`'s
real hook shape (`extra.target`, the resolved `{body, statusCode,
headers}`), `parseTarballUrl`, `resolveBinary`, the daemon-singleton
lifecycle (including the `unref()`/exit-handler shutdown path), and
`fetchFromDaemon`'s full greeting-then-request-then-response exchange. It
runs a real Yarn Berry 4.17.0 project with the built plugin bundle and a
real `yarnstatic serve` daemon against the real `your-s3-bucket` S3
bucket, with the global cache disabled and `.yarn/cache` cleared each run
to force a genuine fetch. That covers the JSON protocol, the
greeting/version negotiation handshake, and the no-`storageFolder` path
end-to-end. `parseTarballUrl` also has its own isolated checks in
`test/smoke.js`, covering scoped, unscoped and hyphenated package names
and registries with a path.

**What's genuinely still open**:
1. `yarnstaticScopeStorage` / `storageFolder` has only been exercised with
   *no* override present (the common case). A scope with an actual
   Verdaccio `packages[...].storage` option turned on hasn't been tested
   against a real Verdaccio instance - only `TarballKey`'s key computation
   is unit-tested for that case (`internal/verdaccio/key_test.go`).
2. The version-negotiation rejection path (`minSupportedProtocolVersion`
   - see [protocol.md](protocol.md)) has no real incompatibility to
   trigger yet, since both sides have only ever spoken `"1.0"` - it can't
   be exercised end-to-end until a second protocol version actually
   exists.
3. Only tested against Yarn Berry 4.17.0. This plugin only uses the
   documented, stable `wrapNetworkRequest` hook (not internal APIs), so it
   should be broadly compatible, but a fleet running a wide range of Yarn
   versions should still spot-check per [the plugin
   README](../plugins/yarn-plugin-yarnstatic/README.md)'s caveat.
