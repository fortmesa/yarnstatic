'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

// loadScopeStorage reads <projectPath>/.yarnrc.yml's yarnstaticScopeStorage
// map (the same setting the yarn-plugin-yarnstatic/yarn-plugin-yarnstatic-s3
// plugins register), keyed by scope without a leading "@" and valued with
// the Verdaccio packages[...].storage override for that scope's key layout
// (see docs/s3-layout.md). A missing file, or a file without that key, is
// not an error -- it just means no scope needs the override, which is the
// common case. There's no dedicated flag or env var for this (deliberately
// -- .yarnrc.yml is the single source of truth also read by the Yarn
// plugin, so the two can't drift out of sync). Ported from
// cmd/yarnstatic/scopestorage.go.
//
// Returns null (not {}) when there's no override map at all -- callers
// index it as `(scopeStorage || {})[scope]`, matching Go's nil-map-safe
// indexing (a nil Go map read returns the zero value, "").
function loadScopeStorage(projectPath) {
  const filePath = path.join(projectPath, '.yarnrc.yml');
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`reading ${filePath}: ${err.message}`);
  }

  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`parsing ${filePath}: ${err.message}`);
  }
  if (doc == null) return null; // empty .yarnrc.yml -- no config, not an error
  return doc.yarnstaticScopeStorage || null;
}

module.exports = {loadScopeStorage};
