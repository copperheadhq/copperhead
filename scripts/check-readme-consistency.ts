import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Generates the Markdown maturity section including the acceptance criteria matrix
 * based on current version and status.json data.
 *
 * @param version - The current package version string (e.g. "0.8.1")
 * @param statusData - Parsed contents of status.json containing acceptance criteria statuses
 * @returns The formatted Markdown maturity text section
 */
function generateMaturitySection(version: string, statusData: any): string {
  const acs = statusData.acceptanceCriteria;
  const namesMap: Record<string, string> = {
    "AC-3.1": "AC-3.1 (Net Rename)",
    "AC-3.2": "AC-3.2 (RTC Pin Move)",
    "AC-3.3": "AC-3.3 (Add RGB LED)",
    "AC-3.4": "AC-3.4 (Budget Refusal)",
    "AC-3.5": "AC-3.5 (Repair Loop)",
    "AC-3.6": "AC-3.6 (Rollback)"
  };

  let table = `| Acceptance Criteria | OpenAI | Anthropic | Codex |\n| --- | --- | --- | --- |\n`;
  for (const ac of ["AC-3.1", "AC-3.2", "AC-3.3", "AC-3.4", "AC-3.5", "AC-3.6"]) {
    const o = acs[ac]?.openai?.status || "pending";
    const a = acs[ac]?.anthropic?.status || "pending";
    const c = acs[ac]?.codex?.status || "pending";
    table += `| ${namesMap[ac]} | ${o} | ${a} | ${c} |\n`;
  }

  return [
    `Honest read of where v${version} stands, so you can calibrate before pointing this at a board you care about:\n`,
    `- **Solid.** \`init\` and \`check\`/\`verify\` are deterministic, LLM-free, and covered by the offline test suite against a real KiCad fixture: scaffolding, ERC/DRC, the s-expression reader, drift detection, and fab export all run green in CI.`,
    `- **Implemented, not yet proven.** The agent loop (\`do\`, \`sync --resolve\`, \`create\`) is complete and structurally gated.`,
    `- **Acceptance Matrix (nightly runs):**\n`,
    table.trim().split('\n').map(line => `  ${line}`).join('\n') + '\n',
    `- **Always.** Every mutation runs inside a git snapshot and rolls back if verification fails, so the worst case is a no-op commit, not a mangled schematic. Work on a branch anyway.`
  ].join('\n');
}

/**
 * Main execution routine for verifying and updating README consistency.
 * Validates version claims against package.json and regenerates the maturity section.
 */
async function main() {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const readmePath = path.join(root, 'README.md');
  const statusPath = path.join(root, 'status.json');

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const version = pkg.version;

  const statusData = JSON.parse(await readFile(statusPath, 'utf8'));
  const readmeContent = await readFile(readmePath, 'utf8');

  // Verify and update status line version
  const statusLineRegex = /(>\s+\*\*Status:\s+([A-Za-z0-9_-]+)\s+\(v)([^)]+)(\)\.\*\*)/;
  const currentStatusLineMatch = readmeContent.match(statusLineRegex);

  let newReadme = readmeContent;
  let hasVersionDrift = false;

  if (!currentStatusLineMatch) {
    // If not found in the new format, let's try replacing the old one
    const oldStatusLineRegex = /(>\s+\*\*Status:\s+([A-Za-z0-9_-]+)\.\*\*)/;
    const oldMatch = readmeContent.match(oldStatusLineRegex);
    if (oldMatch) {
      const statusText = oldMatch[2];
      const expectedStatusLine = `> **Status: ${statusText} (v${version}).**`;
      newReadme = readmeContent.replace(oldStatusLineRegex, expectedStatusLine);
      hasVersionDrift = true;
    } else {
      console.error('Error: Could not locate the Status line in README.md');
      process.exit(1);
    }
  } else {
    const currentVersion = currentStatusLineMatch[3];
    if (currentVersion !== version) {
      const statusText = currentStatusLineMatch[2];
      const expectedStatusLine = `> **Status: ${statusText} (v${version}).**`;
      newReadme = readmeContent.replace(statusLineRegex, expectedStatusLine);
      hasVersionDrift = true;
    }
  }

  // Generate maturity block
  const maturityBeginMarker = '<!-- maturity:begin -->';
  const maturityEndMarker = '<!-- maturity:end -->';
  const expectedMaturitySection = generateMaturitySection(version, statusData);

  const maturityRegex = new RegExp(`${maturityBeginMarker}[\\s\\S]*?${maturityEndMarker}`);
  const expectedMaturityBlock = `${maturityBeginMarker}\n${expectedMaturitySection}\n${maturityEndMarker}`;

  let hasMaturityDrift = false;
  if (!maturityRegex.test(newReadme)) {
    // If markers are missing, insert them after the Maturity header
    const maturityHeaderRegex = /(##\s+Maturity\s*\r?\n\r?\n)[^]*?(##\s+Open\s+source)/i;
    if (maturityHeaderRegex.test(newReadme)) {
      newReadme = newReadme.replace(maturityHeaderRegex, `$1${expectedMaturityBlock}\n\n$2`);
      hasMaturityDrift = true;
    } else {
      console.error('Error: Could not locate the Maturity section in README.md');
      process.exit(1);
    }
  } else {
    const currentMaturityBlock = newReadme.match(maturityRegex)?.[0];
    if (currentMaturityBlock !== expectedMaturityBlock) {
      newReadme = newReadme.replace(maturityRegex, expectedMaturityBlock);
      hasMaturityDrift = true;
    }
  }

  const isWrite = process.argv.includes('--write') || process.argv.includes('-w');

  if (hasVersionDrift || hasMaturityDrift) {
    if (isWrite) {
      await writeFile(readmePath, newReadme, 'utf8');
      console.log('Successfully regenerated and updated README.md.');
    } else {
      console.error('Error: README consistency check failed.');
      if (hasVersionDrift) {
        console.error(`- Version claim drift detected: package.json version is ${version}`);
      }
      if (hasMaturityDrift) {
        console.error('- Maturity block drift detected (does not match status.json content).');
      }
      console.error('Run "npm run lint:readme -- --write" to automatically fix this.');
      process.exit(1);
    }
  } else {
    console.log('README consistency check passed.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
