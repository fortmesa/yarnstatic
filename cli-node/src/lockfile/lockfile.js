'use strict';

const fs = require('node:fs');
const YAML = require('yaml');

const {splitIdentAndSuffix, splitIdent} = require('../verdaccio/key');

const PROTOCOL_NPM = 'npm';
const SKIP_PROTOCOL = 'non-npm resolution protocol';
const SKIP_NO_CHECKSUM = 'npm entry with no checksum';

// parse reads a yarn.lock document (as text) and extracts npm-protocol,
// checksummed entries -- candidates for S3 verification/fetching. Ported
// from internal/lockfile/lockfile.go's Parse.
//
// Returns {entries, skipped}:
//   entries: [{descriptor, scope, name, version, checksum}, ...]
//   skipped: [{descriptor, protocol, reason}, ...]
//
// Note: an empty/EOF document is an ERROR here (matching Go's Parse,
// which has no special-case for it), unlike scopestorage.js's
// loadScopeStorage -- an empty .yarnrc.yml is fine (no config), but an
// empty yarn.lock is not a valid lockfile.
function parse(text) {
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new Error(`parsing yarn.lock: ${err.message}`);
  }
  if (raw == null) {
    throw new Error('parsing yarn.lock: document is empty');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parsing yarn.lock: document is not a mapping');
  }

  // Sort keys for deterministic output, matching Go's explicit sort (Go
  // map iteration order is random, so it sorts to compensate -- JS object
  // key order is already insertion-order, but sorting here keeps behavior
  // identical regardless of that and matches the Go source directly).
  const keys = Object.keys(raw).sort();

  const entries = [];
  const skipped = [];

  for (const key of keys) {
    if (key === '__metadata') continue;

    const node = raw[key];
    if (node == null || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`yarn.lock entry ${JSON.stringify(key)}: not a mapping`);
    }

    const resolution = node.resolution;
    if (resolution === undefined || resolution === null || resolution === '') {
      throw new Error(`yarn.lock entry ${JSON.stringify(key)}: missing resolution field`);
    }
    if (typeof resolution !== 'string') {
      throw new Error(`yarn.lock entry ${JSON.stringify(key)}: resolution field is not a string`);
    }

    let ident, suffix;
    try {
      ({ident, suffix} = splitIdentAndSuffix(resolution));
    } catch (err) {
      throw new Error(`yarn.lock entry ${JSON.stringify(key)}: resolution ${JSON.stringify(resolution)}: ${err.message}`);
    }
    let scope, name;
    try {
      ({scope, name} = splitIdent(ident));
    } catch (err) {
      throw new Error(`yarn.lock entry ${JSON.stringify(key)}: resolution ${JSON.stringify(resolution)}: ${err.message}`);
    }

    const colonIndex = suffix.indexOf(':');
    const protocol = colonIndex >= 0 ? suffix.slice(0, colonIndex) : suffix;

    if (protocol !== PROTOCOL_NPM) {
      skipped.push({descriptor: key, protocol, reason: SKIP_PROTOCOL});
      continue;
    }

    const checksum = node.checksum;
    if (checksum === undefined || checksum === null || checksum === '') {
      skipped.push({descriptor: key, protocol, reason: SKIP_NO_CHECKSUM});
      continue;
    }

    const version = node.version !== undefined && node.version !== null ? String(node.version) : '';

    entries.push({descriptor: key, scope, name, version, checksum: String(checksum)});
  }

  return {entries, skipped};
}

// parseFile opens and parses the yarn.lock file at filePath.
function parseFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`no yarn.lock found at ${filePath}`);
    }
    throw err;
  }
  return parse(text);
}

// skippedCounts summarizes skipped entries by protocol, e.g. for a
// one-line report.
function skippedCounts(skipped) {
  const counts = {};
  for (const s of skipped) {
    counts[s.protocol] = (counts[s.protocol] || 0) + 1;
  }
  return counts;
}

module.exports = {
  parse,
  parseFile,
  skippedCounts,
  PROTOCOL_NPM,
  SKIP_PROTOCOL,
  SKIP_NO_CHECKSUM,
};
