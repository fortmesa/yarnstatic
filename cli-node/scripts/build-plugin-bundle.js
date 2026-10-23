#!/usr/bin/env node
'use strict';

// prepack script: builds yarn-plugin-yarnstatic-s3's bundle (via its own
// @yarnpkg/builder "yarn build" script) if needed, then copies the result
// into plugin/plugin-yarnstatic-s3.cjs so it ships inside this package's
// published tarball (see package.json's "files" and README.md's "yarn
// plugin import" step). This is the SAME artifact name/rename convention
// yarnstatic's own .github/workflows/release.yml already uses for its
// release bundles -- never hand-copy or commit plugin/*.cjs yourself, this
// script is the only thing that should produce it (see .gitignore).

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'plugins', 'yarn-plugin-yarnstatic-s3');
// The bundle inlines the plugin's dependencies, so a newer package.json or
// yarn.lock (a dependency bump with no source change) makes it stale too.
const INPUT_FILES = ['sources/index.js', 'package.json', 'yarn.lock'].map(f => path.join(PLUGIN_DIR, f));
const BUNDLE_FILE = path.join(PLUGIN_DIR, 'bundles', '@yarnpkg', 'plugin-yarnstatic-s3.js');
const OUT_DIR = path.resolve(__dirname, '..', 'plugin');
const OUT_FILE = path.join(OUT_DIR, 'plugin-yarnstatic-s3.cjs');

function needsBuild() {
  if (!fs.existsSync(BUNDLE_FILE)) return true;
  const bundleTime = fs.statSync(BUNDLE_FILE).mtimeMs;
  return INPUT_FILES.some(f => fs.statSync(f).mtimeMs > bundleTime);
}

function main() {
  if (needsBuild()) {
    console.log(`[build-plugin-bundle] building yarn-plugin-yarnstatic-s3 (${PLUGIN_DIR})...`);
    execFileSync('yarn', ['build'], {cwd: PLUGIN_DIR, stdio: 'inherit'});
  }

  if (!fs.existsSync(BUNDLE_FILE)) {
    throw new Error(`expected bundle not found after build: ${BUNDLE_FILE}`);
  }

  fs.mkdirSync(OUT_DIR, {recursive: true});
  fs.copyFileSync(BUNDLE_FILE, OUT_FILE);
  console.log(`[build-plugin-bundle] copied ${BUNDLE_FILE} -> ${OUT_FILE}`);
}

main();
