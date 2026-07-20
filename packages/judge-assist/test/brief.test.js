import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA,
  buildBriefRequest,
  heuristicBrief,
  generateBrief,
  generateBriefs,
  contentHash,
  promisePool,
  loadCache,
} from "../src/brief.js";

// Tests must never hit the network — make sure no ambient key can leak in.
delete process.env.ANTHROPIC_API_KEY;

const submissions = JSON.parse(
  readFileSync(new URL("../examples/submissions.json", import.meta.url), "utf8")
);

function assertBriefShape(brief) {
  assert.equal(typeof brief.summary, "string");
  assert.ok(brief.summary.length > 0);
  assert.ok(Array.isArray(brief.techStack));
  assert.equal(typeof brief.noveltyNotes, "string");
  assert.ok(Array.isArray(brief.whatToTry) && brief.whatToTry.length > 0);
  assert.ok(Array.isArray(brief.suggestedQuestions) && brief.suggestedQuestions.length === 3);
  assert.ok(Array.isArray(brief.riskFlags));
  for (const k of ["technicalDepth", "completeness", "originality"]) {
    assert.equal(typeof brief.rubricHints[k], "string");
  }
}

// ---------------------------------------------------------------------------
// Heuristic path
// ---------------------------------------------------------------------------

test("heuristic briefs match the schema shape for every sample submission", () => {
  for (const s of submissions) {
    const brief = heuristicBrief(s);
    assert.equal(brief.source, "heuristic");
    assert.equal(brief.id, s.id);
    assertBriefShape(brief);
  }
});

test("heuristic briefs are deterministic", () => {
  const a = heuristicBrief(submissions[0]);
  const b = heuristicBrief(submissions[0]);
  assert.deepEqual(a, b);
});

test("heuristic tech-stack extraction finds keywords and dedupes case-insensitively", () => {
  const brief = heuristicBrief(submissions[0]); // DriftGuard: Go/Kubernetes/Terraform
  assert.ok(brief.techStack.includes("Go"));
  assert.ok(brief.techStack.includes("Terraform"));
  const lower = brief.techStack.map((t) => t.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, `dupes in ${brief.techStack}`);
});

test("heuristic flags missing repo/readme/video as risks", () => {
  const bare = { id: "x", team: "T", title: "Bare", description: "Tiny." };
  const brief = heuristicBrief(bare);
  const flags = brief.riskFlags.join(" ");
  assert.match(flags, /README/i);
  assert.match(flags, /video/i);
  assert.match(flags, /repository/i);
});

// ---------------------------------------------------------------------------
// AI request building (no network)
// ---------------------------------------------------------------------------

test("buildBriefRequest uses structured output with the brief schema and current params", () => {
  const req = buildBriefRequest(submissions[1]);
  assert.equal(req.model, "claude-opus-4-8");
  assert.equal(req.max_tokens, 4096);
  // Structured output via output_config.format — NOT the deprecated output_format.
  assert.equal(req.output_config.format.type, "json_schema");
  assert.deepEqual(req.output_config.format.schema, BRIEF_SCHEMA);
  assert.equal(req.output_format, undefined);
  // No sampling params (removed on this model) and no assistant prefill.
  assert.equal(req.temperature, undefined);
  assert.equal(req.top_p, undefined);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages.at(-1).role, "user");
  // Submission content actually makes it into the prompt.
  assert.match(req.messages[0].content, /FlameLens/);
  assert.match(req.messages[0].content, /README excerpt/);
  // Model override respected.
  assert.equal(buildBriefRequest(submissions[1], { model: "test-model" }).model, "test-model");
});

test("generateBrief with an injected fake client takes the AI path", async () => {
  const seen = [];
  const aiPayload = {
    summary: "A fake summary. It has two sentences.",
    techStack: ["Go"],
    noveltyNotes: "Fake novelty.",
    whatToTry: ["run it"],
    suggestedQuestions: ["q1", "q2", "q3"],
    riskFlags: [],
    rubricHints: { technicalDepth: "a", completeness: "b", originality: "c" },
  };
  const fakeClient = {
    messages: {
      create: async (req) => {
        seen.push(req);
        return { content: [{ type: "text", text: JSON.stringify(aiPayload) }] };
      },
    },
  };

  const brief = await generateBrief(submissions[2], { client: fakeClient });
  assert.equal(brief.source, "ai");
  assert.equal(brief.id, submissions[2].id);
  assert.equal(brief.summary, aiPayload.summary);
  assertBriefShape(brief);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].output_config.format.type, "json_schema");
});

test("generateBrief falls back to heuristic when the API call fails", async () => {
  const failingClient = {
    messages: {
      create: async () => {
        throw new Error("simulated 529 overloaded");
      },
    },
  };
  const brief = await generateBrief(submissions[3], { client: failingClient });
  assert.equal(brief.source, "heuristic");
  assertBriefShape(brief);
});

test("generateBriefs is offline (heuristic) when no key and no client are present", async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  const briefs = await generateBriefs(submissions.slice(0, 4), { cachePath: null });
  assert.equal(briefs.length, 4);
  for (const b of briefs) assert.equal(b.source, "heuristic");
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test("AI briefs are cached by content hash; re-runs don't re-pay", async () => {
  const cachePath = join(tmpdir(), `judge-assist-cache-${process.pid}.json`);
  rmSync(cachePath, { force: true });
  let calls = 0;
  const fakeClient = {
    messages: {
      create: async () => {
        calls++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "s",
                techStack: [],
                noveltyNotes: "n",
                whatToTry: ["t"],
                suggestedQuestions: ["1", "2", "3"],
                riskFlags: [],
                rubricHints: { technicalDepth: "a", completeness: "b", originality: "c" },
              }),
            },
          ],
        };
      },
    },
  };

  const first = await generateBriefs(submissions.slice(0, 3), { client: fakeClient, cachePath });
  assert.equal(calls, 3);
  assert.ok(first.every((b) => b.source === "ai"));

  const second = await generateBriefs(submissions.slice(0, 3), { client: fakeClient, cachePath });
  assert.equal(calls, 3, "cache hit should not call the API again");
  assert.ok(second.every((b) => b.cached === true));

  // Cache keys are content hashes: changing the submission changes the key.
  const h1 = contentHash(submissions[0]);
  const h2 = contentHash({ ...submissions[0], description: "changed" });
  assert.notEqual(h1, h2);
  assert.equal(h1, contentHash(submissions[0]));

  const stored = loadCache(cachePath);
  assert.equal(Object.keys(stored.data).length, 3);
  rmSync(cachePath, { force: true });
});

test("promisePool caps concurrency at the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await promisePool(items, 3, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i * 2;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  assert.deepEqual(out, items.map((i) => i * 2));
});
