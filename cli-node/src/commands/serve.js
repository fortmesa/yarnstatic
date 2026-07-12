'use strict';

const net = require('node:net');
const fs = require('node:fs');
const {Writable} = require('node:stream');

const {parseArgs, ParseError} = require('../argparse');
const config = require('../config');
const s3client = require('../s3client/client');
const {parsePackageSpec, packageSpecToString} = require('../verdaccio/key');
const {downloadPackage} = require('../download');
const protocol = require('../protocol');

const DEFAULT_MAX_CONCURRENCY = 32;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 10 * 1000;

const SERVE_FLAG_SPEC = {
  ...config.COMMON_FLAG_SPEC,
  socket: {type: 'string', default: ''},
  'max-concurrency': {type: 'int', default: DEFAULT_MAX_CONCURRENCY},
};

const USAGE = `Usage: yarnstatic serve --socket <path> [flags]

Runs a daemon that serves package tarballs over a Unix domain socket. This
is what the Yarn plugin talks to during "yarn install" - not meant to be
invoked directly. See docs/protocol.md for the wire protocol.

Flags:
${config.COMMON_FLAGS_HELP}  -socket string
        unix socket path to listen on (required)
  -max-concurrency int
        max concurrent S3 downloads in flight (default ${DEFAULT_MAX_CONCURRENCY})
`;

function printUsage() {
  process.stderr.write(USAGE);
}

// BufferWritable collects everything written to it into memory --
// serve's equivalent of Go's bytes.Buffer, since the wire protocol needs
// the byte length up front (see docs/protocol.md's "why this shape"). The
// same download.js's downloadPackage() used by commands/fetch.js (against
// stdout/a file) is reused here unmodified, just given a different
// Writable target -- mirrors Go's own downloadPackage(ctx, client,
// keyPrefix, spec, storageFolder, w) being called with either an *os.File
// or a *bytes.Buffer as its io.Writer.
class BufferWritable extends Writable {
  constructor() {
    super();
    this._chunks = [];
  }
  _write(chunk, encoding, callback) {
    this._chunks.push(chunk);
    callback();
  }
  toBuffer() {
    return Buffer.concat(this._chunks);
  }
}

// describeDownloadError only ever feeds into the per-request
// {ok: false, message: "..."} response (see docs/protocol.md) -- a
// per-request failure is never a distinct process exit code, unlike
// check/fetch. Richer classification here (KindNoCredentials/
// KindConfiguration, not just not-found/access-denied) is purely to make
// that message text more actionable for whoever's staring at a failed
// `yarn install`. Ported from serve.go's describeDownloadError.
function describeDownloadError(err, key) {
  const kind = s3client.classify(err);
  switch (kind) {
    case s3client.ErrorKind.KindNotFound:
      return `not found: ${key}`;
    case s3client.ErrorKind.KindAccessDenied:
      return `access denied: ${key}`;
    case s3client.ErrorKind.KindNoCredentials:
      return `no credentials available to sign the request: ${err.message}`;
    case s3client.ErrorKind.KindConfiguration:
      return `invalid configuration: ${err.message}`;
    default:
      return `download failed: ${err.message}`;
  }
}

function writeErrSafe(socket, message) {
  try {
    protocol.writeJSONLine(socket, {ok: false, message});
  } catch {
    // best-effort, matches Go's writeErr silently discarding a write error
  }
}

// readLine buffers incoming socket data until the first "\n", resolving
// with everything up to and including it. Resolves with null (not an
// error) if the connection closes before a full line arrives -- the
// plugin's readiness probe does exactly this (reads the greeting, then
// disconnects without sending a request), matching Go's
// errors.Is(err, io.EOF) branch in handleConn.
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        cleanup();
        resolve(buffer.slice(0, idx + 1));
      }
    }
    function onEnd() {
      cleanup();
      resolve(null);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
    }
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

// handleConn services exactly one request per connection: send the
// greeting, read a JSON request line, respond with a JSON response line,
// then tarball bytes on success. Never throws -- every failure path is
// handled inline (written to the socket and/or logged), matching Go's
// handleConn, which returns void and handles every error branch itself.
// See docs/protocol.md.
async function handleConn(socket, client, keyPrefix) {
  try {
    protocol.writeJSONLine(socket, protocol.greeting());
  } catch {
    socket.destroy();
    return;
  }

  let line;
  try {
    line = await readLine(socket);
  } catch (err) {
    process.stderr.write(`yarnstatic serve: failed to read request: ${err.message}\n`);
    socket.destroy();
    return;
  }
  if (line === null) {
    // Readiness probe: greeting sent, client disconnected without a
    // request -- not an error, matches Go's errors.Is(err, io.EOF) branch.
    socket.destroy();
    return;
  }

  let req;
  try {
    req = protocol.parseRequestLine(line);
  } catch (err) {
    const msg = `malformed request: ${err.message}`;
    writeErrSafe(socket, msg);
    process.stderr.write(`yarnstatic serve: malformed request ${JSON.stringify(line)}: ${err.message}\n`);
    socket.end();
    return;
  }

  // Empty/absent ver means a client that predates this whole mechanism --
  // treat it as compatible rather than rejecting it outright. This check
  // is a no-op today (MIN_SUPPORTED_PROTOCOL_VERSION === PROTOCOL_VERSION,
  // so nothing has ever been dropped) -- it exists so a future version
  // bump that DOES drop support for old clients has somewhere to reject
  // them, with a clear reason.
  if (req.ver && protocol.compareVersions(req.ver, protocol.MIN_SUPPORTED_PROTOCOL_VERSION) < 0) {
    const msg = `server no longer supports protocol version ${req.ver} (minimum supported: ${protocol.MIN_SUPPORTED_PROTOCOL_VERSION}) - please upgrade yarnstatic and the yarn plugin`;
    writeErrSafe(socket, msg);
    process.stderr.write(`yarnstatic serve: ${msg}\n`);
    socket.end();
    return;
  }

  let spec;
  try {
    spec = parsePackageSpec(req.package);
  } catch (err) {
    writeErrSafe(socket, err.message);
    process.stderr.write(`yarnstatic serve: ${err.message}\n`);
    socket.end();
    return;
  }

  // Buffered here (rather than streamed) so the length header required by
  // the protocol can be written before the body; bounded in aggregate by
  // --max-concurrency (see runServe's acquire/release around this call).
  const buf = new BufferWritable();
  let key;
  try {
    key = await downloadPackage(client, keyPrefix, spec, req.storageFolder || '', buf);
  } catch (err) {
    key = err.s3Key;
    const msg = describeDownloadError(err, key);
    writeErrSafe(socket, msg);
    process.stderr.write(`yarnstatic serve: ${packageSpecToString(spec)}: ${msg}\n`);
    socket.end();
    return;
  }

  const body = buf.toBuffer();
  try {
    protocol.writeJSONLine(socket, {ok: true, length: body.length});
  } catch {
    socket.destroy();
    return;
  }
  socket.end(body);
}

// runServe implements the daemon the Yarn plugin talks to: one S3 client
// built once at startup, then any number of tarball fetches served over a
// Unix socket, one connection per request. Ported from
// cmd/yarnstatic/serve.go. See docs/protocol.md.
async function runServe(args) {
  let parsed;
  try {
    parsed = parseArgs(args, SERVE_FLAG_SPEC);
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(`yarnstatic serve: ${err.message}\n`);
      printUsage();
      return config.exitUsage;
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    return config.exitUsage;
  }

  const socketPath = parsed.values.socket;
  if (!socketPath) {
    process.stderr.write('yarnstatic serve: --socket is required\n');
    return config.exitUsage;
  }

  // requireBucket (inside resolveCommonFlags) is the "missing bucket name"
  // case the exitConfiguration code exists for -- see config.js. This
  // only affects serve's own STARTUP: once running, a per-request failure
  // never changes serve's exit code -- see describeDownloadError above.
  let bucket, keyPrefix, s3opts;
  try {
    ({bucket, keyPrefix, s3opts} = config.resolveCommonFlags(config.commonFlagsFromValues(parsed.values)));
  } catch (err) {
    process.stderr.write(`yarnstatic serve: ${err.message}\n`);
    return config.exitConfiguration;
  }

  let client;
  try {
    client = s3client.createClient(bucket, s3opts);
  } catch (err) {
    process.stderr.write(`yarnstatic serve: failed to initialize S3 client: ${err.message}\n`);
    return config.exitConfiguration;
  }

  try {
    fs.unlinkSync(socketPath); // defensive: clear a stale socket file, if any
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Not fatal -- Go's own os.Remove call here discards its error too;
      // the upcoming listen() call is what actually surfaces a real
      // problem (e.g. permissions) if there is one.
    }
  }

  const maxConcurrency = parsed.values['max-concurrency'];
  let activeCount = 0;
  const waitQueue = [];
  function acquire() {
    if (activeCount < maxConcurrency) {
      activeCount++;
      return Promise.resolve();
    }
    return new Promise(resolve => waitQueue.push(resolve));
  }
  function release() {
    activeCount--;
    const next = waitQueue.shift();
    if (next) {
      activeCount++;
      next();
    }
  }

  const inFlight = new Set();
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown('idle timeout reached'), IDLE_TIMEOUT_MS);
    idleTimer.unref(); // never keep the process alive on the idle timer alone
  }

  let shutdownStarted = false;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });

  // shutdown mirrors serve.go's own shutdown closure: stop accepting, wait
  // for in-flight connections to drain up to SHUTDOWN_GRACE_MS, then
  // remove the socket file and finish with exit code 0 regardless of how
  // we got here (signal, idle timeout, or an unexpected listener error --
  // Go treats a listener-closed accept error as its own, separately
  // unbounded-wait shutdown path; this port simplifies that rare case into
  // the same grace-period-bounded shutdown rather than a third distinct
  // code path).
  async function shutdown(reason) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.stderr.write(`yarnstatic serve: ${reason}, shutting down\n`);
    if (idleTimer) clearTimeout(idleTimer);
    server.close();

    let timedOut = false;
    await Promise.race([
      Promise.all([...inFlight]),
      new Promise(resolve => setTimeout(() => { timedOut = true; resolve(); }, SHUTDOWN_GRACE_MS)),
    ]);
    if (timedOut) {
      process.stderr.write('yarnstatic serve: shutdown grace period elapsed, exiting with connections still in flight\n');
    }
    try { fs.unlinkSync(socketPath); } catch { /* best-effort */ }
    resolveExit(config.exitOK);
  }

  const server = net.createServer(socket => {
    resetIdleTimer();
    const p = acquire()
      .then(() => handleConn(socket, client, keyPrefix))
      .catch(err => {
        process.stderr.write(`yarnstatic serve: unexpected error handling connection: ${err.message}\n`);
      })
      .finally(() => release());
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    process.stderr.write(`yarnstatic serve: failed to listen on ${socketPath}: ${err.message}\n`);
    return config.exitUsage;
  }

  process.stderr.write(`yarnstatic serve: listening on ${socketPath} (bucket=${bucket})\n`);

  const onSigint = () => shutdown('received SIGINT');
  const onSigterm = () => shutdown('received SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  resetIdleTimer();

  const exitCode = await exitPromise;
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  return exitCode;
}

module.exports = {runServe};
