/**
 * License policy for reference layouts (RFC 11 §8.6, implementation spec
 * §7.2b): permissive licenses apply automatically; copyleft, share-alike, and
 * unknown ones need an approver recorded before a block is applied.
 */
export const PERMISSIVE = ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0', 'CC-BY-4.0', 'CERN-OHL-P-2.0', 'Unlicense', 'TAPR-OHL'];

export function normalizeLicense(s: string | null | undefined): string {
  if (!s) return 'unknown';
  const t = s.trim();
  const hit = PERMISSIVE.find((p) => p.toLowerCase() === t.toLowerCase());
  if (hit) return hit;
  const map: Record<string, string> = { mit: 'MIT', apache: 'Apache-2.0', 'apache-2': 'Apache-2.0', 'apache-2.0': 'Apache-2.0', bsd: 'BSD-3-Clause', 'bsd-3': 'BSD-3-Clause', 'bsd-2': 'BSD-2-Clause', cc0: 'CC0-1.0', 'cc-by': 'CC-BY-4.0', 'cc-by-4.0': 'CC-BY-4.0', unlicense: 'Unlicense' };
  return map[t.toLowerCase()] ?? t;
}

/** true when a human (or the user's own ownership) must approve before the block is applied. */
export function needsApproval(license: string): boolean {
  return !PERMISSIVE.includes(normalizeLicense(license));
}
