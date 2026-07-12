'use strict';

const path = require('node:path');

const {parseArgs, ParseError} = require('../argparse');
const config = require('../config');
const lockfile = require('../lockfile/lockfile');
const {loadScopeStorage} = require('../scopestorage');
const {tarballKey} = require('../verdaccio/key');
const s3client = require('../s3client/client');
const {runLimited} = require('../pool');

const CHECK_CONCURRENCY = 16;

// networkBypassProtocols bypass the plugin's wrapNetworkRequest block
// entirely (they don't fetch tarballs over httpUtils), so they deserve a
// louder warning than the routine workspace:/portal:/link: skip summary.
const NETWORK_BYPASS_PROTOCOLS = ['git', 'github', 'exec'];

const USAGE = `Usage: yarnstatic check [flags] [path]

Parses <path>/yarn.lock (path defaults to the current directory) and
verifies that every npm-protocol, checksummed package it references exists
in the configured S3 bucket. Exits non-zero if anything is missing or
errored, listing every problem - not just the first.

Flags:
${config.COMMON_FLAGS_HELP}`;

function printUsage() {
  process.stderr.write(USAGE);
}

// printSkipSummary mirrors check.go's own printSkipSummary, writing to
// stdout (it's part of the command's normal report, not an error).
function printSkipSummary(result) {
  const counts = lockfile.skippedCounts(result.skipped);
  const protoKeys = Object.keys(counts);

  if (protoKeys.length === 0) {
    console.log(`yarn.lock: ${result.entries.length} npm package(s) with checksums (no entries skipped)`);
    return;
  }

  protoKeys.sort();
  const parts = protoKeys.map(p => `${counts[p]} ${p}:`);
  console.log(`yarn.lock: ${result.entries.length} npm package(s) with checksums (skipped: ${parts.join(', ')})`);

  for (const p of NETWORK_BYPASS_PROTOCOLS) {
    const n = counts[p];
    if (n > 0) {
      console.log(
        `WARNING: ${n} entries resolve via the ${JSON.stringify(p)} protocol, which the yarnstatic plugin's ` +
        `network block does not cover - they may still require real network access during install`
      );
    }
  }
}

// formatKindCounts renders a fixed, priority order (matching the exit-code
// priority below) rather than object key order, so the summary line is
// deterministic across runs.
function formatKindCounts(kindCounts) {
  const {ErrorKind, errorKindString} = s3client;
  const kinds = [ErrorKind.KindConfiguration, ErrorKind.KindNoCredentials, ErrorKind.KindAccessDenied, ErrorKind.KindOther];
  const parts = [];
  for (const k of kinds) {
    const n = kindCounts[k] || 0;
    if (n > 0) parts.push(`${n} ${errorKindString(k)}`);
  }
  return parts.join(', ');
}

async function runCheck(args) {
  let parsed;
  try {
    parsed = parseArgs(args, config.COMMON_FLAG_SPEC);
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(`yarnstatic check: ${err.message}\n`);
      printUsage();
      return config.exitUsage;
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    return config.exitUsage;
  }

  let dir = '.';
  if (parsed.positionals.length === 1) {
    dir = parsed.positionals[0];
  } else if (parsed.positionals.length > 1) {
    process.stderr.write('yarnstatic check: too many arguments (usage: check [flags] [path])\n');
    return config.exitUsage;
  }

  // requireBucket (inside resolveCommonFlags) is the "missing bucket name"
  // case the exitConfiguration code exists for -- see config.js.
  let bucket, keyPrefix, s3opts;
  try {
    ({bucket, keyPrefix, s3opts} = config.resolveCommonFlags(config.commonFlagsFromValues(parsed.values)));
  } catch (err) {
    process.stderr.write(`yarnstatic check: ${err.message}\n`);
    return config.exitConfiguration;
  }

  const lockPath = path.join(dir, 'yarn.lock');
  let result;
  try {
    result = lockfile.parseFile(lockPath);
  } catch (err) {
    process.stderr.write(`yarnstatic check: ${err.message}\n`);
    return config.exitUsage;
  }

  let scopeStorage;
  try {
    scopeStorage = loadScopeStorage(dir) || {};
  } catch (err) {
    process.stderr.write(`yarnstatic check: ${err.message}\n`);
    return config.exitUsage;
  }

  printSkipSummary(result);

  if (result.entries.length === 0) {
    console.log('no npm packages with checksums found to verify');
    return config.exitOK;
  }

  let client;
  try {
    // Rarely/never actually throws in the JS port (S3Client construction
    // is lazy, unlike Go's config.LoadDefaultConfig) -- kept for parity
    // and defensive coding; see s3client/client.js's createClient comment
    // and the documented exit-code divergence this causes.
    client = s3client.createClient(bucket, s3opts);
  } catch (err) {
    process.stderr.write(`yarnstatic check: failed to initialize S3 client: ${err.message}\n`);
    return config.exitConfiguration;
  }

  console.log(`Checking s3://${bucket}/${keyPrefix} ...\n`);

  const results = new Array(result.entries.length);
  await runLimited(result.entries, CHECK_CONCURRENCY, async (entry, i) => {
    const key = tarballKey(
      keyPrefix,
      {scope: entry.scope, name: entry.name, version: entry.version},
      scopeStorage[entry.scope] || ''
    );
    try {
      const exists = await s3client.exists(client, key);
      results[i] = {entry, key, exists, err: null};
    } catch (err) {
      // Never propagate the error out of runLimited -- that would abandon
      // siblings, but the whole point is reporting every missing/errored
      // object, not just the first (matches check.go's own comment).
      results[i] = {entry, key, exists: false, err};
    }
  });

  const missing = [];
  const errored = [];
  let present = 0;
  const kindCounts = {};
  for (const r of results) {
    if (r.err) {
      errored.push(r);
      const kind = s3client.classify(r.err);
      kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    } else if (r.exists) {
      present++;
    } else {
      missing.push(r);
    }
  }

  if (missing.length > 0) {
    console.log(`MISSING (${missing.length}):`);
    for (const r of missing) {
      console.log(`  ${r.entry.descriptor.padEnd(30)} s3://${bucket}/${r.key}`);
    }
    console.log();
  }
  if (errored.length > 0) {
    // Note: without s3:ListBucket permission, an "access denied" here
    // might actually be a missing object S3 won't confirm/deny the
    // existence of to this role -- see s3client/client.js's classify()
    // doc comment.
    console.log(`ERRORS (${errored.length}):`);
    for (const r of errored) {
      const kind = s3client.classify(r.err);
      console.log(`  ${r.entry.descriptor.padEnd(30)} [${s3client.errorKindString(kind)}] ${r.err.message}`);
    }
    console.log();
  }

  console.log(`Summary: ${present} present, ${missing.length} missing, ${errored.length} error (out of ${results.length} checked)`);
  if (errored.length > 0) {
    console.log(`  errors by kind: ${formatKindCounts(kindCounts)}`);
  }

  // Priority order, most to least fundamental: a misconfigured connection
  // or a wholesale inability to authenticate means nothing in this run can
  // be trusted, so those outrank a merely-denied or merely-unclassified
  // error, which in turn outrank a confirmed-missing object -- the most
  // common and least alarming outcome. Matches check.go's own exit-code
  // priority chain exactly -- a literal if/else-if chain, not a data
  // structure that could silently reorder.
  const {ErrorKind} = s3client;
  if (kindCounts[ErrorKind.KindConfiguration] > 0) return config.exitConfiguration;
  if (kindCounts[ErrorKind.KindNoCredentials] > 0) return config.exitNoCredentials;
  if (kindCounts[ErrorKind.KindAccessDenied] > 0) return config.exitAccessDenied;
  if (kindCounts[ErrorKind.KindOther] > 0) return config.exitOtherError;
  if (missing.length > 0) return config.exitMissing;
  return config.exitOK;
}

module.exports = {runCheck};
