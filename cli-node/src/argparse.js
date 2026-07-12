'use strict';

// Hand-rolled flag parser mirroring the one behavior of Go's flag.FlagSet
// this CLI actually depends on: parsing STOPS at the first non-flag token
// (docs/cli.md: "Flags must precede the positional path argument"), unlike
// Node's built-in util.parseArgs, which collects all flags regardless of
// position. Every flag in this CLI is either string- or int-valued (no
// boolean/presence-only flags anywhere in commonFlags, check, fetch, or
// serve), and "--" terminates flag parsing early, matching Go's flag
// package exactly.
//
// spec: {flagName: {type: 'string'|'int', default}, ...}
// Returns {values, positionals, help}. help === true means -h/--help/-help
// was seen -- callers should print their usage text and treat it exactly
// like any other parse error (Go's flag package returns exitUsage (2) for
// a subcommand's own -h, not a clean exit 0 -- see cmd/yarnstatic/*.go,
// which never special-cases -h themselves and rely on this built-in flag
// package behavior).
class ParseError extends Error {}

function parseArgs(argv, spec) {
  const values = {};
  for (const [name, def] of Object.entries(spec)) {
    values[name] = def.default;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token === '--') {
      return {values, positionals: argv.slice(i + 1), help: false};
    }

    if (token === '-h' || token === '--help' || token === '-help') {
      return {values, positionals: argv.slice(i + 1), help: true};
    }

    if (token.length > 1 && token[0] === '-') {
      const rest = token.startsWith('--') ? token.slice(2) : token.slice(1);
      const eqIndex = rest.indexOf('=');
      const name = eqIndex >= 0 ? rest.slice(0, eqIndex) : rest;
      const inlineValue = eqIndex >= 0 ? rest.slice(eqIndex + 1) : undefined;

      const def = spec[name];
      if (!def) {
        throw new ParseError(`flag provided but not defined: -${name}`);
      }

      let raw;
      if (inlineValue !== undefined) {
        raw = inlineValue;
        i += 1;
      } else {
        if (i + 1 >= argv.length) {
          throw new ParseError(`flag needs an argument: -${name}`);
        }
        raw = argv[i + 1];
        i += 2;
      }

      if (def.type === 'int') {
        if (!/^[+-]?\d+$/.test(raw)) {
          throw new ParseError(`invalid value ${JSON.stringify(raw)} for flag -${name}: parse error`);
        }
        values[name] = Number.parseInt(raw, 10);
      } else {
        values[name] = raw;
      }
      continue;
    }

    // First non-flag token: Go's flag package stops parsing here, leaving
    // everything from here on (including this token) as positionals.
    return {values, positionals: argv.slice(i), help: false};
  }

  return {values, positionals: [], help: false};
}

module.exports = {parseArgs, ParseError};
