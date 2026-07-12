'use strict';

// runLimited mirrors check.go's errgroup.Group.SetLimit(16) usage and
// serve.go's semaphore-channel pattern: runs worker(item, index) for every
// item, at most `limit` concurrently. Matching check.go's own comment
// ("never propagate the error through the group -- the whole point is
// reporting every missing/errored object, not just the first"), a
// rejecting worker does NOT cancel or skip any other worker -- worker is
// expected to catch its own error and record it itself. Writes complete in
// whatever order they finish, but since callers write into a preallocated
// results array by original index, output ordering stays deterministic
// regardless of completion order.
async function runLimited(items, limit, worker) {
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, runOne));
}

module.exports = {runLimited};
