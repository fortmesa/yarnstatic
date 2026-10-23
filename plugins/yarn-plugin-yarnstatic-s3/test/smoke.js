'use strict';

// Manual smoke test -- no framework, matching this org's house style (see
// e.g. verdaccio-security-filter/test/smoke.js). Exercises sources/index.js
// directly via its test-only `_test` export (pure functions) plus the real
// `default.hooks.wrapNetworkRequest` entry point (with S3Client.send()
// mocked -- no real AWS calls, no real network).
//
// The tarballKey cases are ported literally from
// yarnstatic/internal/verdaccio/key_test.go's TestTarballKey -- same
// scenarios, same expected keys -- since this plugin's own tarballKey() is
// meant to compute byte-for-byte the same S3 key the real Go tool does for
// a given package/prefix/storageFolder. See sources/index.js's own
// _test export comment.
//
// Run with:
//   node test/smoke.js

const assert = require('node:assert/strict');
const path = require('node:path');

// Must happen BEFORE requiring sources/index.js: Node's require cache means
// the plugin's own `require('@aws-sdk/client-s3')` resolves to this same,
// already-patched module instance, so no real network call ever happens.
const {S3Client} = require('../node_modules/@aws-sdk/client-s3');
let lastCommand = null;
let sendShouldThrow = null; // set per-test to simulate a specific S3 outcome
S3Client.prototype.send = async function (command) {
  lastCommand = command;
  if (sendShouldThrow) throw sendShouldThrow;
  return {Body: (async function* () {})()}; // empty stream by default
};

const pluginPath = path.join(__dirname, '..', 'sources', 'index.js');
const plugin = require(pluginPath);
const {
  resolveSetting,
  resolveS3Config,
  tarballKey,
  parseTarballUrl,
  isNotFound,
  isAccessDenied,
  DEFAULT_KEY_PREFIX,
} = plugin._test;

function fakeConfiguration(overrides, scopeStorageMap) {
  const scopeStorage = new Map(Object.entries(scopeStorageMap || {}));
  return {
    get(key) {
      if (key === 'yarnstaticScopeStorage') return scopeStorage;
      return overrides[key] ?? '';
    },
  };
}

async function main() {
  let passed = 0;

  async function check(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`PASS: ${name}`);
    } catch (err) {
      console.error(`FAIL: ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  // --- resolveSetting() / resolveS3Config() -- ported from
  // cmd/yarnstatic/config.go's resolveFlag()/commonFlags.resolve() ---------

  await check('resolveSetting: env var wins over the .yarnrc.yml setting when both are present', () => {
    process.env.YARNSTATIC_TEST_VAR = 'from-env';
    try {
      const config = fakeConfiguration({yarnstaticTestVar: 'from-config'});
      assert.equal(resolveSetting(config, 'YARNSTATIC_TEST_VAR', 'yarnstaticTestVar'), 'from-env');
    } finally {
      delete process.env.YARNSTATIC_TEST_VAR;
    }
  });

  await check('resolveSetting: falls back to the .yarnrc.yml setting when no env var is set', () => {
    const config = fakeConfiguration({yarnstaticTestVar: 'from-config'});
    assert.equal(resolveSetting(config, 'YARNSTATIC_TEST_VAR', 'yarnstaticTestVar'), 'from-config');
  });

  await check('resolveSetting: empty string when neither source is set', () => {
    const config = fakeConfiguration({});
    assert.equal(resolveSetting(config, 'YARNSTATIC_TEST_VAR', 'yarnstaticTestVar'), '');
  });

  await check('resolveS3Config: an empty keyPrefix from both sources falls back to DEFAULT_KEY_PREFIX', () => {
    const config = fakeConfiguration({yarnstaticBucket: 'my-bucket'});
    const result = resolveS3Config(config);
    assert.equal(result.bucket, 'my-bucket');
    assert.equal(result.keyPrefix, DEFAULT_KEY_PREFIX);
    assert.equal(result.region, '');
    assert.equal(result.endpoint, '');
    assert.equal(result.profile, '');
  });

  await check('resolveS3Config: an explicitly configured keyPrefix is used as-is, not defaulted', () => {
    const config = fakeConfiguration({yarnstaticBucket: 'my-bucket', yarnstaticKeyPrefix: 'custom'});
    assert.equal(resolveS3Config(config).keyPrefix, 'custom');
  });

  // --- tarballKey() -- ported literally from
  // internal/verdaccio/key_test.go's TestTarballKey ------------------------

  await check('tarballKey: unscoped, no prefix', () => {
    assert.equal(
      tarballKey('', {scope: null, name: 'lodash', version: '4.17.21'}, ''),
      'lodash/lodash-4.17.21.tgz',
    );
  });

  await check('tarballKey: scoped, no prefix', () => {
    assert.equal(
      tarballKey('', {scope: 'babel', name: 'core', version: '7.20.0'}, ''),
      '@babel/core/core-7.20.0.tgz',
    );
  });

  await check('tarballKey: unscoped, prefix with no trailing slash', () => {
    assert.equal(
      tarballKey('registry', {scope: null, name: 'lodash', version: '4.17.21'}, ''),
      'registry/lodash/lodash-4.17.21.tgz',
    );
  });

  await check('tarballKey: unscoped, prefix with a trailing slash already', () => {
    assert.equal(
      tarballKey('registry/', {scope: null, name: 'lodash', version: '4.17.21'}, ''),
      'registry/lodash/lodash-4.17.21.tgz',
    );
  });

  await check('tarballKey: scoped, with prefix', () => {
    assert.equal(
      tarballKey('registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, ''),
      'registry/@acme/widgets/widgets-2.1.0.tgz',
    );
  });

  await check('tarballKey: scoped, with prefix and a storage folder', () => {
    assert.equal(
      tarballKey('registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage'),
      'registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz',
    );
  });

  await check('tarballKey: scoped, with a storage folder but no prefix', () => {
    assert.equal(
      tarballKey('', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage'),
      'acme-storage/@acme/widgets/widgets-2.1.0.tgz',
    );
  });

  await check('tarballKey: unscoped, with prefix and a storage folder', () => {
    assert.equal(
      tarballKey('registry/', {scope: null, name: 'lodash', version: '4.17.21'}, 'legacy'),
      'registry/legacy/lodash/lodash-4.17.21.tgz',
    );
  });

  await check('tarballKey: a storage folder that already has a trailing slash is not doubled', () => {
    assert.equal(
      tarballKey('registry/', {scope: 'acme', name: 'widgets', version: '2.1.0'}, 'acme-storage/'),
      'registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz',
    );
  });

  // --- parseTarballUrl() ---------------------------------------------------

  await check('parseTarballUrl: an unscoped package URL', () => {
    assert.deepEqual(
      parseTarballUrl('https://registry.example/lodash/-/lodash-4.17.21.tgz'),
      {scope: null, name: 'lodash', version: '4.17.21'},
    );
  });

  await check('parseTarballUrl: a scoped package URL, %2f-encoded (first-attempt form)', () => {
    assert.deepEqual(
      parseTarballUrl('https://registry.example/@babel%2fcore/-/core-7.20.0.tgz'),
      {scope: 'babel', name: 'core', version: '7.20.0'},
    );
  });

  await check('parseTarballUrl: a scoped package URL, unencoded slash (NpmSemverFetcher retry form)', () => {
    assert.deepEqual(
      parseTarballUrl('https://registry.example/@babel/core/-/core-7.20.0.tgz'),
      {scope: 'babel', name: 'core', version: '7.20.0'},
    );
  });

  await check('parseTarballUrl: a registry with a path of its own, unscoped', () => {
    assert.deepEqual(
      parseTarballUrl('https://host.example/artifactory/api/npm/npm-remote/lodash/-/lodash-4.17.21.tgz'),
      {scope: null, name: 'lodash', version: '4.17.21'},
    );
  });

  await check('parseTarballUrl: a registry with a path of its own, scoped, %2f-encoded', () => {
    assert.deepEqual(
      parseTarballUrl('https://host.example/artifactory/api/npm/npm-remote/@babel%2fcore/-/core-7.20.0.tgz'),
      {scope: 'babel', name: 'core', version: '7.20.0'},
    );
  });

  await check('parseTarballUrl: a registry with a path of its own, scoped, unencoded slash', () => {
    assert.deepEqual(
      parseTarballUrl('https://host.example/registry/@babel/core/-/core-7.20.0.tgz'),
      {scope: 'babel', name: 'core', version: '7.20.0'},
    );
  });

  await check('parseTarballUrl: a registry path containing "/-/" splits at the last one', () => {
    assert.deepEqual(
      parseTarballUrl('https://host.example/-/mirror/lodash/-/lodash-4.17.21.tgz'),
      {scope: null, name: 'lodash', version: '4.17.21'},
    );
  });

  await check('parseTarballUrl: an empty ident or an empty scope returns null', () => {
    assert.equal(parseTarballUrl('https://registry.example/-/lodash-4.17.21.tgz'), null);
    assert.equal(parseTarballUrl('https://registry.example/@/core/-/core-7.20.0.tgz'), null);
  });

  await check('parseTarballUrl: bad percent-encoding returns null', () => {
    assert.equal(parseTarballUrl('https://registry.example/lo%zzdash/-/lo%zzdash-1.0.0.tgz'), null);
  });

  await check('parseTarballUrl: not a tarball URL at all (no /-/) returns null', () => {
    assert.equal(parseTarballUrl('https://registry.example/lodash'), null);
  });

  await check('parseTarballUrl: basename does not end in .tgz returns null', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/lodash/-/lodash-4.17.21.zip'),
      null,
    );
  });

  await check('parseTarballUrl: basename does not start with "name-" returns null', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/lodash/-/other-4.17.21.tgz'),
      null,
    );
  });

  await check('parseTarballUrl: an unparseable URL returns null, not a throw', () => {
    assert.equal(parseTarballUrl('not a url at all'), null);
  });

  await check('parseTarballUrl: a scoped ident with no slash after "@" returns null', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/@justscope/-/justscope-1.0.0.tgz'),
      null,
    );
  });

  // --- isNotFound() / isAccessDenied() -- ported from
  // internal/s3client/client.go's IsNotFound/IsAccessDenied ----------------

  await check('isNotFound: recognizes NoSuchKey and NotFound error names', () => {
    assert.equal(isNotFound({name: 'NoSuchKey'}), true);
    assert.equal(isNotFound({name: 'NotFound'}), true);
    assert.equal(isNotFound({Code: 'NoSuchKey'}), true);
    assert.equal(isNotFound({$metadata: {httpStatusCode: 404}}), true);
    assert.equal(isNotFound({name: 'SomethingElse'}), false);
  });

  await check('isAccessDenied: recognizes the real credential/permission error codes', () => {
    for (const code of ['AccessDenied', 'Forbidden', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']) {
      assert.equal(isAccessDenied({name: code}), true);
    }
    assert.equal(isAccessDenied({name: 'NoSuchKey'}), false);
  });

  // --- wrapNetworkRequest() hook -- end-to-end through the real plugin
  // export, with S3Client.send() mocked -----------------------------------

  await check('wrapNetworkRequest: disabled (no bucket configured) is a pure passthrough', async () => {
    const passthroughExecutor = async () => ({body: Buffer.from('real'), statusCode: 200, headers: {}});
    const configuration = fakeConfiguration({});
    const wrapped = await plugin.default.hooks.wrapNetworkRequest(passthroughExecutor, {
      target: 'https://registry.example/lodash/-/lodash-4.17.21.tgz',
      configuration,
    });
    assert.equal(wrapped, passthroughExecutor, 'must return the original executor unchanged, not a new function');
  });

  await check('wrapNetworkRequest: enabled, but a non-tarball URL is blocked rather than let through', async () => {
    const configuration = fakeConfiguration({yarnstaticBucket: 'my-bucket'});
    const wrapped = await plugin.default.hooks.wrapNetworkRequest(async () => {
      throw new Error('the real network must never be reached once this plugin is enabled');
    }, {
      target: 'https://registry.example/-/ping',
      configuration,
    });
    await assert.rejects(() => wrapped(), /blocked network request/);
  });

  await check('wrapNetworkRequest: enabled, a recognized tarball URL issues a GetObjectCommand with the right key', async () => {
    sendShouldThrow = null;
    lastCommand = null;
    const configuration = fakeConfiguration(
      {yarnstaticBucket: 'my-bucket', yarnstaticKeyPrefix: 'registry'},
      {acme: 'acme-storage'},
    );
    const wrapped = await plugin.default.hooks.wrapNetworkRequest(async () => {
      throw new Error('must not fall through to the real network once a key was resolved');
    }, {
      target: 'https://registry.example/@acme%2fwidgets/-/widgets-2.1.0.tgz',
      configuration,
    });
    await wrapped();
    assert.equal(lastCommand.input.Bucket, 'my-bucket');
    assert.equal(lastCommand.input.Key, 'registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz');
  });

  await check('wrapNetworkRequest: a genuine S3 404 surfaces as a clear "not found" error', async () => {
    const notFoundErr = new Error('NoSuchKey');
    notFoundErr.name = 'NoSuchKey';
    sendShouldThrow = notFoundErr;
    const configuration = fakeConfiguration({yarnstaticBucket: 'my-bucket'});
    const wrapped = await plugin.default.hooks.wrapNetworkRequest(async () => {
      throw new Error('unreachable');
    }, {
      target: 'https://registry.example/lodash/-/lodash-4.17.21.tgz',
      configuration,
    });
    await assert.rejects(() => wrapped(), /not found: verdaccio\/lodash\/lodash-4\.17\.21\.tgz/);
    sendShouldThrow = null;
  });

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
