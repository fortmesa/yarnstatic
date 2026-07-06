'use strict';

// Manual smoke test -- no framework, matching this org's house style (see
// e.g. verdaccio-security-filter/test/smoke.js). sources/index.js is a
// plain, @yarnpkg/builder-compatible module now (no hand-authored factory
// wrapper -- see that file's own header comment for why), so this just
// requires it directly and reads the pure helper functions off its
// module-level `_test` key, matching
// ../yarn-plugin-yarnstatic-s3/test/smoke.js's own convention.
//
// The tarballKey/splitPackageSpec cases are ported literally from
// yarnstatic/internal/verdaccio/key_test.go's TestTarballKey/
// TestSplitIdentAndSuffix/TestSplitIdent -- same source
// ../yarn-plugin-yarnstatic-s3's own port is checked against.
//
// Run with:
//   node test/smoke.js

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const pluginPath = path.join(__dirname, '..', 'sources', 'index.js');
const pluginModule = require(pluginPath);
const {
  parseVersion,
  compareVersions,
  checkGreeting,
  parseTarballUrl,
  scopeOf,
  splitPackageSpec,
  tarballKey,
  resolveAwsCliConfig,
  DEFAULT_KEY_PREFIX,
} = pluginModule._test;

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

  // --- parseVersion() / compareVersions() ----------------------------------

  await check('parseVersion: reads only major.minor, ignoring a third component', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2]);
    assert.deepEqual(parseVersion('1.2'), [1, 2]);
  });

  await check('parseVersion: an unparseable component coalesces to 0, not NaN', () => {
    assert.deepEqual(parseVersion('x.y'), [0, 0]);
  });

  await check('compareVersions: numeric comparison, not string comparison ("1.10" > "1.9")', () => {
    assert.ok(compareVersions('1.10', '1.9') > 0);
    assert.ok(compareVersions('1.9', '1.10') < 0);
    assert.equal(compareVersions('1.0', '1.0'), 0);
  });

  // --- checkGreeting() -------------------------------------------------------

  await check('checkGreeting: a well-formed, ready greeting returns this client\'s own protocol version when compatible', () => {
    const ver = checkGreeting(JSON.stringify({ok: true, ready: true, ver: '1.0'}));
    assert.equal(ver, '1.0');
  });

  await check('checkGreeting: caps at the daemon\'s own declared version if it\'s older than this client\'s', () => {
    const ver = checkGreeting(JSON.stringify({ok: true, ready: true, ver: '0.5'}));
    assert.equal(ver, '0.5');
  });

  await check('checkGreeting: malformed JSON throws', () => {
    assert.throws(() => checkGreeting('not json'), /malformed greeting/);
  });

  await check('checkGreeting: ok:false throws (daemon not ready)', () => {
    assert.throws(() => checkGreeting(JSON.stringify({ok: false})), /did not report ready/);
  });

  await check('checkGreeting: missing/wrong-typed ver field throws', () => {
    assert.throws(() => checkGreeting(JSON.stringify({ok: true, ready: true})), /did not report ready/);
    assert.throws(() => checkGreeting(JSON.stringify({ok: true, ready: true, ver: 1})), /did not report ready/);
  });

  // --- parseTarballUrl() / scopeOf() -----------------------------------------

  await check('parseTarballUrl: an unscoped package URL', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/lodash/-/lodash-4.17.21.tgz'),
      'lodash@4.17.21',
    );
  });

  await check('parseTarballUrl: a scoped package URL, %2f-encoded (first-attempt form)', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/@babel%2fcore/-/core-7.20.0.tgz'),
      '@babel/core@7.20.0',
    );
  });

  await check('parseTarballUrl: a scoped package URL, unencoded slash (NpmSemverFetcher retry form)', () => {
    assert.equal(
      parseTarballUrl('https://registry.example/@babel/core/-/core-7.20.0.tgz'),
      '@babel/core@7.20.0',
    );
  });

  await check('parseTarballUrl: not a tarball URL at all (no /-/) returns null', () => {
    assert.equal(parseTarballUrl('https://registry.example/lodash'), null);
  });

  await check('parseTarballUrl: basename does not end in .tgz returns null', () => {
    assert.equal(parseTarballUrl('https://registry.example/lodash/-/lodash-4.17.21.zip'), null);
  });

  await check('parseTarballUrl: an unparseable URL returns null, not a throw', () => {
    assert.equal(parseTarballUrl('not a url at all'), null);
  });

  await check('scopeOf: extracts the scope (without "@") from a scoped spec', () => {
    assert.equal(scopeOf('@babel/core@7.20.0'), 'babel');
  });

  await check('scopeOf: null for an unscoped spec', () => {
    assert.equal(scopeOf('lodash@4.17.21'), null);
  });

  // --- splitPackageSpec() -- ported from key_test.go's
  // TestSplitIdentAndSuffix/TestSplitIdent ------------------------------------

  await check('splitPackageSpec: unscoped', () => {
    assert.deepEqual(splitPackageSpec('lodash@4.17.21'), {scope: null, name: 'lodash', version: '4.17.21'});
  });

  await check('splitPackageSpec: scoped', () => {
    assert.deepEqual(splitPackageSpec('@babel/core@7.20.0'), {scope: 'babel', name: 'core', version: '7.20.0'});
  });

  await check('splitPackageSpec: no version returns null', () => {
    assert.equal(splitPackageSpec('lodash'), null);
  });

  await check('splitPackageSpec: scoped with no version returns null', () => {
    assert.equal(splitPackageSpec('@babel/core'), null);
  });

  await check('splitPackageSpec: this is exactly what parseTarballUrl\'s own output round-trips through', () => {
    const spec = parseTarballUrl('https://registry.example/@acme%2fwidgets/-/widgets-2.1.0.tgz');
    assert.deepEqual(splitPackageSpec(spec), {scope: 'acme', name: 'widgets', version: '2.1.0'});
  });

  // --- tarballKey() -- ported literally from
  // internal/verdaccio/key_test.go's TestTarballKey --------------------------

  await check('tarballKey: unscoped, no prefix', () => {
    assert.equal(tarballKey('', {scope: null, name: 'lodash', version: '4.17.21'}, ''), 'lodash/lodash-4.17.21.tgz');
  });

  await check('tarballKey: scoped, no prefix', () => {
    assert.equal(tarballKey('', {scope: 'babel', name: 'core', version: '7.20.0'}, ''), '@babel/core/core-7.20.0.tgz');
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

  // --- resolveAwsCliConfig() -------------------------------------------------

  await check('resolveAwsCliConfig: defaults keyPrefix to DEFAULT_KEY_PREFIX when unset', () => {
    delete process.env.YARNSTATIC_KEY_PREFIX;
    process.env.YARNSTATIC_BUCKET = 'my-bucket';
    try {
      const config = resolveAwsCliConfig();
      assert.equal(config.bucket, 'my-bucket');
      assert.equal(config.keyPrefix, DEFAULT_KEY_PREFIX);
      assert.equal(config.region, '');
      assert.equal(config.endpoint, '');
      assert.equal(config.profile, '');
    } finally {
      delete process.env.YARNSTATIC_BUCKET;
    }
  });

  await check('resolveAwsCliConfig: reads region/profile/endpoint/keyPrefix from env when set', () => {
    process.env.YARNSTATIC_BUCKET = 'my-bucket';
    process.env.YARNSTATIC_KEY_PREFIX = 'custom';
    process.env.YARNSTATIC_REGION = 'us-west-2';
    process.env.YARNSTATIC_PROFILE = 'my-profile';
    process.env.YARNSTATIC_ENDPOINT = 'http://localhost:9000';
    try {
      const config = resolveAwsCliConfig();
      assert.equal(config.keyPrefix, 'custom');
      assert.equal(config.region, 'us-west-2');
      assert.equal(config.profile, 'my-profile');
      assert.equal(config.endpoint, 'http://localhost:9000');
    } finally {
      delete process.env.YARNSTATIC_BUCKET;
      delete process.env.YARNSTATIC_KEY_PREFIX;
      delete process.env.YARNSTATIC_REGION;
      delete process.env.YARNSTATIC_PROFILE;
      delete process.env.YARNSTATIC_ENDPOINT;
    }
  });

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
