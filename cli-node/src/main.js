'use strict';

const {runCheck} = require('./commands/check');
const {runFetch} = require('./commands/fetch');
const {runServe} = require('./commands/serve');

const USAGE = `yarnstatic - populate a Yarn Berry .yarn/cache from a Verdaccio S3 bucket

Usage:
  yarnstatic check [flags] [path]
  yarnstatic fetch [flags] --package <name>@<version>
  yarnstatic serve [flags] --socket <path>
  yarnstatic version

Run "yarnstatic <command> -h" for command-specific flags. See docs/cli.md
in the yarnstatic repo for the full reference (this Node CLI implements
the same commands/flags/exit codes as the Go binary documented there).
`;

// run dispatches to check/fetch/serve/version, mirroring
// cmd/yarnstatic/main.go's run(). Returns the process exit code.
async function run(args) {
  if (args.length < 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (args[0]) {
    case 'check':
      return runCheck(args.slice(1));
    case 'fetch':
      return runFetch(args.slice(1));
    case 'serve':
      return runServe(args.slice(1));
    case 'version':
      console.log(require('../package.json').version);
      return 0;
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`yarnstatic: unknown command ${JSON.stringify(args[0])}\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

module.exports = {run};
