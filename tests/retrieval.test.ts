import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retrieveForTask,
  retrieveFromRaw,
  relevanceScore,
  buildIdf,
  RECURRENCE_WEIGHT,
} from "../src/commands/retrieval.js";

function mk(ts: string, said: string): string {
  return `## ${ts}\n\n**agent did:** something\n\n**user said:** ${said}`;
}

const CORPUS = [
  { id: "a", text: mk("2026-01-01T00:00:00Z", "always prefer pathlib over os.path when joining paths") },
  { id: "b", text: mk("2026-02-01T00:00:00Z", "never log the customer email address in plaintext") },
  { id: "c", text: mk("2026-03-01T00:00:00Z", "keep the changelog entries in past tense") },
];

test("an on-topic entry outranks off-topic ones", () => {
  const ranked = retrieveForTask(CORPUS, "fix the file loader to build paths with pathlib");
  assert.equal(ranked[0]!.id, "a");
});

test("a different task promotes a different entry", () => {
  const ranked = retrieveForTask(CORPUS, "audit what we write to the logs about customers");
  assert.equal(ranked[0]!.id, "b", "task should drive the ordering, not position");
});

test("recurrence is off by default — measured, not assumed", () => {
  // The eval scored pure relevance at F1 0.789 and every blended weight at
  // 0.595; the default encodes that result.
  assert.equal(RECURRENCE_WEIGHT, 0);
});

test("a single-mention entry can still win — recurrence is not required", () => {
  // The recurrence ranker scored 0 on exactly this shape: one critical
  // correction, stated once, drowned out by a repeated but unrelated theme.
  const corpus = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `nag${i}`,
      text: mk(`2026-04-0${i + 1}T00:00:00Z`, "wrap markdown lines at eighty columns"),
    })),
    { id: "sec", text: mk("2026-01-01T00:00:00Z", "never commit the signing key to the repository") },
  ];
  const ranked = retrieveForTask(corpus, "rotate the release signing key and update CI");
  assert.equal(ranked[0]!.id, "sec", "one relevant mention must beat a 5x irrelevant theme");
});

test("a large irrelevant cluster does not fill the results", () => {
  const corpus = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `fmt${i}`,
      text: mk(`2026-04-0${i + 1}T00:00:00Z`, "wrap markdown lines at eighty columns"),
    })),
    { id: "db", text: mk("2026-05-01T00:00:00Z", "always run migrations inside a transaction") },
  ];
  const top = retrieveForTask(corpus, "write the migration that adds the invoices table").slice(0, 3);
  assert.ok(top.some((e) => e.id === "db"), "the on-topic entry must make the cutoff");
});

test("buildIdf drops terms present in nearly every entry", () => {
  const texts = Array.from({ length: 5 }, (_, i) => mk(`2026-0${i + 1}-01T00:00:00Z`, "ubiquitous filler token here"));
  const idf = buildIdf(texts);
  assert.ok(!idf.has("ubiquitous"), "a term in 100% of entries carries no signal");
});

test("relevanceScore is zero when nothing overlaps", () => {
  const idf = buildIdf(CORPUS.map((e) => e.text));
  const score = relevanceScore(new Set(["kubernetes", "helm chart"]), CORPUS[0]!.text, idf);
  assert.equal(score, 0);
});

test("length damping stops a long rambling entry winning on surface area", () => {
  const corpus = [
    { id: "short", text: mk("2026-01-01T00:00:00Z", "always prefer pathlib") },
    {
      id: "long",
      text: mk(
        "2026-02-01T00:00:00Z",
        "pathlib " + Array.from({ length: 120 }, (_, i) => `unrelated${i}`).join(" "),
      ),
    },
  ];
  const ranked = retrieveForTask(corpus, "use pathlib for the new loader");
  assert.equal(ranked[0]!.id, "short");
});

test("ordering is deterministic for equal scores", () => {
  const corpus = [
    { id: "zeta", text: mk("2026-01-01T00:00:00Z", "identical wording here") },
    { id: "alpha", text: mk("2026-02-01T00:00:00Z", "identical wording here") },
  ];
  const first = retrieveForTask(corpus, "identical wording").map((e) => e.id);
  const second = retrieveForTask(corpus, "identical wording").map((e) => e.id);
  assert.deepEqual(first, second);
  assert.equal(first[0], "alpha", "ties break alphabetically by id");
});

test("retrieveFromRaw parses markdown and skips header-less entries", () => {
  const raw = `# Corrections\n\n${mk("2026-01-01T00:00:00Z", "always prefer pathlib")}\n\n---\n`;
  const ranked = retrieveFromRaw(raw, "pathlib work");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.id, "2026-01-01T00:00:00Z");
});

test("an empty corpus retrieves nothing", () => {
  assert.deepEqual(retrieveForTask([], "anything"), []);
  assert.deepEqual(retrieveFromRaw("", "anything"), []);
});

test("a tiny corpus still retrieves — the doc-frequency ceiling must not empty it", () => {
  // Regression: with one entry every term trivially appears in 100% of the
  // corpus, so the ceiling discarded the whole vocabulary and the retriever
  // returned nothing. A project with two corrections got no retrieval at all.
  // The eval corpus never caught it — every scenario has 5+ entries.
  const one = [{ id: "solo", text: mk("2026-01-01T00:00:00Z", "always prefer pathlib over os.path") }];
  assert.equal(retrieveForTask(one, "build paths with pathlib").length, 1);

  const two = [
    { id: "a", text: mk("2026-01-01T00:00:00Z", "always prefer pathlib over os.path") },
    { id: "b", text: mk("2026-02-01T00:00:00Z", "never log customer email in plaintext") },
  ];
  assert.equal(retrieveForTask(two, "build paths with pathlib")[0]!.id, "a");
});

test("plurals match their singular — stemming is on", () => {
  const corpus = [
    { id: "mig", text: mk("2026-01-01T00:00:00Z", "always run migrations inside a transaction") },
    { id: "css", text: mk("2026-02-01T00:00:00Z", "keep the stylesheet in one file") },
  ];
  const ranked = retrieveForTask(corpus, "write the migration that adds the invoices table");
  assert.equal(ranked[0]!.id, "mig", "'migration' must match 'migrations'");
});
