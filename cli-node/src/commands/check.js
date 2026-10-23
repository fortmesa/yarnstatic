'use strict';

const path = require('node:path');

const {parseArgs, ParseError} = require('../argparse');
const config = require('../config');
const lockfile = require('../lockfile/lockfile');
const {loadYarnrc} = require('../yarnrc');
const {tarballKey} = require('../verdaccio/key');
const s3client = require('../s3client/client');
const {runLimited} = require('../pool');

const CHECK_CONCURRENCY = 16;

const USAGE = `Usage: yarnstatic check [flags] [path]

Parses <path>/yarn.lock (path defaults to the current directory) and
verifies that every npm-protocol, checksummed package it references exists
in the configured S3 bucket. Exits non-zero if anything is missing or
errored, listing every problem - not just the first. npm entries without a
checksum (platform-specific packages) are checked too and reported
separately, without affecting the exit code.

Settings left unset by flags and YARNSTATIC_* env vars are read from the
same .yarnrc.yml files Yarn loads for <path> (yarnstaticBucket,
yarnstaticKeyPrefix, yarnstaticRegion, yarnstaticEndpoint,
yarnstaticProfile, yarnstaticScopeStorage).

Flags:
${config.COMMON_FLAGS_HELP}`;

function printUsage() {
  process.stderr.write(USAGE);
}

// printSkipSummary mirrors check.go's own printSkipSummary, writing to
// stdout (it's part of the command's normal report, not an error).
function printSkipSummary(result) {
  const packages = `${result.entries.length} npm package(s) with checksums, ${result.noChecksum.length} without`;
  const counts = lockfile.skippedCounts(result.skipped);
  const protoKeys = Object.keys(counts);

  if (protoKeys.length === 0) {
    console.log(`yarn.lock: ${packages} (no entries skipped)`);
  } else {
    protoKeys.sort();
    const parts = protoKeys.map(p => `${counts[p]} ${p}:`);
    console.log(`yarn.lock: ${packages} (skipped: ${parts.join(', ')})`);
  }

  // Git and exec: entries never reach the network hook the plugins wrap
  // (Yarn clones git dependencies with git itself, and runs exec: scripts),
  // so they deserve a louder warning than the routine skip summary. An npm
  // entry whose __archiveUrl the plugins can't parse is blocked at install
  // time.
  const git = [];
  const exec = [];
  const archive = [];
  for (const s of result.skipped) {
    if (s.reason === lockfile.SKIP_ARCHIVE_URL) archive.push(s);
    else if (lockfile.isGitReference(s.reference)) git.push(s);
    else if (s.protocol === 'exec') exec.push(s);
  }
  if (git.length > 0) {
    console.log(
      `WARNING: ${git.length} entries resolve from git repositories, which Yarn clones with git outside the ` +
      `yarnstatic plugin's network block - they need real network access during install:`
    );
    for (const s of git) console.log(`  ${s.descriptor}`);
  }
  if (exec.length > 0) {
    console.log(
      `WARNING: ${exec.length} entries resolve via the "exec" protocol, which the yarnstatic plugin's ` +
      `network block does not cover - they may still require real network access during install:`
    );
    for (const s of exec) console.log(`  ${s.descriptor}`);
  }
  if (archive.length > 0) {
    console.log(
      `WARNING: ${archive.length} npm entries carry an __archiveUrl that isn't an npm tarball URL, so the ` +
      `yarnstatic plugin blocks the fetch during install:`
    );
    for (const s of archive) console.log(`  ${s.descriptor} ${s.reference}`);
  }
}

// tallyOutcomes splits HEAD results into present/missing/errored, with a
// per-ErrorKind count of the errors.
function tallyOutcomes(results) {
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
  return {present, missing, errored, kindCounts};
}

// conditionsSuffix shows which platforms a no-checksum entry is for.
function conditionsSuffix(entry) {
  return entry.conditions ? ` (${entry.conditions})` : '';
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

  let rc;
  try {
    rc = loadYarnrc(dir);
  } catch (err) {
    process.stderr.write(`yarnstatic check: ${err.message}\n`);
    return config.exitUsage;
  }

  // requireBucket (inside resolveCommonFlags) is the "missing bucket name"
  // case the exitConfiguration code exists for -- see config.js.
  let bucket, keyPrefix, s3opts;
  try {
    ({bucket, keyPrefix, s3opts} = config.resolveCommonFlags(config.commonFlagsFromValues(parsed.values), rc));
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

  printSkipSummary(result);

  if (result.entries.length === 0 && result.noChecksum.length === 0) {
    console.log('no npm packages found to verify');
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

  // Both groups share one runLimited pool, so the concurrency limit covers
  // all HEAD requests in flight.
  const all = [...result.entries, ...result.noChecksum];
  const allResults = new Array(all.length);
  await runLimited(all, CHECK_CONCURRENCY, async (entry, i) => {
    const key = tarballKey(
      keyPrefix,
      {scope: entry.scope, name: entry.name, version: entry.version},
      rc.scopeStorage.get(entry.scope) || ''
    );
    try {
      const exists = await s3client.exists(client, key);
      allResults[i] = {entry, key, exists, err: null};
    } catch (err) {
      // Never propagate the error out of runLimited -- that would abandon
      // siblings, but the whole point is reporting every missing/errored
      // object, not just the first (matches check.go's own comment).
      allResults[i] = {entry, key, exists: false, err};
    }
  });

  const results = allResults.slice(0, result.entries.length);
  const noChecksumResults = allResults.slice(result.entries.length);

  const {present, missing, errored, kindCounts} = tallyOutcomes(results);

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

  const nc = tallyOutcomes(noChecksumResults);
  if (nc.missing.length > 0) {
    console.log(`MISSING, NO CHECKSUM (${nc.missing.length}) - not counted in the exit code:`);
    for (const r of nc.missing) {
      console.log(`  ${r.entry.descriptor.padEnd(30)} s3://${bucket}/${r.key}${conditionsSuffix(r.entry)}`);
    }
    console.log();
  }
  if (nc.errored.length > 0) {
    console.log(`ERRORS, NO CHECKSUM (${nc.errored.length}) - not counted in the exit code:`);
    for (const r of nc.errored) {
      const kind = s3client.classify(r.err);
      console.log(`  ${r.entry.descriptor.padEnd(30)} [${s3client.errorKindString(kind)}] ${r.err.message}${conditionsSuffix(r.entry)}`);
    }
    console.log();
  }

  console.log(`Summary: ${present} present, ${missing.length} missing, ${errored.length} error (out of ${results.length} checked)`);
  if (errored.length > 0) {
    console.log(`  errors by kind: ${formatKindCounts(kindCounts)}`);
  }
  if (noChecksumResults.length > 0) {
    console.log(
      `No checksum: ${nc.present} present, ${nc.missing.length} missing, ${nc.errored.length} error ` +
      `(out of ${noChecksumResults.length} checked, not counted in the exit code)`
    );
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
