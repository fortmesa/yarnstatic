'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

// Settings check reads from Yarn's own configuration: the ones the
// yarn-plugin-yarnstatic-s3 plugin registers (the daemon plugin registers
// yarnstaticScopeStorage only), each with its YARN_* environment variable
// (Yarn camelCases what follows "yarn_", case-insensitively). Reading the
// same files the same way the plugin's Yarn process does is what lets
// check compute the keys an install will actually fetch. Ported from
// cmd/yarnstatic/yarnrc.go.
const SCALARS = [
  {key: 'yarnstaticBucket', env: 'yarn_yarnstatic_bucket', field: 'bucket'},
  {key: 'yarnstaticKeyPrefix', env: 'yarn_yarnstatic_key_prefix', field: 'keyPrefix'},
  {key: 'yarnstaticRegion', env: 'yarn_yarnstatic_region', field: 'region'},
  {key: 'yarnstaticEndpoint', env: 'yarn_yarnstatic_endpoint', field: 'endpoint'},
  {key: 'yarnstaticProfile', env: 'yarn_yarnstatic_profile', field: 'profile'},
];

const SCOPE_STORAGE_KEY = 'yarnstaticScopeStorage';

// loadYarnrc reads the yarnstatic settings Yarn would load for a project at
// projectPath (@yarnpkg/core Configuration.find):
//   - <dir>/.yarnrc.yml in projectPath and every parent directory up to the
//     filesystem root (YARN_RC_FILENAME renames the file), plus
//     ~/.yarnrc.yml, which is the farthest of all unless the walk found it
//   - a closer file overrides a farther one
//   - yarnstaticScopeStorage merges scope by scope; onConflict: reset keeps
//     a file's map and drops farther ones, hardReset drops both
//   - YARN_YARNSTATIC_* environment variables override every file
//   - ${VAR}, ${VAR:-default} and ${VAR-default} expand from the
//     environment, as Yarn expands them (.env.yarn files are not read)
//
// Returns {bucket, keyPrefix, region, endpoint, profile, scopeStorage},
// '' meaning unset; scopeStorage is a Map keyed by scope without a leading
// "@". Throws on an unreadable or malformed file.
function loadYarnrc(projectPath) {
  const settings = {bucket: '', keyPrefix: '', region: '', endpoint: '', profile: '', scopeStorage: new Map()};
  const files = findRcFiles(projectPath);
  const env = process.env;
  const lowerEnv = new Map();
  for (const [k, v] of Object.entries(env)) lowerEnv.set(k.toLowerCase(), v);

  for (const s of SCALARS) {
    let found = resolveRcScalar(files, s.key);
    if (lowerEnv.has(s.env)) found = {value: lowerEnv.get(s.env), source: 'the environment'};
    if (!found) continue;
    try {
      settings[s.field] = expandEnvVariables(found.value, env);
    } catch (err) {
      throw new Error(`${s.key} in ${found.source}: ${err.message}`);
    }
  }

  for (const [scope, {value, source}] of resolveRcScopeStorage(files)) {
    try {
      settings.scopeStorage.set(scope, expandEnvVariables(value, env));
    } catch (err) {
      throw new Error(`${SCOPE_STORAGE_KEY}.${scope} in ${source}: ${err.message}`);
    }
  }
  return settings;
}

// findRcFiles returns the rc files Yarn reads for projectPath, closest
// first, as [{path, data}].
function findRcFiles(projectPath) {
  let dir = path.resolve(projectPath);

  let rcName = '.yarnrc.yml';
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === 'yarn_rc_filename') rcName = v;
  }

  const files = [];
  for (;;) {
    const f = readRcFile(path.join(dir, rcName));
    if (f) files.push(f);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Yarn reads the home file under its default name even when
  // YARN_RC_FILENAME is set.
  const home = os.homedir();
  if (home) {
    const homePath = path.join(home, '.yarnrc.yml');
    if (!files.some(f => f.path === homePath)) {
      const f = readRcFile(homePath);
      if (f) files.push(f);
    }
  }
  return files;
}

// readRcFile parses one rc file, returning null if it doesn't exist.
function readRcFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`reading ${filePath}: ${err.message}`);
  }

  const doc = YAML.parseDocument(text, {schema: 'failsafe'});
  if (doc.errors.length > 0) {
    throw new Error(`parsing ${filePath}: ${doc.errors[0].message}`);
  }
  const value = failsafe(doc.contents, doc);
  if (value == null) return {path: filePath, data: {}};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`parsing ${filePath}: expected a mapping at the top level`);
  }
  return {path: filePath, data: value};
}

// failsafe converts a parsed YAML node the way js-yaml's FAILSAFE schema,
// which Yarn parses .yarnrc.yml with, reads it: every scalar is a string,
// and only an empty plain value is null. (The yaml package's own failsafe
// schema reads an empty plain value as "".)
function failsafe(node, doc) {
  if (node == null) return null;
  if (YAML.isAlias(node)) return failsafe(node.resolve(doc), doc);
  if (YAML.isScalar(node)) {
    if (node.value === '' && node.type === 'PLAIN') return null;
    return String(node.value);
  }
  if (YAML.isMap(node)) {
    const m = Object.create(null);
    for (const pair of node.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      m[key] = failsafe(pair.value, doc);
    }
    return m;
  }
  if (YAML.isSeq(node)) return node.items.map(item => failsafe(item, doc));
  return null;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// unwrapConflict reads Yarn's {onConflict: ..., value: ...} marker
// (configUtils.ts normalizeValue): a mapping whose onConflict is a string
// carries its value under "value", or as the rest of its keys.
function unwrapConflict(v) {
  if (!isObject(v) || typeof v.onConflict !== 'string') return {onConflict: 'default', value: v};
  if (Object.hasOwn(v, 'value')) return {onConflict: v.onConflict, value: v.value};
  const rest = Object.create(null);
  for (const [k, x] of Object.entries(v)) {
    if (k !== 'onConflict') rest[k] = x;
  }
  return {onConflict: v.onConflict, value: rest};
}

// resolveRcScalar returns the closest file's value for a string setting as
// {value, source}, or null if no file sets it.
function resolveRcScalar(files, key) {
  for (const f of files) {
    if (!Object.hasOwn(f.data, key)) continue;
    const {value} = unwrapConflict(f.data[key]);
    if (typeof value === 'string') return {value, source: f.path};
    if (value === null) throw new Error(`${key} in ${f.path} cannot be null`);
    throw new Error(`${key} in ${f.path} must be a string`);
  }
  return null;
}

// resolveRcScopeStorage merges yarnstaticScopeStorage across files the way
// Yarn's resolveRcFiles does for a mapping: walking from the closest file,
// stop before a non-mapping value or an onConflict: hardReset, and after an
// onConflict: reset; within what's left, the closest file defining a scope
// wins. Returns a Map of scope -> {value, source}, sorted by scope.
function resolveRcScopeStorage(files) {
  const layers = []; // closest first
  for (const f of files) {
    if (!Object.hasOwn(f.data, SCOPE_STORAGE_KEY)) continue;
    const {onConflict, value} = unwrapConflict(f.data[SCOPE_STORAGE_KEY]);
    if (!isObject(value)) {
      // The closest value decides the type: Yarn rejects a non-map there,
      // and stops merging at one farther out.
      if (layers.length === 0) throw new Error(`${SCOPE_STORAGE_KEY} in ${f.path} must be a map`);
      break;
    }
    if (onConflict === 'hardReset') break;
    layers.push({path: f.path, m: value});
    if (onConflict === 'reset') break;
  }

  const scopes = new Set();
  for (const l of layers) for (const scope of Object.keys(l.m)) scopes.add(scope);

  const result = new Map();
  for (const scope of [...scopes].sort()) {
    for (const l of layers) {
      if (!Object.hasOwn(l.m, scope)) continue;
      const {value} = unwrapConflict(l.m[scope]);
      if (typeof value !== 'string') throw new Error(`${SCOPE_STORAGE_KEY}.${scope} in ${l.path} must be a string`);
      result.set(scope, {value, source: l.path});
      break;
    }
  }
  return result;
}

// expandEnvVariables is Yarn's miscUtils.replaceEnvVariables, which every
// string setting goes through: ${VAR} must be set, ${VAR:-x} falls back to
// x when VAR is unset or empty, ${VAR-x} when it's unset, and a backslash
// escapes "\", "$" and "}". Same algorithm and regex as Yarn's; the error
// messages match yarnrc.go's.
function expandEnvVariables(input, env) {
  let output = '';
  let current = 0;
  let depth = 0;
  const iterator = input.matchAll(/\\(?<escaped>[\\$}])|\$\{(?<variable>[a-zA-Z]\w*)(?<operator>:-|-|(?=\}))|(?<unknown>\$\{)|\}/g);
  const skip = () => {
    const limit = depth;
    for (const {0: match, index, groups: {variable} = {}} of iterator) {
      if (variable) {
        depth++;
      } else if (match === '}') {
        if (--depth < limit) return index + match.length;
      }
    }
    return input.length;
  };
  for (const {0: match, index, groups: {escaped, variable, operator, unknown} = {}} of iterator) {
    output += input.slice(current, index);
    current = index + match.length;
    if (escaped) {
      output += escaped;
    } else if (variable) {
      const value = Object.hasOwn(env, variable) ? env[variable] : undefined;
      depth++;
      if ((operator === '' && value !== undefined) ||
          (operator === ':-' && value !== undefined && value !== '') ||
          (operator === '-' && value !== undefined)) {
        output += value;
        current = skip();
      } else if (operator === '') {
        throw new Error(`environment variable not found (${variable})`);
      }
    } else if (match === '}') {
      if (depth === 0) output += match;
      else depth--;
    } else if (unknown) {
      throw new Error(`invalid environment variable substitution syntax: ${input}`);
    }
  }
  if (depth > 0) throw new Error(`incomplete variable substitution in input: ${input}`);
  return output + input.slice(current);
}

module.exports = {loadYarnrc, expandEnvVariables};
