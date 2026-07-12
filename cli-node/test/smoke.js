'use strict';

// Manual smoke test -- no framework, matching this org's house style (see
// e.g. plugins/yarn-plugin-yarnstatic-s3/test/smoke.js). Reuses Go test
// fixtures/cases directly wherever possible (internal/lockfile/testdata/
// sample.lock by relative path, and table-driven cases transcribed from
// internal/verdaccio/key_test.go, internal/s3client/client_test.go,
// cmd/yarnstatic/serve_test.go) so the Go and Node implementations are
// exercised against the same data and can't silently drift apart.
//
// Run with:
//   node test/smoke.js

const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');

// Must happen BEFORE requiring anything that itself requires
// @aws-sdk/client-s3: Node's require cache means every subsequent
// require('@aws-sdk/client-s3') resolves to this same, already-patched
// module instance, so no real network call ever happens -- same technique
// plugins/yarn-plugin-yarnstatic-s3/test/smoke.js already uses.
const {S3Client, S3ServiceException} = require('@aws-sdk/client-s3');
let lastCommand = null;
let sendImpl = async () => ({Body: (async function* () {})()});
S3Client.prototype.send = async function (command) {
  lastCommand = command;
  return sendImpl(command);
};

const key = require('../src/verdaccio/key');
const s3client = require('../src/s3client/client');
const protocol = require('../src/protocol');
const config = require('../src/config');
const {parseArgs, ParseError} = require('../src/argparse');
const {runLimited} = require('../src/pool');
const lockfile = require('../src/lockfile/lockfile');
const {loadScopeStorage} = require('../src/scopestorage');

// Reused directly from the Go source tree (not copied) so both parsers are
// always exercised against the exact same bytes -- see the file header.
const SAMPLE_LOCK_PATH = path.join(__dirname, '..', '..', 'internal', 'lockfile', 'testdata', 'sample.lock');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

async function main() {
  // -------------------------------------------------------------------
  // verdaccio/key.js -- ported from internal/verdaccio/key_test.go
  // -------------------------------------------------------------------

  const splitIdentAndSuffixCases = [
    ['unscoped npm', 'lodash@npm:4.17.21', 'lodash', 'npm:4.17.21', false],
    ['scoped npm', '@babel/core@npm:7.20.0', '@babel/core', 'npm:7.20.0', false],
    [
      'scoped patch wrapping npm',
      '@babel/core@patch:@babel/core@npm%3A7.20.0#./.yarn/patches/x.patch',
      '@babel/core',
      'patch:@babel/core@npm%3A7.20.0#./.yarn/patches/x.patch',
      false,
    ],
    ['package spec version', 'lodash@4.17.21', 'lodash', '4.17.21', false],
    ['empty', '', '', '', true],
    ['no at sign', 'noatsign', '', '', true],
    ['scope only no at', '@justscope', '', '', true],
  ];
  for (const [name, input, wantIdent, wantSuffix, wantErr] of splitIdentAndSuffixCases) {
    await check(`splitIdentAndSuffix: ${name}`, () => {
      if (wantErr) {
        assert.throws(() => key.splitIdentAndSuffix(input));
        return;
      }
      const {ident, suffix} = key.splitIdentAndSuffix(input);
      assert.equal(ident, wantIdent);
      assert.equal(suffix, wantSuffix);
    });
  }

  const splitIdentCases = [
    ['unscoped', 'lodash', '', 'lodash', false],
    ['scoped', '@babel/core', 'babel', 'core', false],
    ['scope no slash', '@justscope', '', '', true],
    ['empty', '', '', '', true],
  ];
  for (const [name, input, wantScope, wantName, wantErr] of splitIdentCases) {
    await check(`splitIdent: ${name}`, () => {
      if (wantErr) {
        assert.throws(() => key.splitIdent(input));
        return;
      }
      const {scope, name: gotName} = key.splitIdent(input);
      assert.equal(scope, wantScope);
      assert.equal(gotName, wantName);
    });
  }

  const tarballKeyCases = [
    ['unscoped no prefix', '', {scope: '', name: 'lodash', version: '4.17.21'}, '', 'lodash/lodash-4.17.21.tgz'],
    ['scoped no prefix', '', {scope: 'babel', name: 'core', version: '7.20.0'}, '', '@babel/core/core-7.20.0.tgz'],
    ['unscoped prefix no trailing slash', 'registry', {scope: '', name: 'lodash', version: '4.17.21'}, '', 'registry/lodash/lodash-4.17.21.tgz'],
    ['unscoped prefix with trailing slash', 'registry/', {scope: '', name: 'lodash', version: '4.17.21'}, '', 'registry/lodash/lodash-4.17.21.tgz'],
    ['scoped prefix', 'registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, '', 'registry/@acme/widgets/widgets-2.1.0.tgz'],
    ['scoped with storage folder', 'registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage', 'registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz'],
    ['scoped with storage folder, no prefix', '', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage', 'acme-storage/@acme/widgets/widgets-2.1.0.tgz'],
    ['unscoped with storage folder', 'registry/', {scope: '', name: 'lodash', version: '4.17.21'}, 'legacy', 'registry/legacy/lodash/lodash-4.17.21.tgz'],
    ['storage folder with trailing slash already', 'registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage/', 'registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz'],
  ];
  for (const [name, prefix, spec, storageFolder, want] of tarballKeyCases) {
    await check(`tarballKey: ${name}`, () => {
      assert.equal(key.tarballKey(prefix, spec, storageFolder), want);
    });
  }

  const parsePackageSpecCases = [
    ['unscoped', 'lodash@4.17.21', {scope: '', name: 'lodash', version: '4.17.21'}, false],
    ['scoped', '@babel/core@7.20.0', {scope: 'babel', name: 'core', version: '7.20.0'}, false],
    ['no version', 'lodash', null, true],
    ['scoped no version', '@babel/core', null, true],
    ['scoped no slash', '@justscope@1.0.0', null, true],
  ];
  for (const [name, input, want, wantErr] of parsePackageSpecCases) {
    await check(`parsePackageSpec: ${name}`, () => {
      if (wantErr) {
        assert.throws(() => key.parsePackageSpec(input));
        return;
      }
      assert.deepEqual(key.parsePackageSpec(input), want);
    });
  }

  // -------------------------------------------------------------------
  // lockfile/lockfile.js -- ported from internal/lockfile/lockfile_test.go,
  // reading the real Go testdata fixture by relative path.
  // -------------------------------------------------------------------

  await check('lockfile.parseFile: extracts exactly the 3 npm+checksum entries from sample.lock', () => {
    const result = lockfile.parseFile(SAMPLE_LOCK_PATH);
    const wantEntries = {
      '@babel/core@npm:7.20.0': {scope: 'babel', name: 'core', version: '7.20.0'},
      'lodash@npm:4.17.21': {scope: '', name: 'lodash', version: '4.17.21'},
      'semver@npm:^7.3.5, semver@npm:^7.5.4': {scope: '', name: 'semver', version: '7.5.4'},
    };
    assert.equal(result.entries.length, Object.keys(wantEntries).length);
    for (const e of result.entries) {
      const want = wantEntries[e.descriptor];
      assert.ok(want, `unexpected entry descriptor ${e.descriptor}`);
      assert.equal(e.scope, want.scope);
      assert.equal(e.name, want.name);
      assert.equal(e.version, want.version);
      assert.ok(e.checksum, `entry ${e.descriptor}: expected non-empty checksum`);
    }
  });

  await check('lockfile.parseFile: skippedCounts matches Go fixture (workspace/portal/link/patch, 1 each)', () => {
    const result = lockfile.parseFile(SAMPLE_LOCK_PATH);
    const counts = lockfile.skippedCounts(result.skipped);
    assert.deepEqual(counts, {workspace: 1, portal: 1, link: 1, patch: 1});
  });

  await check('lockfile.parseFile: the patch entry is skipped for SkipProtocol despite having a checksum', () => {
    const result = lockfile.parseFile(SAMPLE_LOCK_PATH);
    const patchSkip = result.skipped.find(s => s.protocol === 'patch');
    assert.ok(patchSkip, 'expected a patch: entry to be present and skipped');
    assert.equal(patchSkip.reason, lockfile.SKIP_PROTOCOL);
    assert.ok(patchSkip.descriptor.startsWith('@babel/core@patch:'));
  });

  await check('lockfile.parse: a yarn.lock entry missing its resolution field is an error', () => {
    const doc = `
__metadata:
  version: 8

"broken@npm:1.0.0":
  version: 1.0.0
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard
`;
    assert.throws(() => lockfile.parse(doc));
  });

  await check('lockfile.parse: an empty document is an error (unlike scopestorage.js, empty is not valid here)', () => {
    assert.throws(() => lockfile.parse(''));
  });

  // -------------------------------------------------------------------
  // scopestorage.js -- ported from cmd/yarnstatic/scopestorage.go
  // -------------------------------------------------------------------

  await check('loadScopeStorage: missing .yarnrc.yml is not an error, returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-scopestorage-test-'));
    try {
      assert.equal(loadScopeStorage(dir), null);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  await check('loadScopeStorage: empty .yarnrc.yml is not an error, returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-scopestorage-test-'));
    try {
      fs.writeFileSync(path.join(dir, '.yarnrc.yml'), '');
      assert.equal(loadScopeStorage(dir), null);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  await check('loadScopeStorage: reads the yarnstaticScopeStorage map when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-scopestorage-test-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.yarnrc.yml'),
        'yarnstaticScopeStorage:\n  acme: acme-storage\n  other: other-storage\n'
      );
      assert.deepEqual(loadScopeStorage(dir), {acme: 'acme-storage', other: 'other-storage'});
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  await check('loadScopeStorage: a .yarnrc.yml without the key returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-scopestorage-test-'));
    try {
      fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'somethingElse: true\n');
      assert.equal(loadScopeStorage(dir), null);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  // -------------------------------------------------------------------
  // s3client/client.js classify() -- ported from
  // internal/s3client/client_test.go. Uses the REAL S3ServiceException
  // class (constructed directly, no network) for the API-error-code
  // cases, and plain {name, message} objects for the typed local-failure
  // classes (EndpointError/CredentialsProviderError), since those aren't
  // part of @aws-sdk/client-s3's own public export surface.
  // -------------------------------------------------------------------

  function fakeApiError(name, httpStatusCode) {
    return new S3ServiceException({
      name,
      $fault: 'client',
      $metadata: httpStatusCode ? {httpStatusCode} : {},
      message: `fake api error: ${name}`,
    });
  }

  const {ErrorKind, classify, errorKindString, isNotFound, isAccessDenied} = s3client;

  const notFoundCodes = ['NoSuchKey', 'NoSuchBucket', 'NotFound'];
  for (const code of notFoundCodes) {
    await check(`classify: API error code ${code} -> KindNotFound`, () => {
      assert.equal(classify(fakeApiError(code)), ErrorKind.KindNotFound);
    });
  }

  const accessDeniedCodes = [
    'AccessDenied', 'Forbidden', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
    'ExpiredToken', 'TokenRefreshRequired', 'InvalidToken', 'RequestTimeTooSkewed',
    'AccountProblem', 'AllAccessDisabled', 'UnrecognizedClientException',
  ];
  for (const code of accessDeniedCodes) {
    await check(`classify: API error code ${code} -> KindAccessDenied`, () => {
      assert.equal(classify(fakeApiError(code)), ErrorKind.KindAccessDenied);
    });
  }

  const otherCodes = ['InvalidObjectState', 'SlowDown', 'InternalError'];
  for (const code of otherCodes) {
    await check(`classify: API error code ${code} -> KindOther`, () => {
      assert.equal(classify(fakeApiError(code)), ErrorKind.KindOther);
    });
  }

  // Node-only cases (no Go equivalent): HeadObject returns no XML error
  // body for 403/404, so $metadata.httpStatusCode must be a REQUIRED
  // fallback signal when the error name isn't one of the modeled codes.
  await check('classify: unrecognized name, httpStatusCode 404 -> KindNotFound (HeadObject-no-body case)', () => {
    assert.equal(classify(fakeApiError('UnknownError', 404)), ErrorKind.KindNotFound);
  });
  await check('classify: unrecognized name, httpStatusCode 403 -> KindAccessDenied (HeadObject-no-body case)', () => {
    assert.equal(classify(fakeApiError('UnknownError', 403)), ErrorKind.KindAccessDenied);
  });
  await check('classify: unrecognized name, no useful httpStatusCode -> KindOther', () => {
    assert.equal(classify(fakeApiError('SomeOtherCode', 500)), ErrorKind.KindOther);
  });

  await check('classify: EndpointError-shaped object -> KindConfiguration', () => {
    assert.equal(classify({name: 'EndpointError', message: 'Custom endpoint `not-a-valid-url` was not a valid URI'}), ErrorKind.KindConfiguration);
  });
  await check('classify: CredentialsProviderError-shaped object -> KindNoCredentials', () => {
    assert.equal(classify({name: 'CredentialsProviderError', message: 'Could not load credentials from any providers'}), ErrorKind.KindNoCredentials);
  });
  await check('classify: fallback substring match for configuration-shaped message', () => {
    assert.equal(classify(new Error('endpoint rule error: Invalid region: region was not a valid DNS name.')), ErrorKind.KindConfiguration);
  });
  await check('classify: fallback substring match for invalid --region (empirically confirmed: a plain Error, no typed class)', () => {
    assert.equal(classify(new Error('Region not accepted: region="not a valid region!!" is not a valid hostname component.')), ErrorKind.KindConfiguration);
  });
  await check('classify: fallback substring match for no-credentials-shaped message', () => {
    assert.equal(classify(new Error('Could not load credentials from any providers')), ErrorKind.KindNoCredentials);
  });
  await check('classify: unrecognized plain error -> KindOther', () => {
    assert.equal(classify(new Error('boom')), ErrorKind.KindOther);
  });
  await check('classify: null -> KindOther', () => {
    assert.equal(classify(null), ErrorKind.KindOther);
  });

  await check('isNotFound/isAccessDenied wrap classify() correctly', () => {
    assert.equal(isNotFound(fakeApiError('NoSuchKey')), true);
    assert.equal(isNotFound(fakeApiError('AccessDenied')), false);
    assert.equal(isAccessDenied(fakeApiError('AccessDenied')), true);
    assert.equal(isAccessDenied(fakeApiError('NoSuchKey')), false);
  });

  await check('errorKindString: all kinds plus an unknown value', () => {
    assert.equal(errorKindString(ErrorKind.KindOther), 'other');
    assert.equal(errorKindString(ErrorKind.KindNotFound), 'not found');
    assert.equal(errorKindString(ErrorKind.KindAccessDenied), 'access denied');
    assert.equal(errorKindString(ErrorKind.KindNoCredentials), 'no credentials');
    assert.equal(errorKindString(ErrorKind.KindConfiguration), 'invalid configuration');
    assert.equal(errorKindString(99), 'other');
  });

  // -------------------------------------------------------------------
  // protocol.js -- ported from cmd/yarnstatic/serve_test.go
  // -------------------------------------------------------------------

  function sign(n) {
    if (n < 0) return -1;
    if (n > 0) return 1;
    return 0;
  }

  const compareVersionsCases = [
    ['1.0', '1.0', 0],
    ['1.0', '1.1', -1],
    ['1.1', '1.0', 1],
    ['1.9', '2.0', -1],
    ['2.0', '1.9', 1],
    ['1.10', '1.9', 1],
    ['1.9', '1.10', -1],
    ['1', '1.0', 0],
    ['1.2.3', '1.3.0', -1],
    ['1.2.3', '1.2.9', 0],
    ['abc', '1.0', -1],
    ['1.0', 'abc', 1],
  ];
  for (const [a, b, wantSign] of compareVersionsCases) {
    await check(`compareVersions: ${a} vs ${b}`, () => {
      assert.equal(sign(protocol.compareVersions(a, b)), wantSign);
    });
  }

  const parseRequestLineCases = [
    ['bare LF line ending', '{"package": "lodash@4.17.21"}\n', {package: 'lodash@4.17.21'}, false],
    ['CRLF line ending', '{"package": "lodash@4.17.21"}\r\n', {package: 'lodash@4.17.21'}, false],
    ['CRLF with storageFolder', '{"package": "@acme/widgets@1.0.0", "storageFolder": "acme-storage"}\r\n', {package: '@acme/widgets@1.0.0', storageFolder: 'acme-storage'}, false],
    ['with ver field', '{"package": "lodash@4.17.21", "ver": "1.0"}\n', {package: 'lodash@4.17.21', ver: '1.0'}, false],
    ['unrecognized ver value is not a parse error', '{"package": "lodash@4.17.21", "ver": "99.0"}\n', {package: 'lodash@4.17.21', ver: '99.0'}, false],
    ['no trailing newline at all', '{"package": "lodash@4.17.21"}', {package: 'lodash@4.17.21'}, false],
    ['malformed JSON', 'lodash@4.17.21\n', null, true],
    ['empty line', '\n', null, true],
  ];
  for (const [name, line, want, wantErr] of parseRequestLineCases) {
    await check(`parseRequestLine: ${name}`, () => {
      if (wantErr) {
        assert.throws(() => protocol.parseRequestLine(line));
        return;
      }
      assert.deepEqual(protocol.parseRequestLine(line), want);
    });
  }

  await check('greeting: locks in the exact wire shape the JS plugin client depends on', () => {
    const g = protocol.greeting();
    assert.deepEqual(g, {ok: true, ver: protocol.PROTOCOL_VERSION, ready: true});
    assert.equal(Object.keys(g).length, 3);
  });

  // -------------------------------------------------------------------
  // config.js
  // -------------------------------------------------------------------

  await check('resolveFlag: flag wins over env var when both set', () => {
    process.env.YARNSTATIC_TEST_VAR = 'from-env';
    try {
      assert.equal(config.resolveFlag('from-flag', 'YARNSTATIC_TEST_VAR'), 'from-flag');
    } finally {
      delete process.env.YARNSTATIC_TEST_VAR;
    }
  });
  await check('resolveFlag: falls back to env var when flag is empty', () => {
    process.env.YARNSTATIC_TEST_VAR = 'from-env';
    try {
      assert.equal(config.resolveFlag('', 'YARNSTATIC_TEST_VAR'), 'from-env');
    } finally {
      delete process.env.YARNSTATIC_TEST_VAR;
    }
  });
  await check('resolveFlag: empty when neither is set', () => {
    assert.equal(config.resolveFlag('', 'YARNSTATIC_TEST_VAR_UNSET'), '');
  });
  await check('requireBucket: throws when neither flag nor env is set', () => {
    delete process.env.YARNSTATIC_BUCKET;
    assert.throws(() => config.requireBucket(''));
  });
  await check('resolveCommonFlags: empty keyPrefix falls back to defaultKeyPrefix', () => {
    const result = config.resolveCommonFlags({bucket: 'my-bucket', keyPrefix: '', region: '', endpoint: '', profile: ''});
    assert.equal(result.bucket, 'my-bucket');
    assert.equal(result.keyPrefix, config.defaultKeyPrefix);
  });
  await check('resolveCommonFlags: explicit keyPrefix is used as-is', () => {
    const result = config.resolveCommonFlags({bucket: 'my-bucket', keyPrefix: 'custom', region: '', endpoint: '', profile: ''});
    assert.equal(result.keyPrefix, 'custom');
  });
  await check('exitCodeForKind: maps every kind to its documented exit code', () => {
    assert.equal(config.exitCodeForKind(ErrorKind.KindNotFound), config.exitMissing);
    assert.equal(config.exitCodeForKind(ErrorKind.KindConfiguration), config.exitConfiguration);
    assert.equal(config.exitCodeForKind(ErrorKind.KindNoCredentials), config.exitNoCredentials);
    assert.equal(config.exitCodeForKind(ErrorKind.KindAccessDenied), config.exitAccessDenied);
    assert.equal(config.exitCodeForKind(ErrorKind.KindOther), config.exitOtherError);
  });

  // -------------------------------------------------------------------
  // argparse.js
  // -------------------------------------------------------------------

  const ARGPARSE_SPEC = {
    bucket: {type: 'string', default: ''},
    count: {type: 'int', default: 5},
  };

  await check('argparse: stops at the first non-flag token', () => {
    const {values, positionals} = parseArgs(['--bucket', 'x', 'somepath', '--bucket', 'y'], ARGPARSE_SPEC);
    assert.equal(values.bucket, 'x');
    assert.deepEqual(positionals, ['somepath', '--bucket', 'y']);
  });
  await check('argparse: -- terminates flag parsing', () => {
    const {values, positionals} = parseArgs(['--bucket', 'x', '--', '--bucket', 'y'], ARGPARSE_SPEC);
    assert.equal(values.bucket, 'x');
    assert.deepEqual(positionals, ['--bucket', 'y']);
  });
  await check('argparse: -h/--help is detected', () => {
    assert.equal(parseArgs(['-h'], ARGPARSE_SPEC).help, true);
    assert.equal(parseArgs(['--help'], ARGPARSE_SPEC).help, true);
  });
  await check('argparse: unknown flag throws ParseError', () => {
    assert.throws(() => parseArgs(['--nope', 'x'], ARGPARSE_SPEC), ParseError);
  });
  await check('argparse: missing value throws ParseError', () => {
    assert.throws(() => parseArgs(['--bucket'], ARGPARSE_SPEC), ParseError);
  });
  await check('argparse: inline --flag=value form', () => {
    const {values} = parseArgs(['--bucket=x'], ARGPARSE_SPEC);
    assert.equal(values.bucket, 'x');
  });
  await check('argparse: int flag parses correctly', () => {
    const {values} = parseArgs(['--count', '42'], ARGPARSE_SPEC);
    assert.equal(values.count, 42);
  });
  await check('argparse: invalid int value throws ParseError', () => {
    assert.throws(() => parseArgs(['--count', 'notanumber'], ARGPARSE_SPEC), ParseError);
  });

  // -------------------------------------------------------------------
  // pool.js
  // -------------------------------------------------------------------

  await check('runLimited: bounds concurrency and preserves output order', async () => {
    const items = [5, 4, 3, 2, 1];
    const results = new Array(items.length);
    let concurrent = 0;
    let maxConcurrent = 0;
    await runLimited(items, 2, async (item, i) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, item));
      results[i] = item;
      concurrent--;
    });
    assert.deepEqual(results, items);
    assert.ok(maxConcurrent <= 2, `expected max concurrency <= 2, got ${maxConcurrent}`);
  });

  await check('runLimited: a rejecting worker does not abandon siblings', async () => {
    const items = [1, 2, 3];
    const results = new Array(items.length);
    await runLimited(items, 2, async (item, i) => {
      if (item === 2) {
        results[i] = 'errored';
        return;
      }
      results[i] = item;
    });
    assert.deepEqual(results, [1, 'errored', 3]);
  });

  // -------------------------------------------------------------------
  // commands/serve.js -- real Unix socket, mocked S3, in-process (not a
  // spawned child process, so the S3Client.prototype.send patch above
  // still applies -- same "mock at the SDK layer" spirit as
  // plugins/yarn-plugin-yarnstatic-s3/test/smoke.js). SIGINT is delivered
  // via process.emit('SIGINT') rather than a real OS signal -- this
  // synchronously invokes the same registered listener a real signal
  // would, without relying on OS signal delivery timing in a test.
  // -------------------------------------------------------------------

  await check('serve: greeting + successful fetch framing, then graceful SIGINT shutdown', async () => {
    const {runServe} = require('../src/commands/serve');
    const socketPath = path.join(os.tmpdir(), `yarnstatic-test-${process.pid}-${Date.now()}.sock`);

    const tarballBytes = Buffer.from('fake tarball bytes');
    sendImpl = async () => ({
      Body: (async function* () { yield tarballBytes; })(),
    });

    const servePromise = runServe(['--bucket', 'test-bucket', '--socket', socketPath]);

    // Poll for the socket file to appear rather than assuming a fixed delay.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error('serve did not create its socket in time');
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const received = await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
      });
      socket.on('connect', () => {
        socket.write('{"package": "lodash@4.17.21", "ver": "1.0"}\n');
      });
      socket.on('end', () => resolve(buffer));
      socket.on('error', reject);
    });

    const text = received.toString('utf8');
    const firstNl = text.indexOf('\n');
    const secondNl = text.indexOf('\n', firstNl + 1);
    const greetingLine = JSON.parse(text.slice(0, firstNl));
    const responseLine = JSON.parse(text.slice(firstNl + 1, secondNl));
    assert.deepEqual(greetingLine, {ok: true, ver: '1.0', ready: true});
    assert.equal(responseLine.ok, true);
    assert.equal(responseLine.length, tarballBytes.length);
    const bodyStart = secondNl + 1;
    const body = Buffer.from(text.slice(bodyStart), 'binary');
    assert.equal(body.length, tarballBytes.length);

    process.emit('SIGINT');
    const exitCode = await servePromise;
    assert.equal(exitCode, config.exitOK);
    assert.equal(fs.existsSync(socketPath), false, 'socket file should be removed after shutdown');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
