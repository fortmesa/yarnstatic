/**
 * yarn-plugin-yarnstatic
 *
 * Intercepts npm tarball downloads and serves them from a private S3
 * bucket (via a local `yarnstatic serve` daemon) instead of the real
 * network, so `yarn install --immutable` can run fully offline. See
 * ../../../docs/plugin.md and ../../../docs/protocol.md for the full
 * design and the reasoning behind it.
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
 * Everything below lives inside factory(require), not at module top
 * level: `yarn plugin import` reads this file's declared `name` by
 * executing it in a bare vm.runInNewContext sandbox that only injects
 * `module`/`exports` - not `require`. A top-level `require(...)` call
 * would throw ReferenceError during that introspection step, well before
 * the plugin is ever actually loaded by Yarn for real. factory's `require`
 * parameter is the only one guaranteed available at that point.
 */
'use strict';

module.exports = {
  name: 'plugin-yarnstatic',
  factory: (require) => {
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
    // Plugin
    // ---------------------------------------------------------------------------

    return {
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
              const {socketPath} = await ensureDaemon(projectRoot);
              const body = await fetchFromDaemon(socketPath, packageSpec, storageFolder);
              return {body, statusCode: 200, headers: {}};
            };
          },
        },
      },
    };
  },
};
