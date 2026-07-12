'use strict';

const {tarballKey} = require('./verdaccio/key');
const {downloadToWritable} = require('./s3client/client');

// downloadPackage computes the S3 key for spec and streams its tarball
// bytes from client into writable, returning the key used (for error
// reporting). storageFolder reproduces a Verdaccio packages[...].storage
// override for spec's scope -- pass '' when there isn't one (see
// verdaccio/key.js's tarballKey). Ported literally from
// cmd/yarnstatic/download.go -- used identically by both commands/fetch.js
// (writable is stdout or a file) and commands/serve.js (writable is an
// in-memory buffer, matching Go's own downloadPackage being called with
// either an *os.File or a *bytes.Buffer as its io.Writer).
//
// Go's version returns (key, err) as a tuple, so callers get the key even
// when err is non-nil (needed for error messages). JS can't return-then-
// throw, so on failure the key is attached to the thrown error as
// `.s3Key` instead -- callers that need it for an error message read
// `err.s3Key`.
async function downloadPackage(client, keyPrefix, spec, storageFolder, writable) {
  const key = tarballKey(keyPrefix, spec, storageFolder);
  try {
    await downloadToWritable(client, key, writable);
  } catch (err) {
    err.s3Key = key;
    throw err;
  }
  return key;
}

module.exports = {downloadPackage};
