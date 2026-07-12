#!/usr/bin/env node
'use strict';

const {run} = require('../src/main');

run(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    process.stderr.write(`yarnstatic: unexpected error: ${(err && err.stack) || err}\n`);
    process.exitCode = 6; // exitOtherError
  });
