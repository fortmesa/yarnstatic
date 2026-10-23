'use strict';

const {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  S3ServiceException,
} = require('@aws-sdk/client-s3');

// ErrorKind classifies an error from exists()/download() (or from
// createClient() itself) into a coarse category a caller can act on -- e.g.
// to pick a distinct process exit code -- without needing to know the
// underlying AWS SDK error shapes. Mirrors internal/s3client/client.go's
// ErrorKind exactly, including numeric values (KindOther is the zero
// value, so an unclassified/default ErrorKind reads as "other" rather than
// some more specific and wrong category).
const ErrorKind = Object.freeze({
  KindOther: 0,
  KindNotFound: 1,
  KindAccessDenied: 2,
  KindNoCredentials: 3,
  KindConfiguration: 4,
});

function errorKindString(kind) {
  switch (kind) {
    case ErrorKind.KindNotFound: return 'not found';
    case ErrorKind.KindAccessDenied: return 'access denied';
    case ErrorKind.KindNoCredentials: return 'no credentials';
    case ErrorKind.KindConfiguration: return 'invalid configuration';
    default: return 'other';
  }
}

// notFoundCodes/accessDeniedCodes are the S3ServiceException error codes
// classify() recognizes -- i.e. errors AWS actually responded to over the
// wire. Ported literally from internal/s3client/client.go's own
// notFoundCodes/accessDeniedCodes: the full 11 access-denied codes, not
// just the 4 the sibling yarn-plugin-yarnstatic-s3 plugin's own simplified
// isAccessDenied checks (a documented parity gap in that file already,
// not to be repeated here).
//
// IMPORTANT caveat, carried over from the Go source: without
// s3:ListBucket IAM permission, a HeadObject/GetObject for a genuinely
// missing key returns 403 AccessDenied instead of 404/NoSuchKey -- S3
// won't confirm or deny an object's existence to a caller who can't list
// the bucket. A KindAccessDenied result on a single lookup can therefore
// mean either "no permission" or "doesn't exist, and this role can't tell
// you" -- see docs/cli.md's exit code table for how this affects `check`.
const notFoundCodes = new Set(['NoSuchKey', 'NoSuchBucket', 'NotFound']);
const accessDeniedCodes = new Set([
  'AccessDenied', 'Forbidden', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'ExpiredToken', 'TokenRefreshRequired', 'InvalidToken', 'RequestTimeTooSkewed',
  'AccountProblem', 'AllAccessDisabled', 'UnrecognizedClientException',
]);

// classify inspects err and returns the ErrorKind it belongs to.
//
// If err is an S3ServiceException, the request reached AWS and got a
// structured response back -- notFoundCodes/accessDeniedCodes decide
// between KindNotFound/KindAccessDenied/KindOther. HeadObject specifically
// returns no XML error body for 403/404, so err.name can fall through to a
// bare status-code string or "UnknownError" -- $metadata.httpStatusCode is
// treated as a REQUIRED signal here, not a defensive extra like in the
// sibling plugin's isNotFound() (which only ever calls GetObject, where it
// only needs $metadata as a backstop).
//
// Otherwise, the failure happened locally, before any request was sent.
// Unlike aws-sdk-go-v2 (which wraps everything in an untyped
// *smithy.OperationError, forcing Go's Classify() to string-match),
// aws-sdk-js-v3 gives these TYPED classes for most local failures:
// CredentialsProviderError (from @smithy/core / @aws-sdk/credential-provider-node)
// and EndpointError (a malformed --endpoint URL) -- so classify() can
// branch on err.name directly for these, without needing to match message
// text.
//
// Verified directly against the actually-installed SDK
// (@aws-sdk/client-s3@3.1153.0) with local-only scenarios (no live AWS
// network access -- fake static credentials plus a bad --region/--endpoint
// value, so nothing past local validation ever gets dispatched):
//   - no credentials resolvable at all -> CredentialsProviderError,
//     message "Could not load credentials from any providers"
//   - a --profile that doesn't exist -> CredentialsProviderError, message
//     "Could not resolve credentials using profile: [...] in
//     configuration/credentials file(s)."
//   - a malformed --endpoint URL -> Node's own TypeError from new URL(),
//     code ERR_INVALID_URL, message "Invalid URL". 3.1079.0 threw
//     EndpointError ("Custom endpoint `...` was not a valid URI") instead,
//     so both are handled. The endpoint is the only URL parsed before a
//     request is sent, so ERR_INVALID_URL means the --endpoint value.
//   - an invalid --region string -> a PLAIN Error (constructor/name both
//     "Error", no typed class at all), message "Region not accepted:
//     region=\"...\" is not a valid hostname component." -- this is why
//     the substring fallback below still matters even though the other
//     local-failure cases are typed: region-format validation doesn't get
//     its own error class in this SDK version.
//
// test/smoke.js's "local failure exit codes" checks run these scenarios
// through the real SDK, so a shape change in a later SDK fails the tests.
function classify(err) {
  if (err == null) return ErrorKind.KindOther;

  if (err instanceof S3ServiceException) {
    const code = err.name || err.Code;
    if (notFoundCodes.has(code)) return ErrorKind.KindNotFound;
    if (accessDeniedCodes.has(code)) return ErrorKind.KindAccessDenied;
    const status = err.$metadata && err.$metadata.httpStatusCode;
    if (status === 404) return ErrorKind.KindNotFound;
    if (status === 403) return ErrorKind.KindAccessDenied;
    return ErrorKind.KindOther;
  }

  if (err.name === 'EndpointError' || err.code === 'ERR_INVALID_URL') return ErrorKind.KindConfiguration;
  if (err.name === 'CredentialsProviderError') return ErrorKind.KindNoCredentials;

  const msg = String(err.message || err).toLowerCase();
  if (msg.includes('was not a valid uri') ||
      msg.includes('was not a valid dns name') ||
      msg.includes('region not accepted') ||
      msg.includes('is not a valid hostname component')) {
    return ErrorKind.KindConfiguration;
  }
  if (msg.includes('could not load credentials from any providers') ||
      msg.includes('could not resolve credentials using profile')) {
    return ErrorKind.KindNoCredentials;
  }
  return ErrorKind.KindOther;
}

function isNotFound(err) {
  return classify(err) === ErrorKind.KindNotFound;
}

function isAccessDenied(err) {
  return classify(err) === ErrorKind.KindAccessDenied;
}

// createClient builds an S3 client for bucket using the standard AWS
// credential chain, optionally overridden by opts ({region, endpoint,
// profile}). Ported from internal/s3client/client.go's New(). Unlike Go's
// config.LoadDefaultConfig, this never throws synchronously -- credential/
// region/endpoint resolution failures only surface on the first .send()
// call (see classify()'s own comment, and the documented exit-code
// divergence this causes for check/fetch/serve's "S3 client init failed"
// branch).
function createClient(bucket, opts) {
  const options = {};
  if (opts.region) options.region = opts.region;
  if (opts.endpoint) {
    options.endpoint = opts.endpoint;
    // Virtual-hosted-style addressing generally doesn't work against
    // non-AWS S3-compatible endpoints (MinIO, etc) -- same reasoning as
    // Go's UsePathStyle.
    options.forcePathStyle = true;
  }
  if (opts.profile) {
    const {fromIni} = require('@aws-sdk/credential-providers');
    options.credentials = fromIni({profile: opts.profile});
  }
  return {s3: new S3Client(options), bucket};
}

// exists reports whether key is present in the bucket. Returns false for a
// confirmed-missing object (never throws for that case); any other
// failure (auth, network, throttling, etc) propagates as a thrown error --
// callers should classify() it themselves. Mirrors client.go's Exists.
async function exists(client, key) {
  try {
    await client.s3.send(new HeadObjectCommand({Bucket: client.bucket, Key: key}));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// downloadToWritable streams the object body for key into a Node Writable.
// Mirrors client.go's Download.
async function downloadToWritable(client, key, writable) {
  const {pipeline} = require('node:stream/promises');
  const out = await client.s3.send(new GetObjectCommand({Bucket: client.bucket, Key: key}));
  await pipeline(out.Body, writable);
}

module.exports = {
  ErrorKind,
  errorKindString,
  classify,
  isNotFound,
  isAccessDenied,
  createClient,
  exists,
  downloadToWritable,
};
