import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankEntries,
  condenseEntry,
  entryTextForRanking,
  splitEntries,
  PROMOTION_THRESHOLD,
  AUTO_ONLY_PROMOTION_THRESHOLD,
} from "../src/commands/ranking.js";

function mkCorrection(ts: string, action: string, userSaid: string, auto = false): string {
  const src = auto ? `**source:** auto\n\n` : "";
  return `\n## ${ts}\n\n${src}**agent did:** ${action}\n\n**user said:** ${userSaid}\n\n---\n`;
}

/**
 * Genuinely distinct one-off corrections. They must not share vocabulary with
 * each other — three entries that all say the same thing ARE a theme, and the
 * ranker is right to cluster them.
 */
const ONE_OFFS: Array<[string, string]> = [
  ["wrote a README unprompted", "stop generating markdown docs nobody asked for"],
  ["switched the runtime mid-task", "never change interpreter versions without checking"],
  ["added speculative flexibility", "simplest working solution, no future-proofing"],
  ["renamed a public config key", "leave exported names alone"],
  ["over-commented obvious lines", "annotate only genuinely subtle logic"],
  ["opened a PR without tests", "every behavioural change ships with coverage"],
];

/** Three entries about pathlib (old) + N genuinely unrelated one-offs (recent). */
function pathlibThenOneOffs(oneOffCount: number): string {
  const durable = [
    mkCorrection("2026-01-01T00:00:00Z", "used os.path.join", "always prefer pathlib over os.path"),
    mkCorrection("2026-01-05T00:00:00Z", "reached for os.path again", "pathlib, not os.path — I've said this"),
    mkCorrection("2026-01-09T00:00:00Z", "os.path in the new module", "use pathlib everywhere, no os.path"),
  ].join("");
  const oneOffs = ONE_OFFS.slice(0, oneOffCount)
    .map(([did, said], i) => mkCorrection(`2026-07-${10 + i}T00:00:00Z`, did, said))
    .join("");
  return `# Corrections\n\n${durable}${oneOffs}`;
}

test("a repeated old theme is promoted and survives recent one-offs", () => {
  const raw = pathlibThenOneOffs(3);
  const { standing, recent } = rankEntries(raw, { recentN: 3, maxStanding: 5 });

  assert.equal(standing.length, 1, "pathlib theme should promote to exactly one rule");
  assert.match(standing[0]!.line, /pathlib/);
  assert.equal(standing[0]!.count, 3, "should report 3 recurrences");
  // The three promoted entries are not repeated in the recent tail.
  assert.equal(recent.length, 3);
  for (const entry of recent) {
    assert.doesNotMatch(entry, /pathlib/, "promoted entries must not double-appear");
  }
});

test("promotion beats recency: the durable rule outlives its own recency window", () => {
  // 6 recent one-offs would completely flush a last-3 window of the old entries.
  const { standing } = rankEntries(pathlibThenOneOffs(6), { recentN: 3, maxStanding: 5 });
  assert.equal(standing.length, 1);
  assert.match(standing[0]!.line, /pathlib/);
});

test("threshold boundary: 2 recurrences do not promote, 3 do", () => {
  const two = `# C\n${mkCorrection("2026-01-01T00:00:00Z", "a", "always prefer pathlib")}${mkCorrection("2026-01-02T00:00:00Z", "b", "prefer pathlib please")}`;
  assert.equal(rankEntries(two, { recentN: 3, maxStanding: 5 }).standing.length, 0);

  const three = two + mkCorrection("2026-01-03T00:00:00Z", "c", "pathlib, again");
  assert.equal(rankEntries(three, { recentN: 3, maxStanding: 5 }).standing.length, 1);
  assert.equal(PROMOTION_THRESHOLD, 3);
});

test("a cluster collapses to one line regardless of size", () => {
  const five = `# C\n` + Array.from({ length: 5 }, (_, i) =>
    mkCorrection(`2026-02-0${i + 1}T00:00:00Z`, `os.path use ${i}`, "always prefer pathlib over os.path"),
  ).join("");
  const { standing } = rankEntries(five, { recentN: 3, maxStanding: 5 });
  assert.equal(standing.length, 1);
  assert.equal(standing[0]!.count, 5);
});

test("representative is the newest entry in the cluster (cheap superseding)", () => {
  const raw =
    `# C\n` +
    mkCorrection("2026-01-01T00:00:00Z", "a", "always prefer pathlib") +
    mkCorrection("2026-01-02T00:00:00Z", "b", "prefer pathlib over os.path") +
    mkCorrection("2026-01-03T00:00:00Z", "c", "prefer pathlib except in hot loops");
  const { standing } = rankEntries(raw, { recentN: 3, maxStanding: 5 });
  assert.match(standing[0]!.line, /hot loops/, "newest phrasing should win");
});

test("auto-only clusters need a higher bar than hand-logged ones", () => {
  const mk = (n: number, auto: boolean) =>
    `# C\n` + Array.from({ length: n }, (_, i) =>
      mkCorrection(`2026-03-0${i + 1}T00:00:00Z`, `x${i}`, "always prefer pathlib over os.path", auto),
    ).join("");

  // 3 hand-logged → promoted.
  assert.equal(rankEntries(mk(3, false), { recentN: 3, maxStanding: 5 }).standing.length, 1);
  // 3 auto-only → NOT promoted (no human ever confirmed it).
  assert.equal(rankEntries(mk(3, true), { recentN: 3, maxStanding: 5 }).standing.length, 0);
  // 5 auto-only → promoted.
  assert.equal(rankEntries(mk(5, true), { recentN: 3, maxStanding: 5 }).standing.length, 1);
  assert.equal(AUTO_ONLY_PROMOTION_THRESHOLD, 5);
});

test("a mixed cluster promotes because a human confirmed it", () => {
  const raw =
    `# C\n` +
    mkCorrection("2026-04-01T00:00:00Z", "a", "always prefer pathlib over os.path", true) +
    mkCorrection("2026-04-02T00:00:00Z", "b", "prefer pathlib not os.path", true) +
    mkCorrection("2026-04-03T00:00:00Z", "c", "pathlib over os.path, please", false);
  const { standing } = rankEntries(raw, { recentN: 3, maxStanding: 5 });
  assert.equal(standing.length, 1);
  // Representative prefers the hand-logged entry even though autos are adjacent.
  assert.match(standing[0]!.line, /please/);
});

test("entry boilerplate labels never become a theme", () => {
  // Five unrelated corrections share only the **agent did:** / **user said:**
  // scaffolding. If labels were tokenized, "agent" would appear in all five and
  // cluster them into one bogus rule.
  const raw =
    `# C\n` +
    mkCorrection("2026-05-01T00:00:00Z", "wrote a README unprompted", "stop generating markdown files") +
    mkCorrection("2026-05-02T00:00:00Z", "switched Python version", "don't change runtimes") +
    mkCorrection("2026-05-03T00:00:00Z", "added speculative flexibility", "simplest working solution only") +
    mkCorrection("2026-05-04T00:00:00Z", "over-commented obvious code", "comments only where non-obvious") +
    mkCorrection("2026-05-05T00:00:00Z", "renamed the config key", "leave public names alone");
  assert.equal(rankEntries(raw, { recentN: 3, maxStanding: 5 }).standing.length, 0);
  assert.doesNotMatch(entryTextForRanking(splitEntries(raw)[0]!), /agent did/);
});

test("superseded entries are excluded from ranking", () => {
  const raw =
    `# C\n` +
    mkCorrection("2026-06-01T00:00:00Z", "a", "always prefer pathlib") +
    mkCorrection("2026-06-02T00:00:00Z", "b", "prefer pathlib") +
    `\n## 2026-06-03T00:00:00Z\n\n**superseded:** true\n\n**user said:** prefer pathlib\n\n---\n`;
  // Only 2 live entries share the theme → below threshold.
  assert.equal(rankEntries(raw, { recentN: 3, maxStanding: 5 }).standing.length, 0);
});

test("maxStanding caps how many rules render", () => {
  let raw = "# C\n";
  for (const word of ["pathlib", "typescript", "pytest"]) {
    for (let i = 0; i < 3; i++) {
      raw += mkCorrection(`2026-0${i + 1}-1${word.length}T00:00:00Z`, `${word} slip`, `always use ${word} here`);
    }
  }
  const { standing } = rankEntries(raw, { recentN: 3, maxStanding: 2 });
  assert.equal(standing.length, 2, "must respect maxStanding");
});

test("condenseEntry prefers lesson, then user said, then tried", () => {
  assert.equal(
    condenseEntry("## ts\n\n**user said:** be terse\n\n**lesson:** brevity wins"),
    "brevity wins",
  );
  assert.equal(condenseEntry("## ts\n\n**user said:** be terse"), "be terse");
  assert.equal(condenseEntry("## ts\n\n**tried:** npm test\n\n**fix:** none"), "npm test");
});

test("empty and template-only input rank to nothing", () => {
  assert.deepEqual(rankEntries("", { recentN: 3, maxStanding: 5 }), { standing: [], recent: [] });
  assert.deepEqual(rankEntries("# Corrections\n\n<!-- banner -->\n", { recentN: 3, maxStanding: 5 }), {
    standing: [],
    recent: [],
  });
});
