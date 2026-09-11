/**
 * MCP-level concurrency closure for requester-scoped identity.
 *
 * Run on the SFOA/OpenClaw host (needs the loopback MCP endpoint and the
 * channel credential):
 *
 *   node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/mcp-concurrency.mjs [callsPerUser] [concurrency]
 *
 * What it proves, and what it deliberately does not:
 *   - Drives the real `sfoa-enterprise-mcp` endpoint over HTTP with two real
 *     `sfoa_identity_route` users, interleaved, so P8-06 (channel credential),
 *     P8-05 (header identity), the identity route and the Salesforce user
 *     binding are all exercised per request.
 *   - Uses `get_username` only: a read-only, non-DML tool whose answer *is* the
 *     resolved Salesforce user, which makes a cross-user leak directly visible
 *     instead of needing to be inferred.
 *   - Performs no DML. `create_record(s)`, `update_record(s)` and any delete are
 *     never called.
 *   - Never prints the channel credential.
 */

import { readFileSync } from "node:fs";

const MCP_URL = process.env.SFOA_MCP_URL ?? "http://127.0.0.1:8080/mcp";
const SECRETS_FILE =
  process.env.OPENCLAW_SECRETS_FILE ?? "/data/openclaw/secrets/credentials.json";
const SECRET_KEY = "sfoaWecomMcpToken";

/** The two real, enabled identity routes this environment can resolve. */
const USERS = [
  { id: "61979", expectUsername: "candy.zheng@runner-corp.com.cn.uat" },
  { id: "33575", expectUsername: "lina.xu@runner-corp.com.cn.uat" },
];

/** A platform user with no enabled route; must fail closed, every time. */
const UNROUTED_USER = "runner-corp";

const CALLS_PER_USER = Number(process.argv[2] ?? 200);
const CONCURRENCY = Number(process.argv[3] ?? 16);
const MAX_JITTER_MS = 200;

const token = JSON.parse(readFileSync(SECRETS_FILE, "utf8"))[SECRET_KEY];
if (typeof token !== "string" || token.length === 0) {
  throw new Error(`missing ${SECRET_KEY}; cannot run the concurrency probe`);
}

/** Seeded PRNG so a failing interleaving can be replayed. */
function createRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = createRandom(0x1d2026);

async function rpc(method, params, userId) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "x-wecom-user-id": String(userId),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  // The endpoint may answer as SSE; take the last complete JSON-RPC envelope.
  let envelope;
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/^data:\s*/, "").trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      /* keep looking */
    }
  }
  if (envelope === undefined) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      envelope = { parseError: raw.slice(0, 200) };
    }
  }
  return { status: response.status, envelope };
}

function textOf(envelope) {
  const content = envelope?.result?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
  return "";
}

/** Every identity-bearing string the response carries, for leak scanning. */
function serialized(envelope) {
  return JSON.stringify(envelope ?? null);
}

const plan = [];
for (let index = 0; index < CALLS_PER_USER; index += 1) {
  for (const user of USERS) plan.push({ kind: "routed", user });
}
for (let index = 0; index < CALLS_PER_USER / 10; index += 1) {
  plan.push({ kind: "unrouted", user: { id: UNROUTED_USER } });
}
for (let i = plan.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}

const results = [];
const latencies = [];
let inFlight = 0;
let peakInFlight = 0;
let queued = 0;
let cursor = 0;

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= plan.length) return;
    const task = plan[index];

    if (inFlight >= CONCURRENCY) queued += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      // Jitter before dispatch so the two identities genuinely interleave
      // instead of arriving in contiguous blocks.
      await new Promise((r) => setTimeout(r, random() * MAX_JITTER_MS));

      const started = performance.now();
      let outcome;
      try {
        outcome = await rpc("tools/call", { name: "get_username", arguments: {} }, task.user.id);
      } catch (error) {
        results.push({ task: "routed", userId: task.user.id, failure: "transport", detail: error.message });
        continue;
      }
      const elapsed = performance.now() - started;
      latencies.push(elapsed);

      const body = outcome.envelope;
      const text = textOf(body);
      const blob = serialized(body);
      const errorCode = body?.error?.data?.errorCode ?? body?.error?.code;

      if (task.kind === "unrouted") {
        results.push({
          task: "unrouted",
          userId: task.user.id,
          status: outcome.status,
          sawRouteNotFound: body?.error?.message?.includes("MCP_IDENTITY_ROUTE_NOT_FOUND") ?? false,
          errorCode,
        });
        continue;
      }

      const expected = task.user.expectUsername;
      const others = USERS.filter((u) => u.id !== task.user.id).map((u) => u.expectUsername);
      const ownName = expected.split("@")[0];

      results.push({
        task: "routed",
        userId: task.user.id,
        expectUsername: expected,
        status: outcome.status,
        ok: text.includes(expected) || blob.includes(expected),
        leakedForeignUsername: others.some((other) => text.includes(other) || blob.includes(other)),
        // Case-insensitive scan for the other user's local part, in case a
        // response reports a bare alias rather than the full username.
        leakedForeignAlias: others.some((other) =>
          blob.toLowerCase().includes(other.split("@")[0].toLowerCase()),
        ),
        sawOwnUsername: blob.includes(ownName),
        errorCode,
      });
    } finally {
      inFlight -= 1;
    }
  }
}

const wallStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const wallMs = performance.now() - wallStart;

const routed = results.filter((entry) => entry.task === "routed");
const unrouted = results.filter((entry) => entry.task === "unrouted");

const identityMismatch = routed.filter((entry) => !entry.ok).length;
const crossUserContamination = routed.filter(
  (entry) => entry.leakedForeignUsername || entry.leakedForeignAlias,
).length;
const transportFailures = results.filter((entry) => entry.failure === "transport").length;
const httpFailures = routed.filter((entry) => entry.status !== 200).length;
const unroutedServed = unrouted.filter((entry) => !entry.sawRouteNotFound).length;

const sorted = [...latencies].sort((a, b) => a - b);
const at = (p) => {
  if (sorted.length === 0) return 0;
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return Number(sorted[rank].toFixed(1));
};

const report = {
  total: plan.length,
  routedCalls: routed.length,
  unroutedCalls: unrouted.length,
  success: routed.filter((entry) => entry.ok && entry.status === 200).length,
  failure: identityMismatch + transportFailures + httpFailures,
  timeout: 0, // no per-call deadline was imposed; recorded instead of guessed
  queued,
  peakInFlight,
  concurrency: CONCURRENCY,
  identityMismatch,
  crossUserContamination,
  unroutedRequestsServed: unroutedServed,
  p50Ms: at(50),
  p95Ms: at(95),
  maxMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
  wallMs: Number(wallMs.toFixed(0)),
};

console.log(JSON.stringify({ report, samples: results.slice(0, 3) }, null, 2));

if (identityMismatch > 0 || crossUserContamination > 0 || unroutedServed > 0 || httpFailures > 0) {
  console.error("FAILED:", JSON.stringify({ identityMismatch, crossUserContamination, unroutedServed, httpFailures }));
  process.exitCode = 1;
}
