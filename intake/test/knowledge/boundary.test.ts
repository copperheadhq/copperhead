// Import boundaries (ground-intake-extraction design D1). The rules cortex enforced with
// dependency-cruiser, enforced here as a test: core/ is pure, and the verdict engine
// depends only on the types and decimal modules.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const intake = path.resolve(here, "../..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g),
    ...text.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/g),
    ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
  ];
  return specs.map((m) => m[1] as string);
}

const FORBIDDEN_IN_CORE = /^(node:|fs$|path$|crypto$|next(\/|$)|react(\/|$)|sarvamai$|@anthropic-ai\/|pdfjs-dist(\/|$))/;

describe("import boundaries", () => {
  it("nothing under core/ imports I/O, a vendor SDK, pdf.js, or Next.js", () => {
    const offenders = tsFiles(path.join(intake, "core")).flatMap((f) =>
      importsOf(f)
        .filter((spec) => FORBIDDEN_IN_CORE.test(spec))
        .map((spec) => `${path.relative(intake, f)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the verdict engine imports only the types and decimal modules", () => {
    const verdict = path.join(intake, "core/knowledge/verdict");
    const allowed = [path.join(intake, "core/knowledge/types"), path.join(intake, "core/knowledge/decimal")];
    const offenders = tsFiles(verdict).flatMap((f) =>
      importsOf(f)
        .filter((spec) => spec.startsWith("."))
        .map((spec) => path.resolve(path.dirname(f), spec))
        .filter((target) => !target.startsWith(verdict) && !allowed.some((a) => target.startsWith(a)))
        .map((target) => `${path.relative(intake, f)} imports ${path.relative(intake, target)}`),
    );
    expect(offenders).toEqual([]);
  });
});
