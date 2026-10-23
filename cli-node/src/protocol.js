'use strict';

// Wire-protocol pieces for `yarnstatic serve` / the daemon-based Yarn
// plugin's socket client, per docs/protocol.md (the shared source of
// truth for both sides). Ported from cmd/yarnstatic/serve.go.
//
// parseVersion/compareVersions here are the SERVER-side mirror of the
// exact same algorithm already implemented (and tested) as the CLIENT
// side in plugins/yarn-plugin-yarnstatic/sources/index.js -- reused
// verbatim, not re-derived, so both sides of this protocol agree on what
// "1.10" vs "1.9" means.

// PROTOCOL_VERSION is this server's current/highest protocol version, sent
// in the greeting on every connection. Bump it when the wire format
// changes in a way older/newer parsers can't just ignore via JSON's normal
// unknown-field tolerance.
const PROTOCOL_VERSION = '1.0';

// MIN_SUPPORTED_PROTOCOL_VERSION is the oldest client-declared "ver" this
// server still accepts requests from -- equal to PROTOCOL_VERSION today
// (nothing has ever been dropped), but distinct from it: as new versions
// ship, PROTOCOL_VERSION moves forward while this only moves forward once
// support for older clients is deliberately dropped. A request older than
// this gets a normal {ok: false, message: "..."} response telling the
// caller to upgrade -- not a special error type.
const MIN_SUPPORTED_PROTOCOL_VERSION = '1.0';

// parseVersion reads only the major and minor components of a
// "major.minor[.patch]" version string, ignoring a third+ component if
// present (e.g. "1.2.3" parses the same as "1.2"). Unparseable components
// are treated as 0 rather than throwing -- an invalid version string is
// handled by the caller deciding what to do with the resulting ordering,
// not by failing here.
function parseVersion(v) {
  const parts = String(v).split('.');
  const major = parts.length > 0 ? (Number.parseInt(parts[0], 10) || 0) : 0;
  const minor = parts.length > 1 ? (Number.parseInt(parts[1], 10) || 0) : 0;
  return {major, minor};
}

// compareVersions compares "major.minor" version strings numerically
// (unlike a plain string compare, this gets "1.10" > "1.9" right).
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va.major !== vb.major) return va.major - vb.major;
  return va.minor - vb.minor;
}

// greeting is what handleConn sends immediately upon accepting any
// connection, before reading anything -- see docs/protocol.md.
function greeting() {
  return {ok: true, ver: PROTOCOL_VERSION, ready: true};
}

// parseRequestLine decodes one already-read request line into a plain
// {package, storageFolder, ver} object. Trailing "\r\n" and bare "\n" are
// both accepted (nc/telnet-style manual testing tends to send "\r\n").
// Throws (a JSON syntax error) on malformed input -- callers format that
// into the "malformed request: ..." response message themselves.
//
// The shape checks match Go's typed json.Unmarshal into its request
// struct. A JSON null decodes to an empty request, which fails later as an
// invalid package spec. A non-object, or a field that isn't a string, is
// malformed.
function parseRequestLine(line) {
  const trimmed = line.replace(/[\r\n]+$/, '');
  const req = JSON.parse(trimmed);
  if (req === null) return {};
  if (typeof req !== 'object' || Array.isArray(req)) {
    throw new Error('request is not a JSON object');
  }
  for (const field of ['package', 'storageFolder', 'ver']) {
    if (req[field] !== undefined && req[field] !== null && typeof req[field] !== 'string') {
      throw new Error(`request field "${field}" is not a string`);
    }
  }
  return req;
}

// writeJSONLine writes one JSON object as a line (with a trailing "\n") to
// a writable socket/stream.
function writeJSONLine(socket, obj) {
  socket.write(`${JSON.stringify(obj)}\n`);
}

module.exports = {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  parseVersion,
  compareVersions,
  greeting,
  parseRequestLine,
  writeJSONLine,
};
