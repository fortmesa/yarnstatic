/**
 * yarn-plugin-yarnstatic
 *
 * Intercepts npm tarball downloads and serves them from a private S3
 * bucket (via a local `yarnstatic serve` daemon, or a direct `aws s3 cp`
 * fallback if that binary can't be found/started -- see the AWS CLI
 * fallback section below) instead of the real network, so `yarn install
 * --immutable` can run fully offline. See ../../../docs/plugin.md and
 * ../../../docs/protocol.md for the full design and the reasoning behind
 * it.
 *
 * Enablement is driven entirely by the YARNSTATIC_BUCKET environment
 * variable: leave it unset and this plugin is a complete no-op.
 *
 * NOTE: this file targets the `wrapNetworkRequest` hook shape and
 * `WrapNetworkRequestInfo`/`Response` fields as documented in Yarn Berry's
 * plugin API at the time this was written. Verify `extra.target` and the
 * `{body, statusCode, headers}` response shape against the actual Yarn
 * version in use before relying on this in production - see
 * docs/plugin.md's verification notes.
 *
 * Built via @yarnpkg/builder (`yarn build`, see package.json), same as
 * ../yarn-plugin-yarnstatic-s3 -- purely for a smaller, comment-stripped
 * distributable, since this file has no actual external dependency to
 * bundle (only Node built-ins + @yarnpkg/core, both left external by
 * esbuild's own platform:'node' handling, same as that plugin). This is a
 * plain top-level-require module, NOT wrapped in its own
 * `factory: (require) => {...}` -- @yarnpkg/builder's own banner/footer
 * supplies that wrapper around whatever this file exports. Authoring a
 * second, redundant one here (this file's own prior shape, before the
 * build step existed) breaks silently: the `require` identifier that
 * wrapper introduces shadows the real one for everything nested inside
 * it, so the bundler can't tell those require(...) calls apart from a
 * call to some arbitrary same-named local variable, and the doubly-
 * wrapped return value ends up being this file's own {name, factory}
 * object instead of the actual {default: {...}} hooks payload Yarn
 * expects back from calling the (builder-supplied) outer factory -- see
 * ../yarn-plugin-yarnstatic-s3/sources/index.js's own header comment for
 * the full story of how that was found.
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {SettingsType} = require('@yarnpkg/core');

const READY_POLL_INTERVAL_MS = 50;
const READY_TIMEOUT_MS = 10000;

// The highest protocol version this plugin knows how to speak - see
// docs/protocol.md. Bump alongside cmd/yarnstatic/serve.go's
// protocolVersion when the wire format changes in a way older/newer
// parsers can't just ignore via JSON's normal unknown-field tolerance.
const PROTOCOL_VERSION = '1.0';

/**
 * Reads only the major and minor components of a version string, ignoring
 * a third+ component if present (e.g. "1.2.3" parses the same as "1.2") -
 * this project's versions are documented and used as "major.minor" only
 * (see docs/protocol.md). Unparseable components coalesce to 0 via `|| 0`
 * rather than propagating NaN - a NaN comparison is always false, which
 * would make checkGreeting's `<= 0` check silently treat a malformed
 * version as acceptable instead of degrading safely, the same way
 * cmd/yarnstatic/serve.go's parseVersion treats a failed strconv.Atoi.
 */
function parseVersion(v) {
  const parts = v.split('.');
  return [Number(parts[0]) || 0, Number(parts[1]) || 0];
}

/**
 * Compares "major.minor" version strings numerically (unlike a plain
 * string compare, this gets "1.10" > "1.9" right).
 */
function compareVersions(a, b) {
  const [aMajor, aMinor] = parseVersion(a);
  const [bMajor, bMinor] = parseVersion(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  return aMinor - bMinor;
}

/**
 * Validates one greeting line (sent unprompted as the first thing on every
 * connection - see docs/protocol.md) and returns the protocol version this
 * client should use for its request on this connection: whatever it knows
 * how to send, capped at whatever the daemon has declared it supports.
 * There's no hard failure on a version *difference* here - only on a
 * malformed/not-ready greeting, which points at something more broadly
 * wrong than a version skew. A daemon that's actually dropped support for
 * this client's version rejects the *request* normally (an {"ok": false,
 * "message": "..."} response, surfaced the same way any other fetch
 * failure is), not this handshake.
 */
function checkGreeting(line) {
  let greeting;
  try {
    greeting = JSON.parse(line);
  } catch {
    throw new Error(`yarnstatic: malformed greeting from daemon: ${line}`);
  }
  if (greeting.ok !== true || greeting.ready !== true || typeof greeting.ver !== 'string') {
    throw new Error(`yarnstatic: daemon did not report ready: ${line}`);
  }
  return compareVersions(PROTOCOL_VERSION, greeting.ver) <= 0 ? PROTOCOL_VERSION : greeting.ver;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the yarnstatic binary to invoke, checking in order:
 *   1. YARNSTATIC_BIN env var (explicit override, always wins)
 *   2. <projectRoot>/node_modules/.bin/yarnstatic (local devDependency)
 *   3. $GOBIN, $GOPATH/bin, or ~/go/bin (a `go install`-produced binary)
 *   4. ~/.yarn/bin/yarnstatic (Yarn's own per-user bin directory - the
 *      same one classic Yarn 1.x installs global binaries into, often
 *      already on PATH)
 *   5. ~/.local/bin/yarnstatic (XDG-ish per-user bin dir on Linux)
 *   6. bare "yarnstatic", resolved via PATH by child_process itself
 *      (covers Homebrew, system package managers, or a binary baked into
 *      a CI image's /usr/local/bin)
 */
function resolveBinary(projectRoot) {
  if (process.env.YARNSTATIC_BIN) {
    return process.env.YARNSTATIC_BIN;
  }

  const home = os.homedir();
  const candidates = [];

  if (projectRoot) {
    candidates.push(path.join(projectRoot, 'node_modules', '.bin', 'yarnstatic'));
  }

  const goBin = process.env.GOBIN || (process.env.GOPATH && path.join(process.env.GOPATH, 'bin'));
  candidates.push(path.join(goBin || path.join(home, 'go', 'bin'), 'yarnstatic'));

  candidates.push(path.join(home, '.yarn', 'bin', 'yarnstatic'));
  candidates.push(path.join(home, '.local', 'bin', 'yarnstatic'));

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return 'yarnstatic'; // final fallback: let PATH resolution find it
}

// ---------------------------------------------------------------------------
// Daemon lifecycle - spawned once per `yarn` process, torn down with it.
// See docs/plugin.md's "Daemon lifecycle" section for why this is safe
// under concurrent requests and what happens on ungraceful termination.
// ---------------------------------------------------------------------------

let daemonPromise = null;

function ensureDaemon(projectRoot) {
  // Synchronous check-and-set, no `await` before it: this is what
  // guarantees exactly one daemon gets spawned even though many tarball
  // fetches call this concurrently.
  if (!daemonPromise) {
    daemonPromise = startDaemon(projectRoot);
  }
  return daemonPromise;
}

function startDaemon(projectRoot) {
  const socketPath = path.join(os.tmpdir(), `yarnstatic-${process.pid}.sock`);
  const bin = resolveBinary(projectRoot);

  const child = spawn(bin, ['serve', '--socket', socketPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Without this, the still-running daemon (and its open stderr pipe) keeps
  // this process's event loop non-empty forever, so it never reaches the
  // point of naturally exiting - the `process.on('exit')` kill below would
  // never fire. unref() lets Node consider exiting once yarn's own work is
  // done, at which point 'exit' fires and explicitly kills the daemon.
  child.unref();
  child.stderr.unref();

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  // Scoped to exactly one `yarn install` invocation: tell the daemon to
  // stop the moment this process is about to exit, success or failure
  // alike. (This does not cover a hard kill of *this* process - see the
  // daemon's own idle-timeout safety net in `yarnstatic serve`.)
  process.on('exit', () => {
    try {
      child.kill();
    } catch {
      // already dead - nothing to do
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `yarnstatic serve exited before becoming ready (code=${code}, signal=${signal}): ${stderr.trim()}`
      ));
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`failed to spawn ${bin}: ${err.message}`));
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    const tryConnect = () => {
      if (settled) return;
      const probe = net.createConnection(socketPath);
      let buf = Buffer.alloc(0);
      probe.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const newlineIndex = buf.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const line = buf.slice(0, newlineIndex).toString('utf8');
        probe.end();
        if (settled) return;
        try {
          checkGreeting(line);
        } catch (err) {
          settled = true;
          reject(err);
          return;
        }
        settled = true;
        resolve({socketPath, child});
      });
      probe.once('error', () => {
        probe.destroy();
        if (settled) return;
        if (Date.now() >= deadline) {
          settled = true;
          reject(new Error(`yarnstatic serve did not become ready within ${READY_TIMEOUT_MS}ms`));
          return;
        }
        setTimeout(tryConnect, READY_POLL_INTERVAL_MS);
      });
    };
    tryConnect();
  });
}

// ---------------------------------------------------------------------------
// Wire protocol client - one connection per fetch, JSON request/response
// lines, see docs/protocol.md
// ---------------------------------------------------------------------------

function fetchFromDaemon(socketPath, packageSpec, storageFolder) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const chunks = [];
    let buf = Buffer.alloc(0);
    let state = 'greeting'; // 'greeting' -> 'header' -> 'body'
    let header = null; // {ok: true, length} | {ok: false, message}

    function takeLine() {
      const newlineIndex = buf.indexOf(0x0a); // "\n"
      if (newlineIndex < 0) return null;
      const line = buf.slice(0, newlineIndex).toString('utf8');
      buf = buf.slice(newlineIndex + 1);
      return line;
    }

    conn.on('data', (chunk) => {
      if (state === 'body') {
        chunks.push(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);

      if (state === 'greeting') {
        const line = takeLine();
        if (line === null) return;
        let ver;
        try {
          ver = checkGreeting(line);
        } catch (err) {
          conn.destroy();
          reject(err);
          return;
        }
        state = 'header';
        // Send whatever version we know how to send, capped at what the
        // daemon just told us it supports (checkGreeting's return value).
        const request = {package: packageSpec, ver};
        if (storageFolder) request.storageFolder = storageFolder;
        conn.write(`${JSON.stringify(request)}\n`);
        // fall through - the header line may already be in `buf` if it
        // arrived in the same chunk as the greeting
      }

      if (state === 'header') {
        const line = takeLine();
        if (line === null) return;

        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          conn.destroy();
          reject(new Error(`yarnstatic: malformed response header from daemon: ${line}`));
          return;
        }

        if (parsed.ok === true) {
          if (!Number.isFinite(parsed.length) || parsed.length < 0) {
            conn.destroy();
            reject(new Error(`yarnstatic: malformed response header from daemon: ${line}`));
            return;
          }
          header = {ok: true, length: parsed.length};
        } else if (parsed.ok === false) {
          header = {ok: false, message: parsed.message};
        } else {
          conn.destroy();
          reject(new Error(`yarnstatic: malformed response header from daemon: ${line}`));
          return;
        }

        state = 'body';
        if (buf.length > 0) {
          chunks.push(buf);
          buf = Buffer.alloc(0);
        }
      }
    });

    conn.on('end', () => {
      if (!header) {
        reject(new Error('yarnstatic: daemon closed the connection before sending a response'));
        return;
      }
      if (!header.ok) {
        reject(new Error(`yarnstatic: ${header.message}`));
        return;
      }
      const body = Buffer.concat(chunks);
      if (body.length !== header.length) {
        reject(new Error(
          `yarnstatic: daemon response truncated (expected ${header.length} bytes, got ${body.length})`
        ));
        return;
      }
      resolve(body);
    });

    conn.on('error', (err) => {
      reject(new Error(`yarnstatic: failed to reach yarnstatic serve daemon: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Tarball URL matching
// ---------------------------------------------------------------------------

/**
 * Parses a URL matching Yarn's npm tarball convention:
 *   {registry}/{identUrl}/-/{basename}-{version}.tgz
 * where identUrl is "/name" or "/@scope%2fname" (NpmSemverFetcher retries
 * with an unencoded "/@scope/name" on a first-attempt failure, so both
 * forms are accepted here). Returns "name@version" or "@scope/name@version"
 * for the daemon protocol, or null if target isn't a recognized npm
 * tarball URL.
 */
function parseTarballUrl(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const sepIndex = url.pathname.indexOf('/-/');
  if (sepIndex < 0) return null;

  const identSegment = url.pathname.slice(1, sepIndex);
  const basename = url.pathname.slice(sepIndex + 3);
  if (identSegment === '' || !basename.endsWith('.tgz') || basename.includes('/')) {
    return null;
  }

  let ident;
  try {
    ident = decodeURIComponent(identSegment);
  } catch {
    return null;
  }

  let scope = null;
  let name = ident;
  if (ident.startsWith('@')) {
    const slash = ident.indexOf('/');
    if (slash < 0) return null;
    scope = ident.slice(1, slash);
    name = ident.slice(slash + 1);
  } else if (ident.includes('/')) {
    return null;
  }

  const base = basename.slice(0, -4); // strip ".tgz"
  const prefix = `${name}-`;
  if (!base.startsWith(prefix)) return null;
  const version = base.slice(prefix.length);
  if (!version) return null;

  return scope ? `@${scope}/${name}@${version}` : `${name}@${version}`;
}

/**
 * Extracts the scope (without "@") from a parseTarballUrl-shaped spec
 * ("@scope/name@version" or "name@version"), or null if unscoped.
 */
function scopeOf(packageSpec) {
  if (!packageSpec.startsWith('@')) return null;
  return packageSpec.slice(1, packageSpec.indexOf('/'));
}

// ---------------------------------------------------------------------------
// AWS CLI fallback -- used only when the yarnstatic binary itself can't be
// found/started (see ensureDaemon's catch in wrapNetworkRequest below),
// not for a per-request failure from an already-running daemon. Ported
// literally from internal/verdaccio/key.go's SplitIdentAndSuffix/
// SplitIdent/TarballKey (same source ../yarn-plugin-yarnstatic-s3's own
// tarballKey is ported from) -- this plugin's own parseTarballUrl above
// already joins scope/name/version into one "name@version"-shaped string
// for the daemon wire protocol, so splitPackageSpec here just reverses
// that join to get the parts tarballKey needs, rather than threading a
// second, unjoined return value through parseTarballUrl for only this
// one caller.
// ---------------------------------------------------------------------------

// Matches cmd/yarnstatic/config.go's defaultKeyPrefix exactly -- the
// layout of the production Verdaccio S3 bucket (your-s3-bucket).
const DEFAULT_KEY_PREFIX = 'verdaccio';

/**
 * Splits "<ident>@<suffix>" at the correct "@" -- the one AFTER any
 * leading "@scope/", not the first byte. Returns null on a missing "@"
 * separator (mirrors Go's SplitIdentAndSuffix returning an error there).
 */
function splitIdentAndSuffix(s) {
  const searchFrom = s.startsWith('@') ? 1 : 0;
  const at = s.indexOf('@', searchFrom);
  if (at < 0) return null;
  return {ident: s.slice(0, at), suffix: s.slice(at + 1)};
}

/**
 * Splits an npm ident ("name" or "@scope/name") into {scope, name}
 * (scope is null if unscoped). Returns null if a leading "@" has no
 * following "/", or either half would be empty.
 */
function splitIdent(ident) {
  if (!ident.startsWith('@')) {
    if (ident === '') return null;
    return {scope: null, name: ident};
  }
  const slash = ident.indexOf('/');
  if (slash < 0) return null;
  const scope = ident.slice(1, slash);
  const name = ident.slice(slash + 1);
  if (!scope || !name) return null;
  return {scope, name};
}

/**
 * Parses a parseTarballUrl-shaped spec ("name@version" or
 * "@scope/name@version") into {scope, name, version} for tarballKey().
 * Returns null on anything malformed -- this is only ever called with a
 * spec parseTarballUrl itself already produced, so a null here would
 * indicate a real bug in one of these two functions disagreeing with
 * the other, not a normal/expected input-validation case.
 */
function splitPackageSpec(packageSpec) {
  const split = splitIdentAndSuffix(packageSpec);
  if (!split || !split.suffix) return null;
  const identParts = splitIdent(split.ident);
  if (!identParts) return null;
  return {scope: identParts.scope, name: identParts.name, version: split.suffix};
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * Computes the S3 object key verdaccio-aws-s3-storage uses for a package
 * tarball -- see ../yarn-plugin-yarnstatic-s3/sources/index.js's own
 * tarballKey for the full layout explanation; this is the same function.
 */
function tarballKey(prefix, spec, storageFolder) {
  let p = normalizePrefix(prefix);
  if (storageFolder) p += normalizePrefix(storageFolder);
  if (!spec.scope) {
    return `${p}${spec.name}/${spec.name}-${spec.version}.tgz`;
  }
  return `${p}@${spec.scope}/${spec.name}/${spec.name}-${spec.version}.tgz`;
}

/**
 * Same env vars cmd/yarnstatic/config.go's commonFlags.resolve() reads --
 * YARNSTATIC_ENDPOINT/YARNSTATIC_PROFILE are optional (aws CLI's own
 * default resolution -- shared config/credentials files, IAM role --
 * applies when unset, same as the Go tool and ../yarn-plugin-yarnstatic-s3).
 * Assumes YARNSTATIC_BUCKET is already known non-empty (wrapNetworkRequest
 * already checked this before this path is ever reached).
 */
function resolveAwsCliConfig() {
  return {
    bucket: process.env.YARNSTATIC_BUCKET,
    keyPrefix: process.env.YARNSTATIC_KEY_PREFIX || DEFAULT_KEY_PREFIX,
    region: process.env.YARNSTATIC_REGION || '',
    endpoint: process.env.YARNSTATIC_ENDPOINT || '',
    profile: process.env.YARNSTATIC_PROFILE || '',
  };
}

/**
 * Fetches a package tarball via a direct `aws s3 cp s3://bucket/key -`
 * call, streamed to stdout -- used only as a fallback when the
 * yarnstatic binary itself couldn't be found/started (see
 * wrapNetworkRequest below). Deliberately does not search for the `aws`
 * binary the way resolveBinary() does for yarnstatic -- there's no
 * equivalent ambiguity to resolve (aws CLI installs are already
 * expected to be on PATH), so this just invokes `aws` directly and lets
 * spawn's own ENOENT surface naturally if it's genuinely missing.
 */
function fetchViaAwsCli(packageSpec, storageFolder) {
  return new Promise((resolve, reject) => {
    const spec = splitPackageSpec(packageSpec);
    if (!spec) {
      reject(new Error(`yarnstatic: could not parse package spec "${packageSpec}" for the AWS CLI fallback`));
      return;
    }
    const config = resolveAwsCliConfig();
    const key = tarballKey(config.keyPrefix, spec, storageFolder);

    const args = ['s3', 'cp', `s3://${config.bucket}/${key}`, '-'];
    if (config.region) args.push('--region', config.region);
    if (config.profile) args.push('--profile', config.profile);
    if (config.endpoint) args.push('--endpoint-url', config.endpoint);

    const child = spawn('aws', args, {stdio: ['ignore', 'pipe', 'pipe']});
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (err) => {
      reject(new Error(`yarnstatic: failed to spawn aws CLI: ${err.message}`));
    });
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `yarnstatic: "aws s3 cp s3://${config.bucket}/${key}" failed (exit code ${code}): ${stderr.trim()}`
        ));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = {
  default: {
    configuration: {
      // Reproduces a Verdaccio packages['@scope/*'].storage override
      // (see yarnstatic's docs/s3-layout.md) so requests for that
      // scope's packages compute the right S3 key. Keyed by scope
      // without the leading "@", matching the daemon protocol field
      // this gets forwarded into (docs/protocol.md). Not derivable
      // from anything else - only Verdaccio's own admin config knows
      // this, so it has to be supplied here directly.
      yarnstaticScopeStorage: {
        description: `Maps an npm scope (no leading "@") to a Verdaccio packages[...].storage folder override`,
        type: SettingsType.MAP,
        valueDefinition: {
          description: 'The Verdaccio storage folder value configured for this scope',
          type: SettingsType.STRING,
        },
      },
    },
    hooks: {
      wrapNetworkRequest: async (executor, extra) => {
        const bucket = process.env.YARNSTATIC_BUCKET;
        if (!bucket) {
          return executor; // disabled - pure passthrough, real network proceeds
        }

        const packageSpec = parseTarballUrl(extra.target);
        if (!packageSpec) {
          // Enabled, but this isn't a recognized tarball request: block it
          // rather than letting it reach the real network. This is what
          // makes "yarnstatic enabled" a hard offline guarantee instead of
          // a best-effort one.
          return async () => {
            throw new Error(
              `yarnstatic: blocked network request to ${extra.target} (YARNSTATIC_BUCKET is set, but this ` +
              `isn't a recognized npm tarball URL servable from S3). If this is unexpected during a locked ` +
              `"yarn install --immutable", check that your lockfile is fully resolved - see docs/architecture.md.`
            );
          };
        }

        const projectRoot = (extra.configuration && extra.configuration.projectCwd) || process.cwd();

        // Always a Map, empty if yarnstaticScopeStorage was never set -
        // see Configuration's getDefaultValue for SettingsType.MAP.
        const scopeStorage = extra.configuration.get('yarnstaticScopeStorage');
        const scope = scopeOf(packageSpec);
        const storageFolder = scope ? scopeStorage.get(scope) : undefined;

        return async () => {
          // Only ensureDaemon() itself failing (the yarnstatic binary
          // couldn't be found/started at all) falls back to the AWS
          // CLI -- a successfully-started daemon's own per-request
          // failure (fetchFromDaemon rejecting, e.g. a genuine "not
          // found" for this one package) propagates normally below,
          // since the aws CLI would fail identically against the same
          // real S3 state and a fallback there would just double the
          // same error under a different label.
          let socketPath;
          try {
            ({socketPath} = await ensureDaemon(projectRoot));
          } catch (daemonErr) {
            try {
              const body = await fetchViaAwsCli(packageSpec, storageFolder);
              return {body, statusCode: 200, headers: {}};
            } catch (awsErr) {
              throw new Error(
                `yarnstatic: daemon unavailable (${daemonErr.message}), and the AWS CLI fallback also failed: ${awsErr.message}`
              );
            }
          }
          const body = await fetchFromDaemon(socketPath, packageSpec, storageFolder);
          return {body, statusCode: 200, headers: {}};
        };
      },
    },
  },
};

// Test-only: exposes the pure helper functions above for direct unit
// testing (see ../test/smoke.js) without needing to drive everything
// through the wrapNetworkRequest hook. Yarn itself never reads this key --
// only `.default` (configuration/hooks) is part of the real plugin contract.
module.exports._test = {
  parseVersion,
  compareVersions,
  checkGreeting,
  parseTarballUrl,
  scopeOf,
  splitPackageSpec,
  tarballKey,
  resolveAwsCliConfig,
  DEFAULT_KEY_PREFIX,
};
