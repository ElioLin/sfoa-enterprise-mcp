import { after } from 'node:test';
import { isMainThread } from 'node:worker_threads';

// Node 22 must keep the test process alive while existing unref deadlines are awaited.
// The native --test-timeout bounds unresolved tests; after() releases this handle.
if (isMainThread) {
  const lifetime = setInterval(() => {}, 60_000);
  after(() => clearInterval(lifetime));
}
