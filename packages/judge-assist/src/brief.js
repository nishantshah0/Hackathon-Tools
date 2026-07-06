// AI judge briefs: turn a raw submission into a one-page orientation sheet for a judge.
//
// Two paths:
//   - "ai":        Anthropic Messages API with structured output (json_schema) so the
//                  response is guaranteed to parse into BRIEF_SCHEMA.
//   - "heuristic": deterministic offline fallback used when no API key / client is
//                  available or the API call fails. Everything (tests, demo) works
//                  without a key and never touches the network.
//
// Briefs are cached to a local JSON file keyed by a content hash of the submission
// (+ model), so re-runs don't re-pay for API calls.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
export const DEFAULT_CACHE_PATH = ".briefs-cache.json";
export const MAX_CONCURRENCY = 3;

/** JSON schema for a judge brief — used as the structured-output contract. */
export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two-sentence plain-language summary of what the project is and does.",
    },
    techStack: {
      type: "array",
      items: { type: "string" },
      description: "Technologies actually used by the project.",
    },
    noveltyNotes: {
      type: "string",
      description: "What is genuinely new or interesting here vs. off-the-shelf tools.",
    },
    whatToTry: {
      type: "array",
      items: { type: "string" },
      description: "Concrete 'click this / run this' steps a judge can do in under 5 minutes.",
    },
    suggestedQuestions: {
      type: "array",
      items: { type: "string" },
      description: "Exactly 3 sharp questions to ask the team.",
    },
    riskFlags: {
      type: "array",
      items: { type: "string" },
      description: "Red flags, e.g. demo video doesn't show the described feature.",
    },
    rubricHints: {
      type: "object",
      properties: {
        technicalDepth: { type: "string" },
        completeness: { type: "string" },
        originality: { type: "string" },
      },
      required: ["technicalDepth", "completeness", "originality"],
      additionalProperties: false,
      description:
        "One-sentence observations (NOT scores) to orient the judge on each rubric axis.",
    },
  },
  required: [
    "summary",
    "techStack",
    "noveltyNotes",
    "whatToTry",
    "suggestedQuestions",
    "riskFlags",
    "rubricHints",
  ],
  additionalProperties: false,
};

/** Stable content hash used as the cache key for a (submission, model) pair. */
export function contentHash(submission, model = DEFAULT_MODEL) {
  const stable = JSON.stringify(
    Object.keys(submission)
      .sort()
      .reduce((acc, k) => ((acc[k] = submission[k]), acc), {})
  );
  return createHash("sha256").update(model + "\n" + stable).digest("hex").slice(0, 32);
}

/**
 * Build the Messages API request for a brief. Pure function so tests can assert
 * on the exact request shape without any network access.
 *
 * NOTE: uses `output_config.format` (json_schema) — the current structured-output
 * parameter. No temperature/top_p (removed on this model), no assistant prefill.
 */
export function buildBriefRequest(submission, { model = DEFAULT_MODEL } = {}) {
  const parts = [
    `Team: ${submission.team}`,
    `Title: ${submission.title}`,
    `Description: ${submission.description || "(none provided)"}`,
    `Repo: ${submission.repoUrl || "(none provided)"}`,
  ];
  if (submission.techStack?.length) parts.push(`Declared tech stack: ${submission.techStack.join(", ")}`);
  if (submission.readme) parts.push(`README excerpt:\n${submission.readme}`);
  if (submission.videoTranscript) parts.push(`Demo video transcript:\n${submission.videoTranscript}`);

  return {
    model,
    max_tokens: 4096,
    output_config: {
      format: { type: "json_schema", schema: BRIEF_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content:
          "You are preparing a one-page orientation brief for a hackathon judge who has " +
          "10 minutes per project. Be concrete and skeptical: cross-check the description " +
          "against the README and video transcript, flag mismatches as riskFlags, and give " +
          "the judge exact things to click/run. rubricHints are observations to orient the " +
          "judge, never scores — judges score, you orient.\n\n" +
          "Submission:\n" +
          parts.join("\n\n"),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Heuristic (offline) brief generation — fully deterministic.
// ---------------------------------------------------------------------------

const TECH_KEYWORDS = [
  ["Kubernetes", /\bkubernetes\b|\bk8s\b|\bkubectl\b/i],
  ["Terraform", /\bterraform\b/i],
  ["Docker", /\bdocker\b|\bcontainerd\b/i],
  ["eBPF", /\bebpf\b|\bbpf\b/i],
  ["Go", /\bgolang\b|\bgo(?:\s+(?:binary|service|program|module))\b|written in go\b/i],
  ["Rust", /\brust\b|\bcargo\b/i],
  ["Python", /\bpython\b|\bpip\b|\bfastapi\b|\bflask\b/i],
  ["Node.js", /\bnode\.js\b|\bnodejs\b|\bnpm\b|\bexpress\b/i],
  ["TypeScript", /\btypescript\b/i],
  ["React", /\breact\b/i],
  ["PostgreSQL", /\bpostgres(?:ql)?\b/i],
  ["Redis", /\bredis\b/i],
  ["Kafka", /\bkafka\b/i],
  ["Prometheus", /\bprometheus\b/i],
  ["Grafana", /\bgrafana\b/i],
  ["OpenTelemetry", /\bopentelemetry\b|\botel\b/i],
  ["WebAssembly", /\bwasm\b|\bwebassembly\b/i],
  ["AWS", /\baws\b|\blambda\b|\bec2\b|\bs3\b/i],
  ["GCP", /\bgcp\b|\bgoogle cloud\b/i],
  ["gRPC", /\bgrpc\b/i],
  ["Nginx", /\bnginx\b/i],
  ["Envoy", /\benvoy\b/i],
  ["QUIC", /\bquic\b/i],
  ["SQLite", /\bsqlite\b/i],
  ["WireGuard", /\bwireguard\b/i],
  ["systemd", /\bsystemd\b/i],
  ["Ansible", /\bansible\b/i],
  ["NATS", /\bnats\b/i],
  ["ClickHouse", /\bclickhouse\b/i],
];

function firstSentences(text, n = 2) {
  if (!text) return "";
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, n).join(" ");
}

/** Deterministic offline brief. Same submission in → same brief out, always. */
export function heuristicBrief(submission) {
  const corpus = [submission.description, submission.readme, submission.videoTranscript]
    .filter(Boolean)
    .join("\n");

  const detected = TECH_KEYWORDS.filter(([, re]) => re.test(corpus)).map(([name]) => name);
  // Merge declared + detected, deduping case-insensitively (declared spelling wins).
  const techStack = [];
  const seen = new Set();
  for (const t of [...(submission.techStack || []), ...detected]) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      techStack.push(t);
    }
  }

  const summary =
    firstSentences(submission.description, 2) ||
    `${submission.title} by team ${submission.team}. No description was provided.`;

  const whatToTry = [];
  if (submission.repoUrl) {
    whatToTry.push(`Open ${submission.repoUrl} and read the README top to bottom.`);
    whatToTry.push(
      `Clone ${submission.repoUrl} and run the quickstart/setup commands from the README.`
    );
  } else {
    whatToTry.push("Ask the team for the repo link — none was submitted.");
  }
  if (submission.videoTranscript) {
    whatToTry.push("Skim the demo video and verify it shows the core feature described above.");
  }
  whatToTry.push("Ask the team for a 2-minute live demo of the single most impressive flow.");

  const suggestedQuestions = [
    "What breaks first if this gets 10x the load you demoed, and how would you know?",
    "Which parts were built during the hackathon versus pre-existing code or libraries?",
    "What was the hardest technical decision you made this weekend, and what did you trade away?",
  ];

  const riskFlags = [];
  if (!submission.readme) riskFlags.push("No README excerpt provided — verify the repo is real and runnable.");
  if (!submission.videoTranscript)
    riskFlags.push("No demo video/transcript — the described features are unverified claims.");
  if (!submission.repoUrl) riskFlags.push("No repository URL submitted.");
  if ((submission.description || "").length < 120)
    riskFlags.push("Very short description — scope of the actual build is unclear.");

  const stackNote = techStack.length
    ? `Keyword scan found: ${techStack.slice(0, 6).join(", ")}.`
    : "No recognizable technologies detected from the text.";

  return {
    id: submission.id,
    source: "heuristic",
    summary,
    techStack,
    noveltyNotes:
      `Heuristic brief (no AI available): novelty was not assessed by a model. ${stackNote} ` +
      "Compare the claimed capability against off-the-shelf tools in the same space.",
    whatToTry,
    suggestedQuestions,
    riskFlags,
    rubricHints: {
      technicalDepth: techStack.length
        ? `Stack mentions ${techStack.slice(0, 4).join(", ")} — probe how deeply each is actually used rather than name-dropped.`
        : "No stack detected — ask the team to walk through their architecture before scoring depth.",
      completeness: submission.readme
        ? "README exists; check whether the documented setup actually runs end to end."
        : "No README provided; treat completeness claims with skepticism until demoed live.",
      originality:
        "Heuristic mode cannot judge novelty — ask the team what exists already and why theirs is different.",
    },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function loadCache(path = DEFAULT_CACHE_PATH) {
  let data = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = {};
  }
  return { path, data };
}

export function saveCache(cache) {
  writeFileSync(cache.path, JSON.stringify(cache.data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function resolveClient(injected) {
  if (injected !== undefined) return injected; // allow explicit null to force offline
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic(); // resolves ANTHROPIC_API_KEY from env
}

/**
 * Generate a brief for one submission.
 * options:
 *   client — an Anthropic-compatible client ({messages: {create}}); pass null to force offline
 *   model  — model id (default claude-opus-4-8, override via ANTHROPIC_MODEL)
 *   cache  — cache object from loadCache(); consulted and updated in memory
 */
export async function generateBrief(submission, { client = null, model = DEFAULT_MODEL, cache = null } = {}) {
  const key = contentHash(submission, model);
  if (cache?.data[key]) return { ...cache.data[key], cached: true };

  let brief;
  if (client) {
    try {
      const response = await client.messages.create(buildBriefRequest(submission, { model }));
      const text = response.content.find((b) => b.type === "text")?.text;
      brief = { id: submission.id, source: "ai", ...JSON.parse(text) };
    } catch {
      brief = heuristicBrief(submission); // API failure → deterministic fallback
    }
  } else {
    brief = heuristicBrief(submission);
  }

  if (cache) cache.data[key] = brief;
  return brief;
}

/** Tiny promise pool — at most `limit` in-flight tasks. */
export async function promisePool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Generate briefs for many submissions with concurrency capped at 3.
 * Persists the cache to disk (cachePath) unless cachePath === null.
 */
export async function generateBriefs(
  submissions,
  { client, model = DEFAULT_MODEL, cachePath = DEFAULT_CACHE_PATH, concurrency = MAX_CONCURRENCY } = {}
) {
  const resolved = await resolveClient(client);
  const cache = cachePath === null ? null : loadCache(cachePath);
  const briefs = await promisePool(submissions, Math.min(concurrency, MAX_CONCURRENCY), (s) =>
    generateBrief(s, { client: resolved, model, cache })
  );
  if (cache) saveCache(cache);
  return briefs;
}
