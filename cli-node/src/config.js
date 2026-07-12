'use strict';

const {ErrorKind} = require('./s3client/client');

// Process exit codes shared by check/fetch/serve, in increasing order of
// "how fundamental is the thing that's wrong." A single command
// invocation only ever needs one of these, but check aggregates results
// across every entry in a yarn.lock, so it picks the highest-priority code
// among everything it saw -- see commands/check.js. Ported literally from
// cmd/yarnstatic/config.go.
//
// exitUsage stays reserved for how the command was invoked (bad flags,
// wrong argument count, an unparseable project file) -- not how it's
// configured to reach S3. exitConfiguration is specifically about the S3
// connection: a missing required setting (--bucket) or something
// classify() identifies as ErrorKind.KindConfiguration (bad region,
// malformed --endpoint, a --profile that doesn't exist). See
// docs/cli.md's exit code tables.
const exitOK = 0;
const exitMissing = 1; // check only: one or more entries confirmed absent from the bucket
const exitUsage = 2;
const exitConfiguration = 3;
const exitNoCredentials = 4;
const exitAccessDenied = 5;
const exitOtherError = 6;

// exitCodeForKind maps an ErrorKind (from classify()) to the process exit
// code that reports it -- the one place this mapping is defined, so
// check/fetch/serve can't drift out of sync on what each kind means.
function exitCodeForKind(kind) {
  switch (kind) {
    case ErrorKind.KindNotFound: return exitMissing;
    case ErrorKind.KindConfiguration: return exitConfiguration;
    case ErrorKind.KindNoCredentials: return exitNoCredentials;
    case ErrorKind.KindAccessDenied: return exitAccessDenied;
    default: return exitOtherError;
  }
}

// defaultKeyPrefix matches the layout of the production Verdaccio S3
// bucket, so --key-prefix/YARNSTATIC_KEY_PREFIX don't need to be repeated
// for the common case. It's applied only after both the flag and the env
// var resolve to empty, in resolveCommonFlags() below -- not as the
// flag's own default -- so "flag wins over env var" still works correctly
// (a non-empty registered default would make the flag always appear "set"
// and shadow YARNSTATIC_KEY_PREFIX entirely).
const defaultKeyPrefix = 'verdaccio';

// resolveFlag implements the "flag wins if set, else env var, else empty"
// rule shared by check/fetch/serve.
function resolveFlag(flagVal, envVar) {
  if (flagVal) return flagVal;
  return process.env[envVar] || '';
}

// requireBucket resolves --bucket from either the flag or
// YARNSTATIC_BUCKET, throwing if neither is set.
function requireBucket(flagVal) {
  const bucket = resolveFlag(flagVal, 'YARNSTATIC_BUCKET');
  if (!bucket) {
    throw new Error('--bucket is required (or set YARNSTATIC_BUCKET)');
  }
  return bucket;
}

// resolveCommonFlags validates and merges the S3 connection flags shared
// by check, fetch, and serve ({bucket, keyPrefix, region, endpoint,
// profile} as parsed by argparse.js) with their YARNSTATIC_* env var
// fallbacks. Mirrors commonFlags.resolve() in config.go. Throws on a
// missing bucket (the exitConfiguration case, see above).
function resolveCommonFlags(flags) {
  const bucket = requireBucket(flags.bucket);
  let keyPrefix = resolveFlag(flags.keyPrefix, 'YARNSTATIC_KEY_PREFIX');
  if (!keyPrefix) keyPrefix = defaultKeyPrefix;
  const s3opts = {
    region: resolveFlag(flags.region, 'YARNSTATIC_REGION'),
    endpoint: resolveFlag(flags.endpoint, 'YARNSTATIC_ENDPOINT'),
    profile: resolveFlag(flags.profile, 'YARNSTATIC_PROFILE'),
  };
  return {bucket, keyPrefix, s3opts};
}

// COMMON_FLAG_SPEC is the argparse.js spec fragment shared by check,
// fetch, and serve -- mirrors commonFlags.register() in config.go.
const COMMON_FLAG_SPEC = {
  bucket: {type: 'string', default: ''},
  'key-prefix': {type: 'string', default: ''},
  region: {type: 'string', default: ''},
  endpoint: {type: 'string', default: ''},
  profile: {type: 'string', default: ''},
};

// commonFlagsFromValues adapts argparse.js's parsed values (keyed by
// flag name, e.g. "key-prefix") into resolveCommonFlags()'s expected shape.
function commonFlagsFromValues(values) {
  return {
    bucket: values.bucket,
    keyPrefix: values['key-prefix'],
    region: values.region,
    endpoint: values.endpoint,
    profile: values.profile,
  };
}

// COMMON_FLAGS_HELP is the flag-description block shared by check/fetch/
// serve's usage text -- hand-written equivalent of Go's fs.PrintDefaults(),
// which auto-generates this from each flag's registered description (see
// commonFlags.register() in config.go).
const COMMON_FLAGS_HELP = `  -bucket string
        S3 bucket name (or set YARNSTATIC_BUCKET)
  -key-prefix string
        S3 key prefix (or set YARNSTATIC_KEY_PREFIX; default: "verdaccio")
  -region string
        AWS region (or set YARNSTATIC_REGION; default: AWS SDK default resolution)
  -endpoint string
        custom S3-compatible endpoint URL, e.g. for MinIO (or set YARNSTATIC_ENDPOINT; default: real AWS S3)
  -profile string
        AWS shared config profile (or set YARNSTATIC_PROFILE; default: AWS SDK default credential chain)
`;

module.exports = {
  exitOK,
  exitMissing,
  exitUsage,
  exitConfiguration,
  exitNoCredentials,
  exitAccessDenied,
  exitOtherError,
  exitCodeForKind,
  defaultKeyPrefix,
  resolveFlag,
  requireBucket,
  resolveCommonFlags,
  COMMON_FLAG_SPEC,
  commonFlagsFromValues,
  COMMON_FLAGS_HELP,
};
