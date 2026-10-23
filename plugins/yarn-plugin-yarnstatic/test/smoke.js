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
  resolveBinary,
  startDaemon,
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

  await check('parseTarballUrl: a registry with a path of its own, unscoped', () => {
    assert.equal(
      parseTarballUrl('https://host.example/artifactory/api/npm/npm-remote/lodash/-/lodash-4.17.21.tgz'),
      'lodash@4.17.21',
    );
  });

  await check('parseTarballUrl: a registry with a path of its own, scoped, %2f-encoded', () => {
    assert.equal(
      parseTarballUrl('https://host.example/artifactory/api/npm/npm-remote/@babel%2fcore/-/core-7.20.0.tgz'),
      '@babel/core@7.20.0',
    );
  });

  await check('parseTarballUrl: a registry with a path of its own, scoped, unencoded slash', () => {
    assert.equal(
      parseTarballUrl('https://host.example/registry/@babel/core/-/core-7.20.0.tgz'),
      '@babel/core@7.20.0',
    );
  });

  await check('parseTarballUrl: a registry path containing "/-/" splits at the last one', () => {
    assert.equal(
      parseTarballUrl('https://host.example/-/mirror/lodash/-/lodash-4.17.21.tgz'),
      'lodash@4.17.21',
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

  // --- resolveBinary() -------------------------------------------------------

  // Runs fn with YARNSTATIC_BIN/GOBIN/GOPATH unset and HOME pointed at an
  // empty dir, so only the project-local candidate can match.
  async function withIsolatedBinEnv(fn) {
    const saved = {};
    for (const k of ['YARNSTATIC_BIN', 'GOBIN', 'GOPATH', 'HOME']) saved[k] = process.env[k];
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-smoke-home-'));
    delete process.env.YARNSTATIC_BIN;
    delete process.env.GOBIN;
    delete process.env.GOPATH;
    process.env.HOME = emptyHome;
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(emptyHome, {recursive: true, force: true});
    }
  }

  function makeProject(binTarget) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-smoke-proj-'));
    const target = path.join(root, 'node_modules', binTarget);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, '#!/bin/sh\n', {mode: 0o755});
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), {recursive: true});
    fs.symlinkSync(path.join('..', binTarget), path.join(root, 'node_modules', '.bin', 'yarnstatic'));
    return root;
  }

  await check('resolveBinary: accepts node_modules/.bin/yarnstatic when it resolves into @fortmesa/yarnstatic', async () => {
    await withIsolatedBinEnv(() => {
      const root = makeProject(path.join('@fortmesa', 'yarnstatic', 'bin', 'yarnstatic.js'));
      try {
        assert.equal(resolveBinary(root), path.join(root, 'node_modules', '.bin', 'yarnstatic'));
      } finally {
        fs.rmSync(root, {recursive: true, force: true});
      }
    });
  });

  await check('resolveBinary: skips node_modules/.bin/yarnstatic pointing at any other package', async () => {
    await withIsolatedBinEnv(() => {
      const root = makeProject(path.join('evil', 'bin.js'));
      try {
        // Present but unrelated: the bin must not be accepted just because
        // @fortmesa/yarnstatic is also installed.
        fs.mkdirSync(path.join(root, 'node_modules', '@fortmesa', 'yarnstatic'), {recursive: true});
        assert.equal(resolveBinary(root), 'yarnstatic');
      } finally {
        fs.rmSync(root, {recursive: true, force: true});
      }
    });
  });

  // --- startDaemon() readiness probe -------------------------------------
  // YARNSTATIC_BIN points at a stub "daemon" that listens on the socket it
  // is given; no real yarnstatic binary or S3 is involved.

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-smoke-stub-'));
  const stubPath = path.join(stubDir, 'stub-daemon');
  fs.writeFileSync(stubPath, `#!${process.execPath}
const fs = require('fs');
const net = require('net');
const sock = process.argv[process.argv.indexOf('--socket') + 1];
if (process.env.STUB_OUT) fs.writeFileSync(process.env.STUB_OUT, sock);
let n = 0;
net.createServer((c) => {
  n++;
  if (process.env.STUB_MODE === 'silent') return;
  if (n <= 2) { c.end('{"ok":true'); return; }
  c.end('{"ok":true,"ver":"1.0","ready":true}\\n');
}).listen(sock);
setTimeout(() => process.exit(0), 5000);
`, {mode: 0o755});

  async function withStub(mode, fn) {
    const saved = {YARNSTATIC_BIN: process.env.YARNSTATIC_BIN, STUB_MODE: process.env.STUB_MODE, STUB_OUT: process.env.STUB_OUT};
    process.env.YARNSTATIC_BIN = stubPath;
    process.env.STUB_MODE = mode;
    process.env.STUB_OUT = path.join(stubDir, `socket-${mode}`);
    try {
      await fn(process.env.STUB_OUT);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  await check('startDaemon: a listener that accepts but never sends a greeting fails at the deadline', async () => {
    await withStub('silent', async (outFile) => {
      const started = Date.now();
      await assert.rejects(startDaemon(null, {readyTimeoutMs: 400}), /did not become ready within 400ms/);
      assert.ok(Date.now() - started < 3000, 'probe should not wait past its deadline');
      const sock = fs.readFileSync(outFile, 'utf8');
      assert.equal(path.basename(sock), 'daemon.sock');
      assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
    });
  });

  await check('startDaemon: connections that end before a full greeting line are retried', async () => {
    await withStub('flaky', async () => {
      const {socketPath, child} = await startDaemon(null, {readyTimeoutMs: 3000});
      child.kill();
      assert.equal(path.basename(socketPath), 'daemon.sock');
    });
  });

  fs.rmSync(stubDir, {recursive: true, force: true});

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
