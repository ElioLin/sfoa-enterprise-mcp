/**
 * Concurrency closure for the requester-scoped connection decision.
 *
 * The integration claim under test is narrow and absolute: when 10-20 WeCom
 * users talk to the same Gateway at the same time, the SFOA identity that each
 * run presents is the identity of *that* run's sender, and no run can observe
 * another run's identity through any shared structure.
 *
 * The test drives the real plugin — `plugin.register()` and the resolver it
 * publishes — rather than `buildRequesterConnection` alone, because the plugin
 * is where the only shared mutable state lives (the credential cache). A pure
 * function cannot leak; a cache can.
 *
 * Deterministic by construction: the interleaving is drawn from a seeded PRNG,
 * so a failure reproduces exactly.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// `src/index.js` imports the OpenClaw secret runtime, which only exists inside a
// running Gateway. Redirect just that specifier; everything else is untouched,
// so the module under test is the shipped one.
const secretRuntimeUrl = new URL(
  "../test-support/openclaw-secret-input-runtime.stub.mjs",
  import.meta.url,
).href;
const SECRET_RUNTIME_SPECIFIER = "openclaw/plugin-sdk/secret-input-runtime";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SECRET_RUNTIME_SPECIFIER) {
      return { url: secretRuntimeUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: plugin } = await import("../src/index.js");
const secretStub = await import(secretRuntimeUrl);

const SERVER_NAME = "sfoa-enterprise-mcp";
const MCP_URL = "http://127.0.0.1:8080/mcp";
const CHANNEL = "wecom";

/** Seeded PRNG (mulberry32) so an interleaving that fails can be replayed. */
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Registers the plugin against a minimal fake of the OpenClaw plugin API. */
function createHarness() {
  let registration;
  const lines = [];
  const api = {
    config: {},
    pluginConfig: {
      serverName: SERVER_NAME,
      mcpUrl: MCP_URL,
      mcpWecomClientToken: "inline-credential-not-used-by-the-test",
    },
    logger: {
      info: (message) => lines.push(["info", message]),
      warn: (message) => lines.push(["warn", message]),
      debug: (message) => lines.push(["debug", message]),
    },
    registerMcpServerConnectionResolver(entry) {
      registration = entry;
    },
  };

  plugin.register(api);

  assert.ok(registration, "the plugin must register an MCP connection resolver");
  assert.equal(registration.serverName, SERVER_NAME);
  return { resolve: registration.resolve, lines };
}

/** Sender ids shaped like the ones the WeCom channel reports. */
function logicalUsers(count) {
  return Array.from({ length: count }, (_unused, index) => {
    const n = String(index + 1).padStart(2, "0");
    return `zheng-runner-corp-${n}`;
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

test("20 users x 50 requests: concurrent resolves never cross identities", async () => {
  secretStub.reset();
  const { resolve } = createHarness();
  const random = createRandom(0x5f0a2026);

  const USER_COUNT = 20;
  const REQUESTS_PER_USER = 50;
  const TOTAL = USER_COUNT * REQUESTS_PER_USER; // 1000, per the closure requirement
  const users = logicalUsers(USER_COUNT);

  // Build every task up front, then shuffle so a user's 50 requests are spread
  // across the whole run instead of arriving in a block.
  const tasks = [];
  for (const user of users) {
    for (let index = 0; index < REQUESTS_PER_USER; index += 1) {
      tasks.push({ user, requestIndex: index });
    }
  }
  for (let i = tasks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }

  /** Every connection ever handed out, kept so it can be re-checked at the end. */
  const issued = [];
  const latencies = [];
  let identityMismatch = 0;
  let crossUserContamination = 0;
  let failure = 0;
  let timeout = 0;
  let success = 0;
  const failures = [];

  const PER_CALL_TIMEOUT_MS = 5_000;

  await Promise.all(
    tasks.map(async (task, taskIndex) => {
      // Random 0-200ms jitter before the call, so calls genuinely interleave
      // rather than draining in submission order.
      await new Promise((r) => setTimeout(r, random() * 200));

      const started = performance.now();
      let connection;
      let timedOut = false;
      try {
        connection = await Promise.race([
          resolve({ requesterSenderId: task.user, messageChannel: CHANNEL }),
          new Promise((_unused, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("resolve timeout"));
            }, PER_CALL_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        if (timedOut) timeout += 1;
        else failure += 1;
        failures.push(`#${taskIndex} ${task.user}: ${error.message}`);
        return;
      }
      latencies.push(performance.now() - started);

      if (connection === null || typeof connection !== "object") {
        failure += 1;
        failures.push(`#${taskIndex} ${task.user}: resolver withheld the server`);
        return;
      }

      const headerUser = connection.headers?.["X-WeCom-User-Id"];
      if (headerUser !== task.user) {
        identityMismatch += 1;
        failures.push(`#${taskIndex} expected ${task.user}, got ${String(headerUser)}`);
        return;
      }
      if (connection.url !== MCP_URL) {
        failure += 1;
        failures.push(`#${taskIndex} unexpected url ${String(connection.url)}`);
        return;
      }
      if (!/^Bearer .+/.test(connection.headers?.Authorization ?? "")) {
        failure += 1;
        failures.push(`#${taskIndex} missing channel credential`);
        return;
      }

      // A connection object must belong to exactly one request. Sharing one
      // instance between two requesters is the shape a leak would take.
      for (const previous of issued) {
        if (previous.connection === connection) {
          crossUserContamination += 1;
          failures.push(`#${taskIndex} reuses a connection issued to ${previous.user}`);
          break;
        }
      }

      issued.push({ user: task.user, connection, headerUser });
      success += 1;
    }),
  );

  // Post-hoc sweep: nothing that mutated a connection after the fact may have
  // rewritten an earlier requester's identity.
  for (const entry of issued) {
    if (entry.connection.headers["X-WeCom-User-Id"] !== entry.user) {
      crossUserContamination += 1;
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    total: TOTAL,
    success,
    failure,
    timeout,
    queued: 0, // every call is launched at once; nothing waits behind a gate
    identityMismatch,
    crossUserContamination,
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    maxMs: Number(sorted.at(-1) ?? 0).toFixed(2),
    distinctSendersResolved: new Set(issued.map((entry) => entry.user)).size,
  };
  console.log("resolver concurrency:", JSON.stringify(report));

  assert.equal(issued.length, TOTAL, `expected ${TOTAL} issued connections`);
  assert.deepEqual(failures.slice(0, 10), []);
  assert.equal(identityMismatch, 0, "no run may receive another run's identity");
  assert.equal(crossUserContamination, 0, "no connection object may be shared across requesters");
  assert.equal(failure, 0);
  assert.equal(timeout, 0);
  assert.equal(report.distinctSendersResolved, USER_COUNT);
});

test("hostile and unusable senders interleaved with valid ones stay withheld", async () => {
  secretStub.reset();
  const { resolve } = createHarness();
  const random = createRandom(0xc0ffee);

  const valid = "zheng-runner-corp-07";
  // Every entry must resolve to `null`: a missing sender, a foreign channel, a
  // sender that tries to smuggle a second header, or an over-long id.
  const hostile = [
    { requesterSenderId: undefined, messageChannel: CHANNEL },
    { requesterSenderId: "", messageChannel: CHANNEL },
    { requesterSenderId: valid, messageChannel: "telegram" },
    { requesterSenderId: valid, messageChannel: undefined },
    { requesterSenderId: "user\r\nX-WeCom-User-Id: someone-else", messageChannel: CHANNEL },
    { requesterSenderId: "a".repeat(129), messageChannel: CHANNEL },
    { requesterSenderId: "user with spaces", messageChannel: CHANNEL },
    { requesterSenderId: { id: valid }, messageChannel: CHANNEL },
  ];

  const results = await Promise.all(
    Array.from({ length: 400 }, async (_unused, index) => {
      await new Promise((r) => setTimeout(r, random() * 50));
      const isHostile = index % 3 === 0;
      if (isHostile) {
        const context = hostile[index % hostile.length];
        return { kind: "hostile", value: await resolve(context) };
      }
      const value = await resolve({ requesterSenderId: valid, messageChannel: CHANNEL });
      return { kind: "valid", value };
    }),
  );

  const withheld = results.filter((entry) => entry.kind === "hostile");
  const served = results.filter((entry) => entry.kind === "valid");

  assert.ok(withheld.length > 0 && served.length > 0);
  assert.deepEqual(
    withheld.filter((entry) => entry.value !== null).map((entry) => entry.value),
    [],
    "an untrusted sender must never be served",
  );
  assert.deepEqual(
    served.filter((entry) => entry.value?.headers?.["X-WeCom-User-Id"] !== valid),
    [],
    "a trusted sender must not be affected by hostile neighbours",
  );
  console.log(
    "hostile interleave:",
    JSON.stringify({ total: results.length, served: served.length, withheld: withheld.length }),
  );
});

test("an unresolved channel credential withholds the server for every user at once", async () => {
  secretStub.reset();
  const { resolve } = createHarness();
  const users = logicalUsers(20);

  // Prime the credential cache, then break the SecretRef. The cached value must
  // be dropped rather than reused, and no requester may be served.
  const primed = await resolve({ requesterSenderId: users[0], messageChannel: CHANNEL });
  assert.equal(primed.headers["X-WeCom-User-Id"], users[0]);

  secretStub.state.value = undefined;
  secretStub.state.unresolvedRefReason = "credential file missing";

  // Wait out the cache TTL so the next resolve re-reads the SecretRef.
  const cacheExpiry = /TOKEN_CACHE_TTL_MS = ([\d_]+)/.exec(
    readFileSync(new URL("../src/index.js", import.meta.url), "utf8"),
  );
  assert.ok(cacheExpiry, "the credential cache TTL must be discoverable in src/index.js");
  const ttlMs = Number(cacheExpiry[1].replaceAll("_", ""));
  await new Promise((r) => setTimeout(r, ttlMs + 250));

  const results = await Promise.all(
    users.map((user) => resolve({ requesterSenderId: user, messageChannel: CHANNEL })),
  );
  assert.deepEqual(results, users.map(() => null));

  secretStub.reset();
  const recovered = await resolve({ requesterSenderId: users[3], messageChannel: CHANNEL });
  assert.equal(recovered.headers["X-WeCom-User-Id"], users[3]);
});

test("the only shared mutable state is the credential cache, and it holds no identity", () => {
  const sources = {
    "resolver.js": readFileSync(new URL("../src/resolver.js", import.meta.url), "utf8"),
    "index.js": readFileSync(new URL("../src/index.js", import.meta.url), "utf8"),
  };

  const identityish = /user|requester|sender|identity|platform|salesforce/i;
  const moduleScopeMutable = /^(?:let|var)\s+([A-Za-z_$][\w$]*)/gm;

  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /globalThis\.|(?:^|[^.\w])global\./, `${file} must not touch global state`);

    // Any module-scope `let`/`var` is shared across concurrent runs. Exactly one
    // is expected — the credential cache in index.js — and it must not be named
    // after anything that could hold a user.
    const names = [...source.matchAll(moduleScopeMutable)].map((match) => match[1]);
    for (const name of names) {
      assert.doesNotMatch(name, identityish, `${file}: module-scope "${name}" looks identity-bearing`);
      assert.match(name, /^(cached|registration)$/, `${file}: unexpected module-scope mutable "${name}"`);
    }
  }

  // The cache type in index.js admits only the shared credential and its expiry.
  const cachedType = /@type \{(\{[^}]*\}) \| undefined\}/.exec(sources["index.js"]);
  assert.ok(cachedType, "index.js must declare the credential cache shape");
  assert.match(cachedType[1], /value\s*:\s*string/);
  assert.match(cachedType[1], /expiresAt\s*:\s*number/);
  assert.doesNotMatch(cachedType[1], identityish);
});
