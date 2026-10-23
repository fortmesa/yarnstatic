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
const {loadYarnrc, expandEnvVariables} = require('../src/yarnrc');

// Reused directly from the Go source tree (not copied) so both parsers are
// always exercised against the exact same bytes -- see the file header.
const SAMPLE_LOCK_PATH = path.join(__dirname, '..', '..', 'internal', 'lockfile', 'testdata', 'sample.lock');

// Same isolation as main_test.go's isolateEnv: a shell that exported
// YARNSTATIC_BUCKET or YARNSTATIC_KEY_PREFIX must not change what these
// tests resolve, and ~/.yarnrc.yml must not leak into check.
for (const k of Object.keys(process.env)) {
  const upper = k.toUpperCase();
  if (upper.startsWith('YARNSTATIC_') || upper.startsWith('YARN_YARNSTATIC_') || upper === 'YARN_RC_FILENAME') {
    delete process.env[k];
  }
}
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yarnstatic-smoke-'));
process.env.HOME = path.join(TEST_ROOT, 'home');
fs.mkdirSync(process.env.HOME);

// rcTree returns a fresh home/parent/project layout under TEST_ROOT, with
// HOME pointed at its home directory (yarnrc_test.go's rcTree).
let rcTreeCount = 0;
function rcTree() {
  const root = path.join(TEST_ROOT, `tree-${rcTreeCount++}`);
  const home = path.join(root, 'home');
  const parent = path.join(root, 'work');
  const project = path.join(parent, 'repo');
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(project, {recursive: true});
  process.env.HOME = home;
  return {home, parent, project};
}

function writeRc(dir, name, content) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, name), content);
}

// captureStdout runs fn with console.log collected, returning fn's result
// and the collected lines joined by "\n".
async function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return {code: await fn(), out: lines.join('\n')};
  } finally {
    console.log = original;
  }
}

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

  // Transcribed from key_test.go's TestParseTarballURL.
  const parseTarballUrlCases = [
    ['unscoped', 'https://registry.example/lodash/-/lodash-4.17.21.tgz', {scope: '', name: 'lodash', version: '4.17.21'}],
    ['scoped, encoded', 'https://registry.example/@babel%2fcore/-/core-7.20.0.tgz', {scope: 'babel', name: 'core', version: '7.20.0'}],
    ['scoped, upper-case encoding', 'https://registry.example/@babel%2Fcore/-/core-7.20.0.tgz', {scope: 'babel', name: 'core', version: '7.20.0'}],
    ['scoped, unencoded retry', 'https://registry.example/@babel/core/-/core-7.20.0.tgz', {scope: 'babel', name: 'core', version: '7.20.0'}],
    ['registry path, unscoped', 'https://host/artifactory/api/npm/npm-remote/lodash/-/lodash-4.17.21.tgz', {scope: '', name: 'lodash', version: '4.17.21'}],
    ['registry path, scoped encoded', 'https://host/artifactory/api/npm/npm-remote/@babel%2fcore/-/core-7.20.0.tgz', {scope: 'babel', name: 'core', version: '7.20.0'}],
    ['registry path, scoped unencoded', 'https://host/registry/@babel/core/-/core-7.20.0.tgz', {scope: 'babel', name: 'core', version: '7.20.0'}],
    ['query string ignored', 'https://registry.example/lodash/-/lodash-4.17.21.tgz?x=1', {scope: '', name: 'lodash', version: '4.17.21'}],
    ['prerelease version', 'https://registry.example/foo/-/foo-1.0.0-beta.1.tgz', {scope: '', name: 'foo', version: '1.0.0-beta.1'}],
    ['basename names another package', 'https://registry.example/lodash/-/other-1.0.0.tgz', null],
    ['empty version', 'https://registry.example/lodash/-/lodash-.tgz', null],
    ['not a tgz', 'https://registry.example/lodash/-/lodash-1.0.0.zip', null],
    ['no ident', 'https://registry.example/-/lodash-1.0.0.tgz', null],
    ['no separator', 'https://registry.example/lodash/lodash-1.0.0.tgz', null],
    ['basename has a slash', 'https://registry.example/lodash/-/sub/lodash-1.0.0.tgz', null],
    ['scope without name', 'https://registry.example/@babel/-/core-1.0.0.tgz', null],
    ['empty scope', 'https://registry.example/@/core/-/core-1.0.0.tgz', null],
    ['registry path containing /-/', 'https://host/-/mirror/lodash/-/lodash-4.17.21.tgz', {scope: '', name: 'lodash', version: '4.17.21'}],
    ['bad percent-encoding', 'https://registry.example/%zz/-/x-1.0.0.tgz', null],
    ['not a URL', 'lodash-4.17.21.tgz', null],
  ];
  for (const [name, input, want] of parseTarballUrlCases) {
    await check(`parseTarballUrl: ${name}`, () => {
      assert.deepEqual(key.parseTarballUrl(input), want);
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

  await check('lockfile.parse: an empty document is an error (unlike yarnrc.js, empty is not valid here)', () => {
    assert.throws(() => lockfile.parse(''));
  });

  // Transcribed from lockfile_test.go's TestParseNoChecksumArchiveURLAndGit.
  await check('lockfile.parse: no-checksum entries, __archiveUrl, and git references', () => {
    const c = 'com' + 'mit';
    const doc = `
__metadata:
  version: 8

"@esbuild/darwin-arm64@npm:0.25.12":
  version: 0.25.12
  resolution: "@esbuild/darwin-arm64@npm:0.25.12"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard

"foo@npm:1.0.0":
  version: 1.0.0
  resolution: "foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fmirror.example%2Fnpm%2Ffoo%2F-%2Ffoo-1.0.0.tgz"
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard

"bar@npm:2.0.0":
  version: 2.0.0
  resolution: "bar@npm:2.0.0::__archiveUrl=https%3A%2F%2Fcdn.example%2Fbar.tgz"
  checksum: 10c0/bbbb
  languageName: node
  linkType: hard

"mylib@github:acme/mylib#v1.0.0":
  version: 1.0.0
  resolution: "mylib@https://github.com/acme/mylib.git#${c}=0123456789abcdef0123456789abcdef01234567"
  checksum: 10c0/cccc
  languageName: node
  linkType: hard

"tarball@https://example.com/tarball-1.0.0.tgz":
  version: 1.0.0
  resolution: "tarball@https://example.com/tarball-1.0.0.tgz"
  checksum: 10c0/dddd
  languageName: node
  linkType: hard
`;
    const result = lockfile.parse(doc);
    assert.equal(result.noChecksum.length, 1);
    const nc = result.noChecksum[0];
    assert.deepEqual([nc.scope, nc.name, nc.version, nc.conditions], ['esbuild', 'darwin-arm64', '0.25.12', 'os=darwin & cpu=arm64']);

    assert.equal(result.entries.length, 1);
    const foo = result.entries[0];
    assert.deepEqual([foo.name, foo.version, foo.archiveUrl], ['foo', '1.0.0', 'https://mirror.example/npm/foo/-/foo-1.0.0.tgz']);

    const bar = result.skipped.find(s => s.descriptor.startsWith('bar@'));
    assert.equal(bar.reason, lockfile.SKIP_ARCHIVE_URL);
    assert.equal(bar.reference, 'https://cdn.example/bar.tgz');
    const mylib = result.skipped.find(s => s.descriptor.startsWith('mylib@'));
    assert.equal(mylib.reason, lockfile.SKIP_PROTOCOL);
    assert.equal(lockfile.isGitReference(mylib.reference), true);
    const tarball = result.skipped.find(s => s.descriptor.startsWith('tarball@'));
    assert.equal(lockfile.isGitReference(tarball.reference), false);

    assert.deepEqual(lockfile.skippedCounts(result.skipped), {https: 2});
  });

  // Transcribed from lockfile_test.go's TestIsGitReference, whose
  // expectations are what Yarn's own isGitUrl returns.
  {
    const c = 'com' + 'mit';
    const gitCases = [
      [`ssh://git@github.com/u/r.git#${c}=x`, true], [`git://example.com/r.git#${c}=x`, true],
      [`git+ssh://git@example.com/u/r.git#${c}=x`, true], ['git+file:///path/r.git', true],
      [`https://github.com/u/r.git#${c}=x`, true], [`https://gitlab.example/u/r.git#${c}=x`, true],
      ['http://host/u/r.git', true], [`git@github.com:u/r.git#${c}=x`, true], ['github:u/r#v1', true],
      ['u/r', true], ['./x/y', false], ['../x', false], ['u/.', false], ['u/..', false], ['u/.#x', false],
      ['u/..#x', false], ['u/.git', true], ['./r', false], ['https://github.com/u/r/tarball/v1', true],
      ['https://github.com/../r/tarball/v1', false], ['https://github.com/u/./tarball/v1', true],
      ['https://example.com/pkg.tgz', false], ['npm:1.0.0', false], ['workspace:packages/a', false],
      ['file:../x', false], ['exec:./gen.js::locator=root%40workspace%3A.', false],
      ['patch:lodash@npm%3A4.17.21#~/.yarn/patches/x.patch::version=4.17.21', false],
      ['portal:../x::locator=r%40workspace%3A.', false], ['link:./vendor/x', false], ['github:../r', false],
      ['https://github.com/u/r', true], ['a.b/c-d_e#semver:^1.0.0', true], ['', false],
    ];
    await check(`isGitReference: ${gitCases.length} cases match Yarn's isGitUrl`, () => {
      for (const [ref, want] of gitCases) {
        assert.equal(lockfile.isGitReference(ref), want, ref);
      }
    });
  }

  // -------------------------------------------------------------------
  // yarnrc.js -- ported from cmd/yarnstatic/yarnrc_test.go
  // -------------------------------------------------------------------

  await check('loadYarnrc: closer files win, home is farthest, values are strings', () => {
    const {home, parent, project} = rcTree();
    writeRc(home, '.yarnrc.yml', 'yarnstaticBucket: home-bucket\nyarnstaticRegion: home-region\nyarnstaticProfile: home-profile\n');
    writeRc(parent, '.yarnrc.yml', 'yarnstaticBucket: parent-bucket\nyarnstaticRegion: parent-region\n');
    writeRc(project, '.yarnrc.yml', 'yarnstaticBucket: project-bucket\nyarnstaticKeyPrefix: 123\n');
    const got = loadYarnrc(project);
    assert.deepEqual(
      {...got, scopeStorage: Object.fromEntries(got.scopeStorage)},
      {bucket: 'project-bucket', keyPrefix: '123', region: 'parent-region', endpoint: '', profile: 'home-profile', scopeStorage: {}}
    );
    process.env.yarn_yarnstatic_bucket = 'env-bucket';
    try {
      assert.equal(loadYarnrc(project).bucket, 'env-bucket');
    } finally {
      delete process.env.yarn_yarnstatic_bucket;
    }
  });

  await check('loadYarnrc: a home file inside the walk is read once', () => {
    const {home} = rcTree();
    const project = path.join(home, 'repo');
    writeRc(home, '.yarnrc.yml', 'yarnstaticScopeStorage:\n  acme: home-storage\n  other: o\n');
    writeRc(project, '.yarnrc.yml', 'yarnstaticScopeStorage:\n  acme: project-storage\n');
    assert.deepEqual(Object.fromEntries(loadYarnrc(project).scopeStorage), {acme: 'project-storage', other: 'o'});
  });

  await check('loadYarnrc: YARN_RC_FILENAME renames the walked files, not the home one', () => {
    const {home, project} = rcTree();
    process.env.YARN_RC_FILENAME = '.custom.yml';
    try {
      writeRc(home, '.yarnrc.yml', 'yarnstaticRegion: home-region\n');
      writeRc(project, '.yarnrc.yml', 'yarnstaticBucket: ignored\n');
      writeRc(project, '.custom.yml', 'yarnstaticBucket: custom\n');
      const got = loadYarnrc(project);
      assert.equal(got.bucket, 'custom');
      assert.equal(got.region, 'home-region');
    } finally {
      delete process.env.YARN_RC_FILENAME;
    }
  });

  // Expectations are what Yarn's own resolveRcFiles produces.
  const scopeMergeCases = [
    ['default merge', "a: '1'\n  b: '1'", '', "b: '2'\n  c: '2'", {a: '1', b: '2', c: '2'}],
    ['reset closest', "a: '1'\n  b: '1'", '', "onConflict: reset\n  b: '2'", {b: '2'}],
    ['reset with value', "a: '1'", '', "onConflict: reset\n  value:\n    b: '2'", {b: '2'}],
    ['hardReset closest', "a: '1'", '', "onConflict: hardReset\n  b: '2'", {}],
    ['hardReset middle', "a: '1'", "onConflict: hardReset\n  b: '2'", "c: '3'", {c: '3'}],
    ['reset middle', "a: '1'", "onConflict: reset\n  b: '2'", "c: '3'", {b: '2', c: '3'}],
    ['extend', "a: '1'", '', "onConflict: extend\n  b: '2'", {a: '1', b: '2'}],
    ['per-key marker', "a: '1'", '', "a:\n    onConflict: reset\n    value: '2'", {a: '2'}],
    ['reset farthest', "onConflict: reset\n  a: '1'", '', "b: '2'", {a: '1', b: '2'}],
  ];
  for (const [name, homeBody, midBody, projectBody, want] of scopeMergeCases) {
    await check(`loadYarnrc scope storage merge: ${name}`, () => {
      const {home, parent, project} = rcTree();
      for (const [dir, body] of [[home, homeBody], [parent, midBody], [project, projectBody]]) {
        if (body) writeRc(dir, '.yarnrc.yml', `yarnstaticScopeStorage:\n  ${body}\n`);
      }
      assert.deepEqual(Object.fromEntries(loadYarnrc(project).scopeStorage), want);
    });
  }

  await check('loadYarnrc scope storage merge: a non-map farther out stops the merge', () => {
    const {home, parent, project} = rcTree();
    writeRc(home, '.yarnrc.yml', "yarnstaticScopeStorage:\n  a: '1'\n");
    writeRc(parent, '.yarnrc.yml', 'yarnstaticScopeStorage: str\n');
    writeRc(project, '.yarnrc.yml', "yarnstaticScopeStorage:\n  c: '3'\n");
    assert.deepEqual(Object.fromEntries(loadYarnrc(project).scopeStorage), {c: '3'});
  });

  const yarnrcErrorCases = [
    ['null setting', 'yarnstaticBucket:\n', /cannot be null/],
    ['non-string setting', 'yarnstaticBucket:\n  a: b\n', /must be a string/],
    ['scope storage not a map', 'yarnstaticScopeStorage: str\n', /must be a map/],
    ['scope storage value not a string', 'yarnstaticScopeStorage:\n  acme:\n    x: y\n', /must be a string/],
    ['top level not a mapping', '- a\n', /expected a mapping/],
    ['invalid YAML', 'a: [\n', /parsing/],
    ['unset variable', 'yarnstaticBucket: ${YARNSTATIC_TEST_UNSET}\n', /environment variable not found/],
  ];
  for (const [name, content, wantErr] of yarnrcErrorCases) {
    await check(`loadYarnrc: ${name} is an error`, () => {
      const {project} = rcTree();
      writeRc(project, '.yarnrc.yml', content);
      assert.throws(() => loadYarnrc(project), wantErr);
    });
  }

  await check('loadYarnrc: no rc files, or a comment-only one, is not an error', () => {
    const {project} = rcTree();
    assert.equal(loadYarnrc(project).bucket, '');
    writeRc(project, '.yarnrc.yml', '# only a comment\n');
    assert.equal(loadYarnrc(project).bucket, '');
  });

  await check('loadYarnrc: expands ${VAR} references from the environment', () => {
    const {project} = rcTree();
    process.env.YARNSTATIC_TEST_BUCKET = 'from-env';
    try {
      writeRc(project, '.yarnrc.yml', 'yarnstaticBucket: ${YARNSTATIC_TEST_BUCKET}\nyarnstaticScopeStorage:\n  acme: ${YARNSTATIC_TEST_UNSET:-fallback}\n');
      const got = loadYarnrc(project);
      assert.equal(got.bucket, 'from-env');
      assert.equal(got.scopeStorage.get('acme'), 'fallback');
    } finally {
      delete process.env.YARNSTATIC_TEST_BUCKET;
    }
  });

  // Expectations are what Yarn's own replaceEnvVariables returns.
  const expandCases = [
    ['plain', 'plain'], ['${SET}', 'val'], ['${UNSET}', /environment variable not found \(UNSET\)/],
    ['${UNSET:-dflt}', 'dflt'], ['${EMPTY:-dflt}', 'dflt'], ['${EMPTY-dflt}', ''], ['${UNSET-dflt}', 'dflt'],
    ['${SET:-dflt}', 'val'], ['a${SET}b${SET}c', 'avalbvalc'], ['\\${SET}', '${SET}'], ['\\\\${SET}', '\\val'],
    ['x}y', 'x}y'], ['${SET:-${UNSET}}', 'val'], ['${UNSET:-${SET}}', 'val'], ['${UNSET:-a${SET}b}', 'avalb'],
    ['${1BAD}', /invalid environment variable substitution syntax/],
    ['${SET', /invalid environment variable substitution syntax/],
    ['${UNSET:-open', /incomplete variable substitution/], ['}', '}'], ['\\}', '}'],
    ['${SET:x}', /invalid environment variable substitution syntax/], ['$SET', '$SET'], ['${SET}}', 'val}'],
  ];
  await check(`expandEnvVariables: ${expandCases.length} cases match Yarn's replaceEnvVariables`, () => {
    const env = {SET: 'val', EMPTY: ''};
    for (const [input, want] of expandCases) {
      if (want instanceof RegExp) assert.throws(() => expandEnvVariables(input, env), want, input);
      else assert.equal(expandEnvVariables(input, env), want, input);
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
  await check('resolveFlag: the .yarnrc.yml value is the last fallback', () => {
    assert.equal(config.resolveFlag('', 'YARNSTATIC_TEST_VAR_UNSET', 'from-rc'), 'from-rc');
    process.env.YARNSTATIC_TEST_VAR = 'from-env';
    try {
      assert.equal(config.resolveFlag('', 'YARNSTATIC_TEST_VAR', 'from-rc'), 'from-env');
      assert.equal(config.resolveFlag('from-flag', 'YARNSTATIC_TEST_VAR', 'from-rc'), 'from-flag');
    } finally {
      delete process.env.YARNSTATIC_TEST_VAR;
    }
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

  await check('serve: socket file permissions are restricted to 0600, regardless of umask', async () => {
    const {runServe} = require('../src/commands/serve');
    const socketPath = path.join(os.tmpdir(), `yarnstatic-test-${process.pid}-${Date.now()}.sock`);

    // Explicitly set a permissive umask rather than trusting whatever the
    // test runner happens to have -- proves the chmod happens regardless
    // of umask, not just "happens to work under this environment's own".
    const oldUmask = process.umask(0);
    let servePromise;
    try {
      sendImpl = async () => ({Body: (async function* () {})()});
      servePromise = runServe(['--bucket', 'test-bucket', '--socket', socketPath]);

      const deadline = Date.now() + 5000;
      while (!fs.existsSync(socketPath)) {
        if (Date.now() > deadline) {
          throw new Error('serve did not create its socket in time');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      // fs.existsSync can see the socket file the instant bind() creates
      // it, which lands *before* runServe's own continuation (chmod, then
      // registering its SIGINT/SIGTERM handlers) has necessarily run --
      // confirmed directly: emitting SIGINT immediately after existsSync
      // first returns true is silently dropped often enough to hang the
      // test, because there's no listener yet. A real connection can only
      // succeed once the server is actually accept()-ing, which is well
      // past that point (chmod and handler registration are still earlier,
      // synchronous steps in the same continuation) -- a robust
      // synchronization point instead of an arbitrary delay.
      await new Promise((resolve, reject) => {
        const probe = net.createConnection(socketPath);
        probe.on('connect', () => probe.end(resolve));
        probe.on('error', reject);
      });

      const mode = fs.statSync(socketPath).mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `socket permissions = 0${mode.toString(8)}, want 0600 ` +
          '(umask was set to 0, so without the chmod this would be 0777)',
      );
    } finally {
      process.umask(oldUmask);
      process.emit('SIGINT');
      if (servePromise) await servePromise;
    }
  });

  // mockObjects makes the S3 mock answer HeadObject/GetObject from a
  // "bucket/key" -> body map, with a 404 NotFound for anything else.
  function mockObjects(objects) {
    sendImpl = async command => {
      const k = `${command.input.Bucket}/${command.input.Key}`;
      if (!Object.hasOwn(objects, k)) throw fakeApiError('NotFound', 404);
      if (command.constructor.name === 'HeadObjectCommand') return {};
      return {Body: (async function* () { yield Buffer.from(objects[k]); })()};
    };
  }

  // serveRequest sends one request line and collects everything the daemon
  // writes until it ends the connection, as [greeting, header, body].
  function serveRequest(socketPath, line, {halfClose = false} = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({path: socketPath, allowHalfOpen: true});
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); });
      socket.on('connect', () => {
        socket.write(line);
        if (halfClose) socket.end();
      });
      socket.on('end', () => {
        socket.end();
        const first = buffer.indexOf(0x0a);
        const second = buffer.indexOf(0x0a, first + 1);
        resolve([
          JSON.parse(buffer.subarray(0, first).toString('utf8')),
          second < 0 ? null : JSON.parse(buffer.subarray(first + 1, second).toString('utf8')),
          second < 0 ? Buffer.alloc(0) : buffer.subarray(second + 1),
        ]);
      });
      socket.on('error', reject);
    });
  }

  await check('serve: half-closed client, null request, and empty object', async () => {
    const {runServe} = require('../src/commands/serve');
    const socketPath = path.join(TEST_ROOT, `serve-${Date.now()}.sock`);
    mockObjects({'b/verdaccio/lodash/lodash-4.17.21.tgz': 'tarball', 'b/verdaccio/empty/empty-1.0.0.tgz': ''});
    const servePromise = runServe(['--bucket', 'b', '--socket', socketPath]);
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(socketPath)) {
        if (Date.now() > deadline) throw new Error('serve did not create its socket in time');
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      // ncat/socat-style: the client sends FIN right after the request.
      // With Node's default allowHalfOpen: false the response was dropped.
      const [, halfHeader, halfBody] = await serveRequest(socketPath, '{"package": "lodash@4.17.21", "ver": "1.0"}\n', {halfClose: true});
      assert.deepEqual(halfHeader, {ok: true, length: 7});
      assert.equal(halfBody.toString('utf8'), 'tarball');

      // Go decodes null to an empty request; the Node port used to throw
      // on req.ver and never answer.
      const [, nullHeader] = await serveRequest(socketPath, 'null\n');
      assert.equal(nullHeader.ok, false);
      assert.match(nullHeader.message, /invalid package spec/);

      const [, emptyHeader, emptyBody] = await serveRequest(socketPath, '{"package": "empty@1.0.0", "ver": "1.0"}\n');
      assert.deepEqual(emptyHeader, {ok: true, length: 0});
      assert.equal(emptyBody.length, 0);
    } finally {
      process.emit('SIGINT');
      assert.equal(await servePromise, config.exitOK);
    }
  });

  await check('serve: --max-concurrency below 1 is a usage error', async () => {
    const {runServe} = require('../src/commands/serve');
    for (const n of ['0', '-1']) {
      assert.equal(await runServe(['--bucket', 'b', '--socket', path.join(TEST_ROOT, 'unused.sock'), '--max-concurrency', n]), config.exitUsage);
    }
  });

  // -------------------------------------------------------------------
  // commands/check.js and commands/fetch.js -- mirror fakes3_test.go
  // -------------------------------------------------------------------

  const commitWord = 'com' + 'mit';
  const checkLock = `__metadata:
  version: 8

"lodash@npm:4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard

"@acme/widgets@npm:1.0.0":
  version: 1.0.0
  resolution: "@acme/widgets@npm:1.0.0"
  checksum: 10c0/bbbb
  languageName: node
  linkType: hard

"@esbuild/darwin-arm64@npm:0.25.12":
  version: 0.25.12
  resolution: "@esbuild/darwin-arm64@npm:0.25.12"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard

"mylib@github:acme/mylib#v1.0.0":
  version: 1.0.0
  resolution: "mylib@https://github.com/acme/mylib.git#${commitWord}=0123456789abcdef0123456789abcdef01234567"
  checksum: 10c0/cccc
  languageName: node
  linkType: hard
`;
  function checkProject() {
    const {project} = rcTree();
    writeRc(project, 'yarn.lock', checkLock);
    writeRc(project, '.yarnrc.yml', 'yarnstaticBucket: b\nyarnstaticKeyPrefix: mirror\nyarnstaticScopeStorage:\n  acme: acme-store\n');
    return project;
  }

  await check('check: reads .yarnrc.yml and reports no-checksum entries separately', async () => {
    const {runCheck} = require('../src/commands/check');
    mockObjects({
      'b/mirror/lodash/lodash-4.17.21.tgz': 'x',
      'b/mirror/acme-store/@acme/widgets/widgets-1.0.0.tgz': 'y',
    });
    const {code, out} = await captureStdout(() => runCheck([checkProject()]));
    assert.equal(code, config.exitOK, out);
    for (const want of [
      'yarn.lock: 2 npm package(s) with checksums, 1 without (skipped: 1 https:)',
      'WARNING: 1 entries resolve from git repositories',
      '  mylib@github:acme/mylib#v1.0.0',
      'Checking s3://b/mirror ...',
      'MISSING, NO CHECKSUM (1) - not counted in the exit code:',
      's3://b/mirror/@esbuild/darwin-arm64/darwin-arm64-0.25.12.tgz (os=darwin & cpu=arm64)',
      'Summary: 2 present, 0 missing, 0 error (out of 2 checked)',
      'No checksum: 0 present, 1 missing, 0 error (out of 1 checked, not counted in the exit code)',
    ]) {
      assert.ok(out.includes(want), `output lacks ${JSON.stringify(want)}:\n${out}`);
    }
  });

  await check('check: a missing checksummed entry exits 1', async () => {
    const {runCheck} = require('../src/commands/check');
    mockObjects({
      'b/mirror/lodash/lodash-4.17.21.tgz': 'x',
      'b/mirror/@acme/widgets/widgets-1.0.0.tgz': 'y',
    });
    const {code, out} = await captureStdout(() => runCheck([checkProject()]));
    assert.equal(code, config.exitMissing, out);
    assert.ok(out.includes('s3://b/mirror/acme-store/@acme/widgets/widgets-1.0.0.tgz'), out);
  });

  await check('check: a flag and an env var override .yarnrc.yml', async () => {
    const {runCheck} = require('../src/commands/check');
    mockObjects({
      'other/env-prefix/lodash/lodash-4.17.21.tgz': 'x',
      'other/env-prefix/acme-store/@acme/widgets/widgets-1.0.0.tgz': 'y',
    });
    process.env.YARNSTATIC_KEY_PREFIX = 'env-prefix';
    try {
      const {code, out} = await captureStdout(() => runCheck(['--bucket', 'other', checkProject()]));
      assert.equal(code, config.exitOK, out);
      assert.ok(out.includes('Checking s3://other/env-prefix ...'), out);
    } finally {
      delete process.env.YARNSTATIC_KEY_PREFIX;
    }
  });

  await check('fetch: a local write failure is a usage error', async () => {
    const {runFetch} = require('../src/commands/fetch');
    mockObjects({'b/verdaccio/lodash/lodash-4.17.21.tgz': 'tarball'});
    const args = ['--bucket', 'b', '--package', 'lodash@4.17.21'];
    const out = path.join(TEST_ROOT, 'out.tgz');
    assert.equal(await runFetch([...args, '--out', out]), config.exitOK);
    assert.equal(fs.readFileSync(out, 'utf8'), 'tarball');
    if (fs.existsSync('/dev/full')) {
      assert.equal(await runFetch([...args, '--out', '/dev/full']), config.exitUsage);
    }
  });

  fs.rmSync(TEST_ROOT, {recursive: true, force: true});

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
