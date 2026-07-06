'use strict';

// Drives REAL yarn 3.x/4.x binaries (via corepack) against a real,
// throwaway project with this plugin's real built bundle imported -- not a
// simulated wrapNetworkRequest call. Separate from test/smoke.js (which
// mocks S3Client.send() and is fast) since this installs/activates real
// yarn releases and makes a real network call for package metadata.
//
// Yarn 2.x is deliberately NOT tested here -- confirmed directly (0 matches
// for "wrapNetworkRequest" in yarn 2.4.3's own bundled yarn.js, vs 1 in
// 3.8.7 and 2 in 4.17.0) that the one hook this plugin's whole interception
// scheme depends on doesn't exist there at all. `yarn plugin import` still
// SUCCEEDS on 2.x with no error -- a silent no-op, not a loud failure -- but
// 2.x support isn't a real requirement here, so this isn't spending real
// CI time on a version that was never going to be supported regardless of
// whether that no-op is silent or loud.
//
// Test design matches this plugin's actual intended usage -- confirmed
// directly via a first, wrong attempt at this test: wrapNetworkRequest
// wraps EVERY network request yarn makes, not just tarball fetches, and
// this plugin (like ../yarn-plugin-yarnstatic) deliberately blocks anything
// that isn't a recognized tarball URL once enabled. `yarn add <new pkg>`
// needs a real metadata/resolution network call first (there's no lockfile
// entry for it yet) -- with the plugin enabled, that call gets blocked
// immediately, before a tarball fetch is ever attempted, which is a
// misleading way to test this: it doesn't exercise the actual interception
// this plugin exists for. The real intended usage (see the file-level
// comment in sources/index.js) is `yarn install --immutable` against an
// ALREADY-fully-resolved lockfile, where yarn makes no metadata requests at
// all -- only tarball fetches for whatever isn't already cached. So this
// test does the same, in two real phases:
//   1. `yarn add` the test package with the plugin NOT enabled -- a normal,
//      real resolution against the real registry, producing a real
//      yarn.lock with the real package's dist.integrity recorded.
//   2. Wipe node_modules and the project-local yarn cache (forcing a real
//      re-fetch of the tarball, not a cache hit), then re-run `yarn install
//      --immutable` against that SAME already-resolved lockfile, this time
//      WITH the plugin enabled and pointed at a local fake S3 endpoint that
//      logs every request and returns arbitrary (non-matching)
//      tarball-shaped bytes for any key.
// Two things happen if (and only if) the hook actually fires here: the fake
// server receives a request, and the install then fails with an
// integrity/checksum mismatch (the fake bytes don't match the real
// package's already-recorded hash) rather than a network error. Both are
// checked -- neither alone would rule out a coincidental, unrelated
// failure.
//
// Run with:
//   node test/cli-real.js
// (separate from `node test/smoke.js` -- this activates real yarn releases
// via corepack on first run, and makes one real network call per yarn
// version for the test package's initial resolution.)

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);

// The fake S3 server below runs its own http.Server IN THIS SAME PROCESS.
// execFileSync (or any *Sync child_process call) blocks the entire Node.js
// event loop for as long as the child runs -- confirmed directly, the hard
// way: with execFileSync here, the yarn child's own request to the fake
// server would sit in the kernel's TCP accept queue forever, since the one
// event loop that would otherwise call accept() and run the request handler
// is frozen inside the synchronous child_process call. The child process
// itself is unaffected (it's a separate OS process) -- it just never gets a
// response, so it hangs indefinitely waiting on a connection nothing will
// ever service. Using the async execFile (via util.promisify) instead keeps
// this process's event loop running while awaiting the child, which is what
// lets the fake server actually accept and answer the connection.

const PLUGIN_BUNDLE = path.join(
  __dirname,
  '..',
  'bundles',
  '@yarnpkg',
  'plugin-yarnstatic-s3.js',
);

// Small, stable, unlikely-to-ever-change public package purely so this test
// has real npm metadata (a real dist.integrity hash) to detect a mismatch
// against -- not a package this plugin's own functionality depends on.
const TEST_PACKAGE = 'is-odd';
const TEST_VERSION = '3.0.1';

const YARN_VERSIONS = [
  {version: '3.8.7', major: 3, expectIntercepted: true},
  {version: '4.17.0', major: 4, expectIntercepted: true},
];

function startFakeS3Server() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({method: req.method, url: req.url});
    // Arbitrary bytes shaped enough like a response to be readable, but
    // deliberately NOT a real gzip tarball matching any real package's
    // recorded integrity -- see the file-level comment for why that's the
    // point, not a gap.
    res.writeHead(200, {'content-type': 'application/octet-stream'});
    res.end(Buffer.from('not a real tarball, deliberately'));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({server, requests}));
  });
}

async function runYarn(yarnVersion, projectDir, args, extraEnv) {
  const env = {...process.env, ...extraEnv};
  try {
    const {stdout, stderr} = await execFileAsync('corepack', ['yarn@' + yarnVersion, ...args], {
      cwd: projectDir,
      env,
      encoding: 'utf8',
    });
    return {ok: true, output: stdout + stderr};
  } catch (err) {
    return {ok: false, output: (err.stdout || '') + (err.stderr || '')};
  }
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

  if (!fs.existsSync(PLUGIN_BUNDLE)) {
    console.error(`Plugin bundle not found at ${PLUGIN_BUNDLE} -- run "yarn build" first.`);
    process.exit(1);
  }

  for (const {version, major} of YARN_VERSIONS) {
    await check(
      `yarn ${version} (major ${major}): wrapNetworkRequest actually intercepts a real immutable install's tarball fetch`,
      async () => {
        const {server, requests} = await startFakeS3Server();
        const fakeS3Url = `http://127.0.0.1:${server.address().port}`;
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `yarnstatic-s3-cli-${major}-`));
        // A dedicated, per-test global folder -- confirmed directly this is
        // necessary, not just belt-and-suspenders: this machine's real
        // ~/.yarn/berry/cache already had is-odd@3.0.1 cached from earlier
        // manual testing, and enableGlobalCache: false in .yarnrc.yml does
        // NOT stop yarn from reading an already-present global cache entry
        // (only from writing new ones there) -- so phase 2 found a cache
        // hit and never made a network request at all, silently passing
        // for the wrong reason (no fetch to intercept, not "intercepted
        // correctly"). YARN_GLOBAL_FOLDER redirects the entire global
        // state (including the cache) somewhere this test fully controls.
        const globalFolder = fs.mkdtempSync(path.join(os.tmpdir(), `yarnstatic-s3-global-${major}-`));
        try {
          fs.writeFileSync(
            path.join(projectDir, 'package.json'),
            JSON.stringify({name: 'cli-real-test', packageManager: `yarn@${version}`}),
          );
          fs.writeFileSync(
            path.join(projectDir, '.yarnrc.yml'),
            'nodeLinker: node-modules\nenableGlobalCache: false\n',
          );

          await execFileAsync('corepack', ['yarn@' + version, 'plugin', 'import', PLUGIN_BUNDLE], {
            cwd: projectDir,
            env: {...process.env, YARN_GLOBAL_FOLDER: globalFolder},
            encoding: 'utf8',
          });

          // Phase 1: real resolution, plugin not enabled (no YARNSTATIC_*
          // env vars) -- a normal `yarn add` against the real registry,
          // producing a real yarn.lock with the real package's
          // dist.integrity recorded.
          const resolveResult = await runYarn(version, projectDir, ['add', `${TEST_PACKAGE}@${TEST_VERSION}`], {
            YARN_GLOBAL_FOLDER: globalFolder,
          });
          assert.equal(
            resolveResult.ok,
            true,
            `phase 1 (real resolution, plugin disabled) unexpectedly failed on yarn ${version}:\n${resolveResult.output}`,
          );

          // Force a cold cache: delete node_modules AND the entire (test-
          // dedicated) global cache folder so phase 2 can't reuse what
          // phase 1 already downloaded -- it has to genuinely re-fetch the
          // tarball.
          fs.rmSync(path.join(projectDir, 'node_modules'), {recursive: true, force: true});
          fs.rmSync(path.join(projectDir, '.yarn', 'cache'), {recursive: true, force: true});
          fs.rmSync(globalFolder, {recursive: true, force: true});
          fs.mkdirSync(globalFolder, {recursive: true});

          // Phase 2: the actual scenario this plugin is built for --
          // `yarn install --immutable` against an ALREADY-fully-resolved
          // lockfile (no metadata network calls at all), plugin enabled and
          // pointed at the fake S3 endpoint.
          const installResult = await runYarn(version, projectDir, ['install', '--immutable'], {
            YARN_GLOBAL_FOLDER: globalFolder,
            YARNSTATIC_BUCKET: 'fake-bucket',
            YARNSTATIC_ENDPOINT: fakeS3Url,
            YARNSTATIC_REGION: 'us-east-1',
            // @aws-sdk/client-s3 needs *something* resolvable to sign a
            // request with, but the fake server never checks the
            // signature at all.
            AWS_ACCESS_KEY_ID: 'test',
            AWS_SECRET_ACCESS_KEY: 'test',
          });

          assert.equal(
            installResult.ok,
            false,
            `expected phase 2 to FAIL (fake bytes failing the real package's integrity check) on yarn ${version}, but it succeeded:\n${installResult.output}`,
          );
          assert.ok(
            requests.length > 0,
            `expected the fake S3 endpoint to receive at least one request on yarn ${version} (none were received) -- output:\n${installResult.output}`,
          );
        } finally {
          server.close();
          fs.rmSync(projectDir, {recursive: true, force: true});
          fs.rmSync(globalFolder, {recursive: true, force: true});
        }
      },
    );
  }

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
