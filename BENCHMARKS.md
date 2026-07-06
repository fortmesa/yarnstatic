# Benchmarks

Install wall-clock time across five ways to populate `node_modules` for the
same real-world project, comparing yarnstatic's two plugins (and the daemon
plugin's AWS CLI fallback path) against plain `yarn install`/`npm install`
against the real npm registry.

Produced by [`scripts/benchmark.sh`](scripts/benchmark.sh) - see that
script for the exact methodology; summarized here.

## Methodology

- **Workload**: a real, private sample project's own `package.json`/
  `yarn.lock` - **1,749 resolved package entries**, not a toy dependency
  set.
- **Every run** gets a freshly copied project directory (never reused
  across runs) and a fresh, randomly-named `YARN_GLOBAL_FOLDER`/npm cache
  directory, so no run can benefit from a previous run's warm cache -
  every timing below is a genuinely cold install.
- **3 rounds**, all 5 scenarios run in each round, in the same order.
- Real infrastructure throughout: the real npm registry for the
  no-plugin/npm scenarios, and a real S3 bucket (the same one
  `yarnstatic`'s own docs default to) for the three yarnstatic-backed
  scenarios.

## Scenarios

| Scenario | What it is |
|---|---|
| `npm-install` | Plain `npm install` - no Yarn, no yarnstatic at all |
| `yarn-no-plugin` | Plain `yarn install --immutable`, no yarnstatic plugin - hits the real npm registry |
| `yarn-daemon` | `yarn-plugin-yarnstatic`, with the `yarnstatic` binary available (its primary, intended path: a local daemon serves tarballs from S3) |
| `yarn-aws-fallback` | `yarn-plugin-yarnstatic`, with the `yarnstatic` binary made unreachable (forces the plugin's `aws s3 cp` fallback path, one subprocess per package) |
| `yarn-s3-plugin` | `yarn-plugin-yarnstatic-s3` - talks to S3 directly via the AWS SDK, no daemon or binary at all |

## Results

### Summary (seconds)

| Scenario | Mean | Min | Max |
|---|---:|---:|---:|
| `yarn-daemon` | **24.67** | 24.07 | 25.38 |
| `yarn-s3-plugin` | **25.39** | 24.98 | 26.05 |
| `yarn-no-plugin` | 53.92 | 49.48 | 60.30 |
| `npm-install` | 73.56 | 68.25 | 80.43 |
| `yarn-aws-fallback` | 118.97 | 118.89 | 119.02 |

### Every run

| Round | `npm-install` | `yarn-no-plugin` | `yarn-daemon` | `yarn-aws-fallback` | `yarn-s3-plugin` |
|---:|---:|---:|---:|---:|---:|
| 1 | 80.43s | 51.97s | 24.07s | 119.02s | 24.98s |
| 2 | 72.01s | 49.48s | 24.56s | 118.99s | 26.05s |
| 3 | 68.25s | 60.30s | 25.38s | 118.89s | 25.14s |

## Takeaways

- **`yarn-daemon` and `yarn-s3-plugin` are statistically tied** (~25s
  either way) and **2-3x faster** than installing against the real
  registry. S3 is simply a much lower-latency path than the public npm
  registry for a dependency set this size - both yarnstatic-backed
  primary paths deliver on that.
- **The AWS CLI fallback is the clear outlier - and not in a good way.**
  At ~119s it's the *slowest* scenario of the five, slower than not using
  yarnstatic at all. The variance across rounds is also the tightest of
  any scenario (118.89s-119.02s, a 0.13s spread) - that consistency points
  to a structural, per-package cost rather than network noise: spawning a
  fresh `aws s3 cp` subprocess (Python/boto3 startup included) for every
  one of 1,749 packages adds up, in a way neither the persistent daemon
  connection nor the in-process AWS SDK calls ever pay.
- **Practical implication**: the AWS CLI fallback is correctness
  insurance for the case where the `yarnstatic` binary genuinely can't be
  found - it keeps an install working rather than failing outright - not
  a path to rely on for everyday installs. At roughly 5x the cost of the
  primary daemon path, an install that's silently running in fallback
  mode is worth noticing and fixing (missing/misconfigured binary), not
  treating as equivalent.

## Reproducing

```sh
AWS_PROFILE=<your-profile> YARNSTATIC_BUCKET=<your-bucket> ./scripts/benchmark.sh
```

`BENCHMARK_RUNS` (default 3) controls how many rounds run; see
`scripts/benchmark.sh`'s own header comment for the full set of env vars,
including pointing `WORKLOAD_PACKAGE_JSON`/`WORKLOAD_YARN_LOCK`/
`WORKLOAD_YARNRC` at a different project entirely.
