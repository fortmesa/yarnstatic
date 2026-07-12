'use strict';

const fs = require('node:fs');

const {parseArgs, ParseError} = require('../argparse');
const config = require('../config');
const {parsePackageSpec, packageSpecToString} = require('../verdaccio/key');
const s3client = require('../s3client/client');
const {downloadPackage} = require('../download');

const FETCH_FLAG_SPEC = {
  ...config.COMMON_FLAG_SPEC,
  package: {type: 'string', default: ''},
  out: {type: 'string', default: ''},
};

const USAGE = `Usage: yarnstatic fetch [flags] --package <name>@<version>

A one-shot helper for manual/debug use: downloads a single package's
tarball from S3 and writes it to stdout (default) or --out. This is not
what the Yarn plugin uses at install time - see "yarnstatic serve".

Flags:
${config.COMMON_FLAGS_HELP}  -package string
        package to fetch, e.g. "lodash@4.17.21" or "@scope/name@1.0.0" (required)
  -out string
        write the tarball to this file instead of stdout
`;

function printUsage() {
  process.stderr.write(USAGE);
}

// createOutputStream opens outPath for writing, surfacing an open failure
// (bad directory, permissions, ...) as a rejected promise rather than an
// 'error' event some time later -- matches Go's os.Create failing
// synchronously.
function createOutputStream(outPath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outPath);
    stream.once('open', () => resolve(stream));
    stream.once('error', reject);
  });
}

async function runFetch(args) {
  let parsed;
  try {
    parsed = parseArgs(args, FETCH_FLAG_SPEC);
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(`yarnstatic fetch: ${err.message}\n`);
      printUsage();
      return config.exitUsage;
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    return config.exitUsage;
  }
  if (parsed.positionals.length > 0) {
    process.stderr.write('yarnstatic fetch: unexpected arguments\n');
    return config.exitUsage;
  }

  const pkg = parsed.values.package;
  const out = parsed.values.out;

  if (!pkg) {
    process.stderr.write('yarnstatic fetch: --package is required\n');
    return config.exitUsage;
  }

  let spec;
  try {
    spec = parsePackageSpec(pkg);
  } catch (err) {
    process.stderr.write(`yarnstatic fetch: ${err.message}\n`);
    return config.exitUsage;
  }

  // requireBucket (inside resolveCommonFlags) is the "missing bucket name"
  // case the exitConfiguration code exists for -- see config.js.
  let bucket, keyPrefix, s3opts;
  try {
    ({bucket, keyPrefix, s3opts} = config.resolveCommonFlags(config.commonFlagsFromValues(parsed.values)));
  } catch (err) {
    process.stderr.write(`yarnstatic fetch: ${err.message}\n`);
    return config.exitConfiguration;
  }

  let client;
  try {
    client = s3client.createClient(bucket, s3opts);
  } catch (err) {
    process.stderr.write(`yarnstatic fetch: failed to initialize S3 client: ${err.message}\n`);
    return config.exitConfiguration;
  }

  let writable = process.stdout;
  if (out) {
    try {
      writable = await createOutputStream(out);
    } catch (err) {
      process.stderr.write(`yarnstatic fetch: ${err.message}\n`);
      return config.exitUsage;
    }
  }

  // fetch is a standalone manual/debug tool with no project directory to
  // read a .yarnrc.yml from (unlike check/serve), so it doesn't support
  // per-scope storage-folder overrides -- see docs/s3-layout.md.
  try {
    await downloadPackage(client, keyPrefix, spec, '', writable);
  } catch (err) {
    if (out) {
      try { fs.unlinkSync(out); } catch { /* best-effort, matching Go's os.Remove */ }
    }
    const key = err.s3Key;
    const kind = s3client.classify(err);
    switch (kind) {
      case s3client.ErrorKind.KindNotFound:
        // Note: without s3:ListBucket permission this might actually come
        // back as KindAccessDenied instead -- see classify()'s doc comment.
        process.stderr.write(`yarnstatic fetch: not found: s3://${bucket}/${key} (package ${packageSpecToString(spec)})\n`);
        break;
      case s3client.ErrorKind.KindAccessDenied:
        process.stderr.write(`yarnstatic fetch: access denied: s3://${bucket}/${key}\n`);
        break;
      case s3client.ErrorKind.KindNoCredentials:
        process.stderr.write(`yarnstatic fetch: no credentials available to sign the request: ${err.message}\n`);
        break;
      case s3client.ErrorKind.KindConfiguration:
        process.stderr.write(`yarnstatic fetch: invalid configuration: ${err.message}\n`);
        break;
      default:
        process.stderr.write(`yarnstatic fetch: failed to download s3://${bucket}/${key}: ${err.message}\n`);
    }
    return config.exitCodeForKind(kind);
  }

  return config.exitOK;
}

module.exports = {runFetch};
