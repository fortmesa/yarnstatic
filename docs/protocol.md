# Daemon wire protocol

`yarnstatic serve` and the Yarn plugin's socket client
(`plugins/yarn-plugin-yarnstatic/sources/index.js`) both implement this
protocol - this document is the source of truth for both sides. It's
deliberately minimal: one request per connection, no multiplexing or
framing library needed, since opening a new Unix socket connection is cheap
(a local `connect()` syscall) and concurrent fetches just use concurrent
connections.

There are now two server implementations of this exact protocol: the Go
`cmd/yarnstatic serve` command, and `cli-node`'s `commands/serve.js` (the
Node.js port, published as `@fortmesa/yarnstatic` - see
[`../cli-node/README.md`](../cli-node/README.md)). Both were verified
against the plugin's own client code unmodified - a change to this
protocol needs to stay compatible with (or update) both server
implementations, not just the Go one.

## Transport

A Unix domain socket. The path is chosen by whoever spawns `yarnstatic
serve --socket <path>`. The plugin creates a private 0700 directory per
`yarn` process and puts the socket in it (see [plugin.md](plugin.md)).

**Permissions**: both `serve` implementations create the socket file under
umask 0077 and then `chmod` it to `0600`, regardless of the process umask.
The umask covers the moment between bind and chmod. Without
this, a permissive umask (0 or 002, common in root-run containers/some CI
images) would leave the socket group/world-writable - the daemon has no
per-caller/per-project scoping by design (see "Why this shape" below), so
any other local process able to connect could request any `package@version`
(and arbitrary `storageFolder`) this daemon's own AWS credentials can reach.
0600 restricts connections to the same OS user that started the daemon.

## Greeting

Before anything else, on **every** accepted connection - including the
plugin's readiness probe at daemon startup, not just fetch requests - the
server writes one line unprompted, before reading anything from the
client:

```json
{"ok": true, "ver": "1.0", "ready": true}
```

`ver` is `cmd/yarnstatic/serve.go`'s `protocolVersion` - the highest
protocol version this server speaks. The client checks `ok`/`ready` are
both `true` (a malformed or not-ready greeting is a hard failure - see
"Why this shape" below), then negotiates the version to use for its own
request: whichever is lower, the version it knows how to send or the
version the server just declared (`checkGreeting()` in the plugin
source). A version *difference* alone is never a handshake failure -
only a request that's actually incompatible gets rejected, and that
happens later, as a normal fetch error (see Response, below). The
readiness probe in [plugin.md](plugin.md)'s daemon lifecycle section *is*
this greeting: the plugin no longer treats a bare successful `connect()`
as "ready" - it waits for this line.

## Request

After receiving and validating the greeting, the client writes exactly
one line: a JSON object, followed by `\n`.

```json
{"package": "lodash@4.17.21", "ver": "1.0"}
```
```json
{"package": "@babel/core@7.20.0", "storageFolder": "myscope", "ver": "1.0"}
```

Fields:
- `package` (required) - `name@version` or `@scope/name@version`, parsed
  with the same `verdaccio.ParsePackageSpec` used by `yarnstatic
  fetch`/`check` (`internal/verdaccio/key.go`).
- `storageFolder` (optional) - reproduces a Verdaccio
  `packages['@scope/*'].storage` override for this package's scope (see
  [s3-layout.md](s3-layout.md)). Omit it (rather than sending `""`) when
  the scope has no such override - this is what most requests do. The
  server never looks this up itself; it only ever uses whatever a given
  request supplies, so a single `serve` process handling requests from
  several unrelated projects doesn't need any per-connection or
  session-wide config - see [plugin.md](plugin.md) for where the plugin
  gets this value from (`.yarnrc.yml`'s `yarnstaticScopeStorage`).
- `ver` (optional, but every current client sends it) - the version the
  client negotiated from the greeting (see Greeting, above): not
  necessarily the client's own maximum, and not necessarily the server's
  either, but `min()` of the two. The server accepts any `ver` at or
  above `minSupportedProtocolVersion` (equal to `protocolVersion` today -
  nothing has ever been dropped, so this never actually rejects anything
  yet). Once a future version *does* drop support for an old `ver`, the
  server responds with the normal failure shape below -
  `{"ok": false, "message": "server no longer supports protocol version
  ... - please upgrade..."}` - not a special error type, since an
  unsupported version is really just another reason a particular request
  can't be served.

JSON, rather than a fixed-format text line, is deliberate: adding a new
optional field later (as `storageFolder` and `ver` both were) doesn't
require every existing parser to change, since unknown/absent keys are
simply ignored.

## Response

The server writes exactly one JSON header line, then - on success - the
raw tarball bytes, then closes the connection.

**Success**:
```json
{"ok": true, "length": 12345}
```
followed immediately by exactly `length` raw tarball bytes. Every success
response carries `length`, `0` for an empty object; the plugin rejects one
without it.

**Failure**, no body:
```json
{"ok": false, "message": "not found: lodash/lodash-1.0.0.tgz"}
```

The client reads up to the first `\n` and `JSON.parse`s it. On `ok:
true`, it reads exactly `length` more bytes as the tarball body - reads
should stop there; the server closes the connection immediately after
writing the body, so relying on end-of-stream as an additional signal is
fine but not required. On `ok: false`, `message` is the failure reason.

## Why this shape

- **JSON header lines, not a custom text format.** A JSON object is
  self-describing and forward-compatible: a newer client talking to an
  older server (or vice versa) degrades to "unknown field ignored"
  instead of a parse error, as long as required fields don't change
  shape. This matters here specifically because the daemon binary and
  the plugin are resolved/installed somewhat independently (see
  `resolveBinary` in [plugin.md](plugin.md)), so version skew between
  them is plausible.
- **An explicit `ver` negotiation, not just relying on JSON's tolerance
  for unknown fields.** JSON's own forward-compatibility (above) covers
  *additive* changes fine on its own - it doesn't need a version number
  to add an optional field. What it can't cover is a change to something
  that already exists (a field's meaning, a required field becoming
  optional or vice versa, the framing itself). `ver` gives both sides a
  place to detect and react to that kind of change, once one actually
  exists - today, with only `"1.0"` ever having existed, negotiation
  always trivially resolves to `"1.0"` and the server's version check
  never actually rejects anything, but the mechanism is in place now,
  deliberately.
- **Capability negotiation (`min(client, server)`), not an exact-match
  handshake.** The greeting isn't a gate that only a matching version
  passes - the client always sends *some* request, using whichever
  version is lower: what it knows how to speak, or what the server just
  declared. This is what makes it a real compatibility mechanism instead
  of a brittle tripwire: a client newer than the server gracefully
  speaks the server's older (but still-supported) version instead of
  refusing to talk to it, and a client older than the server just keeps
  speaking the only version it knows, which the server - as long as it
  hasn't dropped that version - still understands. The only thing that
  actually fails a connection is a structurally broken greeting
  (malformed JSON, or `ok`/`ready` not both `true`) - a version
  *difference* by itself is never a handshake failure. Rejection for a
  version the server has truly stopped supporting happens one layer
  later, as an ordinary failed *request* (`{"ok": false, "message":
  "..."}`), reusing the exact same failure path a missing package or an
  S3 error already goes through - not a new, special-cased error kind.
- **Because it travels as an ordinary optional JSON field**, an old
  server talking to a new client (or vice versa) that doesn't know about
  `ver` yet just doesn't see it - no framing break, no crash, just no
  version negotiation on that side.
- **No framing library for the body.** A byte-length-prefixed body
  (`length`, then that many raw bytes) is still the simplest possible
  framing for the actual tarball bytes, which JSON itself is a poor fit
  for (no reason to base64 multi-MB binary payloads just to keep the
  whole message as one JSON document).
- **One request per connection.** Avoids needing to multiplex multiple
  in-flight requests over a shared connection (interleaved responses,
  request IDs, etc.) - concurrency is just "open another connection,"
  which `yarnstatic serve` handles by accepting many connections at once
  (bounded by `--max-concurrency`; see [cli.md](cli.md)).
- **The server buffers the tarball before responding.** Because the
  protocol requires the byte-length up front, `yarnstatic serve` reads the
  full tarball into memory before writing anything back, rather than
  streaming it directly from S3 to the socket. This is a deliberate
  tradeoff: npm tarballs are typically small enough (KBs to a few MBs) that
  this is a non-issue, and `--max-concurrency` bounds the worst case
  aggregate memory use. `yarnstatic fetch` (the one-shot CLI command) does
  not have this constraint and streams directly.
- **`storageFolder` travels per-request, not as daemon startup config.**
  Whether a package's scope needs a storage-folder override is a fact
  about how Verdaccio is configured, resolved by whoever's about to make
  the request (the plugin, from its project's `.yarnrc.yml`) - not
  something to bake into the daemon's environment at spawn time. A
  daemon holds no scope-to-storage state of its own; it just does
  whatever one request says, which is what keeps `yarnstatic serve`
  correct regardless of whether it's ever asked to serve more than one
  consumer at once.

## Error message conventions

Both `message` values in `{"ok": false, ...}` and `yarnstatic fetch`'s
stderr output follow the same convention: one clean, single-line
sentence, no stack traces, no raw multi-line SDK error dumps. For the
plugin, `message` becomes the literal text of the `Error` it throws back
into Yarn's fetch pipeline - so whatever's in that field is exactly what
a user sees when `yarn install --immutable` fails. Unlike the old
plain-text framing, embedded newlines in a message no longer need manual
flattening - JSON string encoding escapes them automatically, so the
header line is always exactly one line without any extra handling.
