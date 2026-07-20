#!/usr/bin/env node
// judge-assist CLI
//
//   brief <submissions.json> [--out briefs.json] [--model id]
//   schedule <submissions.json> --judges <judges.json> --per-judge N [--seed N] [--out assignments.json]
//   rank <results.json>
//   normalize <scores.json> [--weights '{"technical":2,"design":1}']
//   simulate <submissions.json> [--judges N] [--per-judge N] [--seed N] [--noise F]

import { readFileSync, writeFileSync } from "node:fs";
import { generateBriefs } from "../src/brief.js";
import { scheduleComparisons, appearanceCounts } from "../src/schedule.js";
import { bradleyTerry, kendallTau } from "../src/rank.js";
import { normalizeScores } from "../src/normalize.js";
import { simulate } from "../src/simulate.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`Could not read ${what} from ${path}: ${err.message}`);
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const pad = (s, w) => String(s).padEnd(w);
const num = (x, d = 3) => Number(x).toFixed(d);
const bar = (frac, width = 10) => "█".repeat(Math.round(frac * width)).padEnd(width, "·");
const hr = (w = 78) => "─".repeat(w);

// ---------------------------------------------------------------------------

async function cmdBrief(args) {
  const path = args._[0] || fail("usage: judge-assist brief <submissions.json> [--out briefs.json]");
  const submissions = loadJson(path, "submissions");
  const briefs = await generateBriefs(submissions, args.model ? { model: args.model } : {});

  const byId = new Map(submissions.map((s) => [s.id, s]));
  for (const b of briefs) {
    const s = byId.get(b.id) || {};
    console.log(hr());
    console.log(`  ${s.title || b.id}  —  team ${s.team || "?"}   [${b.source}${b.cached ? ", cached" : ""}]`);
    console.log(hr());
    console.log(`  SUMMARY     ${b.summary}`);
    console.log(`  TECH STACK  ${b.techStack.join(", ") || "(none detected)"}`);
    console.log(`  NOVELTY     ${b.noveltyNotes}`);
    console.log(`  TRY THIS`);
    for (const t of b.whatToTry) console.log(`    • ${t}`);
    console.log(`  ASK THE TEAM`);
    for (const q of b.suggestedQuestions) console.log(`    ? ${q}`);
    if (b.riskFlags.length) {
      console.log(`  RISK FLAGS`);
      for (const r of b.riskFlags) console.log(`    ⚠ ${r}`);
    }
    console.log(`  RUBRIC ORIENTATION (observations, not scores)`);
    console.log(`    depth:        ${b.rubricHints.technicalDepth}`);
    console.log(`    completeness: ${b.rubricHints.completeness}`);
    console.log(`    originality:  ${b.rubricHints.originality}`);
    console.log();
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(briefs, null, 2) + "\n");
    console.log(`wrote ${briefs.length} briefs to ${args.out}`);
  }
}

function cmdSchedule(args) {
  const path = args._[0] || fail("usage: judge-assist schedule <submissions.json> --judges <judges.json> --per-judge N [--seed N]");
  if (!args.judges) fail("--judges <judges.json> is required");
  if (!args["per-judge"]) fail("--per-judge N is required");
  const submissions = loadJson(path, "submissions");
  const judges = loadJson(args.judges, "judges");
  const perJudge = parseInt(args["per-judge"], 10);
  const seed = parseInt(args.seed ?? "1", 10);
  const strengths = args.strengths ? loadJson(args.strengths, "strengths") : null;

  const assignments = scheduleComparisons({ submissions, judges, perJudge, seed, strengths });

  console.log(`Scheduled ${assignments.length} comparisons (${judges.length} judges × up to ${perJudge}, seed ${seed})\n`);
  console.log(`  ${pad("#", 4)}${pad("judge", 12)}${pad("A", 6)}vs  B`);
  assignments.forEach((a, i) =>
    console.log(`  ${pad(i + 1, 4)}${pad(a.judge, 12)}${pad(a.projectA, 6)}vs  ${a.projectB}`)
  );

  const counts = appearanceCounts(assignments);
  const values = [...counts.values()];
  console.log(`\nProject appearance balance: min ${Math.min(...values)}, max ${Math.max(...values)}`);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(assignments, null, 2) + "\n");
    console.log(`wrote assignments to ${args.out}`);
  }
}

function printRanking(fit, { titles = new Map(), truePos = null } = {}) {
  console.log(`  ${pad("rank", 6)}${pad("project", 26)}${pad("strength", 10)}${pad("W-L", 8)}${pad("conf", 16)}${truePos ? "true rank" : ""}`);
  console.log(`  ${hr(70)}`);
  for (const r of fit.ranking) {
    const label = titles.get(r.id) ? `${r.id} ${titles.get(r.id)}`.slice(0, 24) : r.id;
    const t = truePos ? `#${truePos.get(r.id) + 1}` : "";
    console.log(
      `  ${pad("#" + r.rank, 6)}${pad(label, 26)}${pad(num(r.strength, 3), 10)}${pad(`${r.wins}-${r.losses}`, 8)}${bar(r.confidence)} ${pad(num(r.confidence, 2), 5)}${t}`
    );
  }
  console.log(`\n  Bradley-Terry converged: ${fit.converged} (${fit.iterations} iterations)`);
  console.log(`\n  Judge agreement with final ranking:`);
  for (const [judge, s] of Object.entries(fit.judgeAgreement)) {
    console.log(
      `    ${pad(judge, 12)}${s.agreed}/${s.total} (${num(s.rate * 100, 0)}%)${s.outlier ? "   ⚠ OUTLIER — votes diverge from consensus" : ""}`
    );
  }
}

function cmdRank(args) {
  const path = args._[0] || fail("usage: judge-assist rank <results.json>");
  const results = loadJson(path, "results");
  const fit = bradleyTerry(results);
  console.log(`Bradley-Terry ranking from ${results.length} pairwise results\n`);
  printRanking(fit);
}

function cmdNormalize(args) {
  const path = args._[0] || fail("usage: judge-assist normalize <scores.json> [--weights '{\"technical\":2}']");
  const scores = loadJson(path, "scores");
  let weights = null;
  if (args.weights) {
    try {
      weights = JSON.parse(args.weights);
    } catch {
      fail("--weights must be a JSON object like '{\"technical\":2,\"design\":1}'");
    }
  }
  const report = normalizeScores(scores, { weights });

  console.log(`Score normalization over ${scores.length} raw scores, criteria: ${report.criteria.join(", ")}`);
  if (weights) console.log(`Criterion weights: ${JSON.stringify(weights)}`);

  console.log(`\n  Judge calibration (why raw averages are unfair):`);
  console.log(`  ${pad("judge", 12)}${pad("n", 5)}${pad("mean", 8)}${pad("std", 8)}leniency`);
  for (const j of report.judges) {
    const tag = j.leniencyRank === 1 ? "most generous" : j.leniencyRank === report.judges.length ? "harshest" : "";
    console.log(`  ${pad(j.judge, 12)}${pad(j.count, 5)}${pad(num(j.mean, 2), 8)}${pad(num(j.std, 2), 8)}#${j.leniencyRank} ${tag}${j.shrunk ? " (small-sample shrinkage)" : ""}`);
  }

  console.log(`\n  ${pad("project", 10)}${pad("raw mean", 10)}${pad("normalized", 12)}${pad("raw→norm", 12)}movement`);
  console.log(`  ${hr(56)}`);
  for (const p of report.projects) {
    const move = p.rankChange > 0 ? `▲${p.rankChange}` : p.rankChange < 0 ? `▼${-p.rankChange}` : "·";
    console.log(
      `  ${pad(p.project, 10)}${pad(num(p.rawMean, 2), 10)}${pad(num(p.normalizedScore, 3), 12)}${pad(`#${p.rawRank} → #${p.normalizedRank}`, 12)}${move}`
    );
  }
}

function cmdSimulate(args) {
  const path = args._[0] || fail("usage: judge-assist simulate <submissions.json> [--judges N] [--per-judge N] [--seed N]");
  const submissions = loadJson(path, "submissions");
  const numJudges = parseInt(args.judges ?? "5", 10);
  const perJudge = parseInt(args["per-judge"] ?? "8", 10);
  const seed = parseInt(args.seed ?? "1", 10);
  const noise = args.noise ? parseFloat(args.noise) : undefined;

  const sim = simulate({ submissions, numJudges, perJudge, seed, ...(noise !== undefined && { noise }) });

  const titles = new Map(submissions.map((s) => [s.id, s.title]));
  const truePos = new Map(sim.trueRanking.map((id, i) => [id, i]));

  console.log(`judge-assist end-to-end simulation`);
  console.log(`  ${submissions.length} projects, ${numJudges} judges, ${perJudge} comparisons each (2 rounds, round 2 adaptive), seed ${seed}\n`);
  console.log(`Recovered ranking vs hidden true ranking:\n`);
  printRanking(sim.fit, { titles, truePos });

  console.log(`\n  Kendall tau (recovered vs true): ${num(sim.tau, 3)}   (1.0 = perfect order recovery)`);
  console.log(
    `  Comparisons used: ${sim.comparisonsUsed} — a full per-judge round-robin would need ${sim.roundRobinComparisons} (${num(
      (100 * sim.comparisonsUsed) / sim.roundRobinComparisons,
      1
    )}% of the judging effort)`
  );
}

// ---------------------------------------------------------------------------

const HELP = `judge-assist — cut hackathon judging time

commands:
  brief <submissions.json> [--out briefs.json]        AI (or offline heuristic) judge briefs
  schedule <submissions.json> --judges <judges.json> --per-judge N [--seed N] [--strengths s.json] [--out a.json]
  rank <results.json>                                 Bradley-Terry ranking from pairwise votes
  normalize <scores.json> [--weights JSON]            z-score normalization of raw rubric scores
  simulate <submissions.json> [--judges N] [--per-judge N] [--seed N] [--noise F]

env:
  ANTHROPIC_API_KEY   optional — enables AI briefs; without it, deterministic heuristic briefs
  ANTHROPIC_MODEL     optional model override (default claude-opus-4-8)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "brief":
      return cmdBrief(args);
    case "schedule":
      return cmdSchedule(args);
    case "rank":
      return cmdRank(args);
    case "normalize":
      return cmdNormalize(args);
    case "simulate":
      return cmdSimulate(args);
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => fail(err.message));
