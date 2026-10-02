/**
 * Baseline comparison suite: question derivation, the cortex arm's
 * fail-closed behavior, and that a raw-LLM arm is scored by exactly the same
 * rules — including being caught when it invents an answer.
 *
 * Runs fully offline: the LLM arms take a deterministic scripted model, so CI
 * measures the mechanics without a vendor account (AC-2.1).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StubExtractionProvider } from "../stub";
import type { ModelProvider } from "../../../core/knowledge/provider/kinds";
import { generateQuestions, loadCorpus, runBaseline, renderBaseline } from "../../../eval/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(here, "../../../eval/corpus-demo");
const NOW = () => "2026-08-08T00:00:00Z";

const stub = new StubExtractionProvider();
const corpus = loadCorpus(DEMO_DIR);

/** A scripted stand-in for a raw LLM. `reply` sees the prompt, returns text. */
function scriptedModel(reply: (prompt: string) => string): ModelProvider {
  return {
    descriptor: {
      id: "scripted-model",
      kind: "model",
      capabilities: [],
      configSchema: {},
    },
    complete: ({ prompt }) =>
      Promise.resolve({
        text: reply(prompt),
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
  };
}

/** Always answers, always with the same wrong number — the failure under test. */
const confidentlyWrong = scriptedModel(() =>
  JSON.stringify({
    known: true,
    value: "0.030",
    unit: "mA",
    qualifier: "MAX",
    conditions: "VIN = 3.6 V",
    page: 1,
    quote: "invented",
  }),
);

/** Always abstains — the safe, useless arm. */
const alwaysAbstains = scriptedModel(() => JSON.stringify({ known: false }));

describe("question derivation", () => {
  it("derives one question per field and qualifier, naming both", () => {
    const questions = generateQuestions(corpus, "dev");
    expect(questions.length).toBeGreaterThan(0);

    const iqMax = questions.find((q) => q.id === "tps62840-text:iq_max_mA:MAX");
    expect(iqMax).toBeDefined();
    expect(iqMax!.part).toBe("ti:TPS62840DLCR");
    expect(iqMax!.parameterKey).toBe("iq_uA");
    // The qualifier and the conditions are in the question: no arm has to
    // guess which datasheet cell is meant.
    expect(iqMax!.question).toContain("MAX");
    expect(iqMax!.question).toContain("VIN = 3.6 V");
  });

  it("carries ABSENT labels through as unanswerable questions", () => {
    const questions = generateQuestions(corpus, "dev");
    const absent = questions.filter((q) => q.expected === "ABSENT");
    expect(absent.length).toBeGreaterThan(0);
  });

  it("rejects an unknown release set", () => {
    expect(() => generateQuestions(corpus, "nope")).toThrow(/unknown release set/);
  });
});

describe("cortex arm", () => {
  it("answers from admitted facts, cites them, and never fabricates", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["cortex"],
    });
    const cortex = report.arms.find((a) => a.arm === "cortex")!;

    expect(cortex.answered).toBeGreaterThan(0);
    // Every answer comes from a reading the pipeline admitted, so it carries
    // the real evidence region.
    expect(cortex.citationAccuracy).toBe(1);
    // Fail-closed: the unanswerable question has no admitted reading behind
    // it, so cortex abstains rather than inventing (AC-15.3).
    expect(cortex.fabricated).toBe(0);
    expect(cortex.fabricationRate).toBe(0);
    expect(cortex.abstained).toBeGreaterThan(0);
    // Deterministic by construction.
    expect(cortex.consistency).toBe(1);
    // Extraction is paid once per document, not per question.
    expect(cortex.oneTimeIngestMs).toBeGreaterThanOrEqual(0);
  });

  it("is byte-identical across runs", async () => {
    const options = { releaseSet: "dev", now: NOW, arms: ["cortex" as const] };
    const first = await runBaseline(corpus, stub, options);
    const second = await runBaseline(corpus, stub, options);
    const strip = (r: Awaited<ReturnType<typeof runBaseline>>) =>
      JSON.stringify({
        answers: r.observations.map((o) => o.answer),
        correct: r.arms.map((a) => [a.arm, a.correct, a.wrong, a.abstained]),
      });
    expect(strip(first)).toBe(strip(second));
  });
});

describe("llm arms", () => {
  it("catches a confidently wrong answer and counts the fabrication", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory"],
      model: confidentlyWrong,
    });
    const llm = report.arms.find((a) => a.arm === "llm-memory")!;

    expect(llm.abstained).toBe(0);
    expect(llm.wrong).toBeGreaterThan(0);
    expect(llm.wrongWhenAnswering).toBeGreaterThan(0);
    // It answered the unanswerable question too — that is the fabrication the
    // corpus's ABSENT label exists to catch.
    expect(llm.fabricated).toBeGreaterThan(0);
    expect(llm.fabricationRate).toBe(1);
    // Usage is reported, not estimated, when the provider supplies it.
    expect(llm.tokens.estimated).toBe(false);
    expect(llm.tokens.input).toBeGreaterThan(0);
  });

  it("scores abstention as abstention, never as a wrong answer", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory"],
      model: alwaysAbstains,
    });
    const llm = report.arms.find((a) => a.arm === "llm-memory")!;
    expect(llm.answered).toBe(0);
    expect(llm.wrong).toBe(0);
    expect(llm.fabricated).toBe(0);
    expect(llm.coverage).toBe(0);
  });

  it("reports consistency across samples", async () => {
    let call = 0;
    const flaky = scriptedModel(() =>
      JSON.stringify({ known: true, value: String(++call), unit: "mA", qualifier: "MAX" }),
    );
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory"],
      samples: 2,
      model: flaky,
    });
    const llm = report.arms.find((a) => a.arm === "llm-memory")!;
    expect(report.samples).toBe(2);
    expect(llm.consistency).toBe(0); // every sample differs
  });

  it("skips llm arms rather than faking them when no model is configured", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
    });
    expect(report.skipped.map((s) => s.arm)).toEqual([
      "llm-memory",
      "llm-document",
      "llm-search",
    ]);
    expect(report.skipped.find((s) => s.arm === "llm-search")!.reason).toContain(
      "retrieval-enabled",
    );
    expect(report.arms.map((a) => a.arm)).toEqual(["cortex"]);
  });

  it("runs the search arm only from the retrieval-enabled provider", async () => {
    const searching = scriptedModel(() =>
      JSON.stringify({ known: true, value: "1", unit: "mA", qualifier: "MAX" }),
    );
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory", "llm-search"],
      searchModel: searching,
    });
    // llm-memory has no model, llm-search does: each arm's provider is its own.
    expect(report.skipped.map((s) => s.arm)).toEqual(["llm-memory"]);
    expect(report.arms.map((a) => a.arm)).toEqual(["llm-search"]);
  });

  it("prefers billed cost over the price table when the surface reports it", async () => {
    const billed: ModelProvider = {
      descriptor: { id: "billed", kind: "model", capabilities: [], configSchema: {} },
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({ known: false }),
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.25,
            webSearchRequests: 2,
          },
        }),
    };
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory"],
      model: billed,
      pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    });
    const llm = report.arms.find((a) => a.arm === "llm-memory")!;
    expect(llm.costReported).toBe(true);
    expect(llm.costUsd).toBeCloseTo(0.25 * report.questionCount, 6);
    expect(llm.webSearchRequests).toBe(2 * report.questionCount);
  });

  it("prices a run when per-token pricing is supplied", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["llm-memory"],
      model: confidentlyWrong,
      pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    });
    const llm = report.arms.find((a) => a.arm === "llm-memory")!;
    expect(llm.costUsd).toBeGreaterThan(0);
  });
});

describe("rendering", () => {
  it("leads with the two decision-relevant rates", async () => {
    const report = await runBaseline(corpus, stub, {
      releaseSet: "dev",
      now: NOW,
      arms: ["cortex"],
    });
    const lines = renderBaseline(report);
    const cortexAt = lines.findIndex((l) => l === "cortex");
    expect(lines[cortexAt + 1]).toContain("wrong when answering");
    expect(lines[cortexAt + 2]).toContain("fabricated");
  });
});
