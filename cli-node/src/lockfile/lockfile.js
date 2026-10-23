'use strict';

const fs = require('node:fs');
const YAML = require('yaml');

const {splitIdentAndSuffix, splitIdent, parseTarballUrl} = require('../verdaccio/key');

const PROTOCOL_NPM = 'npm';
const SKIP_PROTOCOL = 'non-npm resolution protocol';
// An npm entry whose __archiveUrl the plugins don't recognize as a tarball
// URL, so they block the fetch.
const SKIP_ARCHIVE_URL = 'npm entry with an unrecognized __archiveUrl';

// parse reads a yarn.lock document (as text) and extracts npm-protocol
// entries -- candidates for S3 verification/fetching. Ported from
// internal/lockfile/lockfile.go's Parse.
//
// Returns {entries, noChecksum, skipped}:
//   entries:    npm entries with a checksum,
//               [{descriptor, scope, name, version, checksum, conditions, archiveUrl}, ...]
//   noChecksum: npm entries without one, same shape. Yarn writes
//               platform-specific packages this way when the lockfile was
//               made on another platform, but an install on a matching
//               platform still fetches them.
//   skipped:    [{descriptor, protocol, reference, reason}, ...], where
//               reference is the resolution after the ident's "@" (what
//               Yarn's fetchers match on), or the __archiveUrl for
//               SKIP_ARCHIVE_URL
//
// conditions is the entry's "conditions" field (e.g. "os=darwin &
// cpu=arm64"), or ''. archiveUrl is the resolution's __archiveUrl, which
// Yarn records when the registry's tarball URL isn't the conventional one;
// Yarn fetches that URL instead, so scope/name/version come from parsing it
// the way the plugins do.
//
// Note: an empty/EOF document is an ERROR here (matching Go's Parse,
// which has no special-case for it), unlike yarnrc.js -- an empty
// .yarnrc.yml is fine (no config), but an empty yarn.lock is not a valid
// lockfile.
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
  const noChecksum = [];
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
      skipped.push({descriptor: key, protocol, reference: suffix, reason: SKIP_PROTOCOL});
      continue;
    }

    let spec = {
      scope,
      name,
      version: node.version !== undefined && node.version !== null ? String(node.version) : '',
    };
    const archiveUrl = archiveUrlOf(suffix);
    if (archiveUrl) {
      const parsed = parseTarballUrl(archiveUrl);
      if (!parsed) {
        skipped.push({descriptor: key, protocol, reference: archiveUrl, reason: SKIP_ARCHIVE_URL});
        continue;
      }
      spec = parsed;
    }

    const checksum = node.checksum;
    const hasChecksum = !(checksum === undefined || checksum === null || checksum === '');
    const entry = {
      descriptor: key,
      scope: spec.scope,
      name: spec.name,
      version: spec.version,
      checksum: hasChecksum ? String(checksum) : '',
      conditions: node.conditions != null ? String(node.conditions) : '',
      archiveUrl,
    };
    (hasChecksum ? entries : noChecksum).push(entry);
  }

  return {entries, noChecksum, skipped};
}

// archiveUrlOf returns the __archiveUrl parameter of an npm reference
// ("npm:1.0.0::__archiveUrl=https%3A%2F%2F..."), or '' if it has none. Yarn
// binds locator parameters after "::" in querystring form.
function archiveUrlOf(reference) {
  const sep = reference.indexOf('::');
  if (sep < 0) return '';
  return new URLSearchParams(reference.slice(sep + 2)).get('__archiveUrl') || '';
}

// GIT_PATTERNS is Yarn's own isGitUrl pattern list (@yarnpkg/plugin-git
// gitUtils.ts), which GitFetcher.supports() matches against a locator's
// reference. Copied verbatim; lockfile.go's Go port spells the two
// lookahead patterns out in code.
const GIT_PATTERNS = [
  /^ssh:/,
  /^git(?:\+[^:]+)?:/,
  // `git+` is optional, `.git` is required
  /^(?:git\+)?https?:[^#]+\/[^#]+(?:\.git)(?:#.*)?$/,
  /^git@[^#]+\/[^#]+\.git(?:#.*)?$/,
  /^(?:github:|https:\/\/github\.com\/)?(?!\.{1,2}\/)([a-zA-Z._0-9-]+)\/(?!\.{1,2}(?:#|$))([a-zA-Z._0-9-]+?)(?:\.git)?(?:#.*)?$/,
  // GitHub `/tarball/` URLs
  /^https:\/\/github\.com\/(?!\.{1,2}\/)([a-zA-Z0-9._-]+)\/(?!\.{1,2}(?:#|$))([a-zA-Z0-9._-]+?)\/tarball\/(.+)?$/,
];

// isGitReference reports whether Yarn's git fetcher handles this locator
// reference, i.e. whether `yarn install` clones it with git. A git clone
// doesn't go through the network hook the yarnstatic plugins wrap, so these
// entries still need real network access.
function isGitReference(reference) {
  return reference ? GIT_PATTERNS.some(pattern => pattern.test(reference)) : false;
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

// skippedCounts summarizes the protocol skips by protocol, e.g. for a
// one-line report.
function skippedCounts(skipped) {
  const counts = {};
  for (const s of skipped) {
    if (s.reason !== SKIP_PROTOCOL) continue;
    counts[s.protocol] = (counts[s.protocol] || 0) + 1;
  }
  return counts;
}

module.exports = {
  parse,
  parseFile,
  skippedCounts,
  isGitReference,
  PROTOCOL_NPM,
  SKIP_PROTOCOL,
  SKIP_ARCHIVE_URL,
};
