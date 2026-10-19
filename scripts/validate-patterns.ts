import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PATTERNS_DIR = path.join(REPO_ROOT, 'src', 'kicad', 'patterns');
const SCHEMA_FILE = path.join(PATTERNS_DIR, 'pattern.schema.json');

interface PatternPart {
  ref: string;
  libId: string;
  value: string;
  footprint?: string;
  group: string;
}

interface PatternNet {
  name: string;
  pins: string[];
  kind?: 'power' | 'ground' | 'signal';
}

interface PatternDocument {
  name: string;
  description: string;
  parts: PatternPart[];
  nets: PatternNet[];
}

interface ValidationFinding {
  file: string;
  message: string;
}

function validatePattern(file: string, doc: unknown): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const add = (message: string) => findings.push({ file, message });

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    add('Root of pattern document must be an object');
    return findings;
  }

  const d = doc as Record<string, unknown>;

  if (typeof d.name !== 'string' || !d.name.trim()) {
    add('Field "name" must be a non-empty string');
  }

  if (typeof d.description !== 'string' || !d.description.trim()) {
    add('Field "description" must be a non-empty string');
  }

  if (!Array.isArray(d.parts) || d.parts.length === 0) {
    add('Field "parts" must be a non-empty array');
    return findings;
  }

  if (!Array.isArray(d.nets) || d.nets.length === 0) {
    add('Field "nets" must be a non-empty array');
    return findings;
  }

  const partRefs = new Set<string>();

  for (let i = 0; i < d.parts.length; i++) {
    const p = d.parts[i];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      add(`parts[${i}] must be an object`);
      continue;
    }
    const part = p as Record<string, unknown>;
    if (typeof part.ref !== 'string' || !part.ref.trim()) {
      add(`parts[${i}].ref must be a non-empty string`);
    } else {
      if (partRefs.has(part.ref)) {
        add(`Duplicate ref "${part.ref}" in parts`);
      }
      partRefs.add(part.ref);
    }
    if (typeof part.libId !== 'string' || !part.libId.trim()) {
      add(`parts[${i}].libId must be a non-empty string`);
    }
    if (typeof part.value !== 'string' || !part.value.trim()) {
      add(`parts[${i}].value must be a non-empty string`);
    }
    if (typeof part.group !== 'string' || !part.group.trim()) {
      add(`parts[${i}].group must be a non-empty string`);
    }
    if (part.footprint !== undefined && typeof part.footprint !== 'string') {
      add(`parts[${i}].footprint must be a string if specified`);
    }
  }

  const netNames = new Set<string>();
  const pinEndpointRegex = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_\-/+]+)$/;

  for (let i = 0; i < d.nets.length; i++) {
    const n = d.nets[i];
    if (typeof n !== 'object' || n === null || Array.isArray(n)) {
      add(`nets[${i}] must be an object`);
      continue;
    }
    const net = n as Record<string, unknown>;
    if (typeof net.name !== 'string' || !net.name.trim()) {
      add(`nets[${i}].name must be a non-empty string`);
    } else {
      if (netNames.has(net.name)) {
        add(`Duplicate net name "${net.name}"`);
      }
      netNames.add(net.name);
    }

    if (net.kind !== undefined && net.kind !== 'power' && net.kind !== 'ground' && net.kind !== 'signal') {
      add(`nets[${i}].kind must be one of "power", "ground", "signal"`);
    }

    if (!Array.isArray(net.pins) || net.pins.length < 2) {
      add(`nets[${i}].pins must be an array of at least 2 endpoints`);
      continue;
    }

    for (let j = 0; j < net.pins.length; j++) {
      const ep = net.pins[j];
      if (typeof ep !== 'string') {
        add(`nets[${i}].pins[${j}] must be a string in REF.PIN format`);
        continue;
      }
      const match = pinEndpointRegex.exec(ep);
      if (!match) {
        add(`nets[${i}].pins[${j}] "${ep}" is not a valid REF.PIN endpoint`);
        continue;
      }
      const ref = match[1]!;
      if (!partRefs.has(ref)) {
        add(`nets[${i}].pins[${j}] references unknown part ref "${ref}" not defined in parts`);
      }
    }
  }

  return findings;
}

export async function validateAllPatterns(): Promise<boolean> {
  console.log('Validating circuit patterns in:', PATTERNS_DIR);

  // Check schema file existence
  try {
    const schemaContent = await readFile(SCHEMA_FILE, 'utf8');
    JSON.parse(schemaContent);
  } catch (err) {
    console.error(`ERROR: Failed to read/parse schema file ${SCHEMA_FILE}:`, (err as Error).message);
    return false;
  }

  const entries = await readdir(PATTERNS_DIR, { withFileTypes: true });
  const patternFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'pattern.schema.json')
    .map((e) => e.name)
    .sort();

  if (patternFiles.length === 0) {
    console.error('ERROR: No pattern files found in', PATTERNS_DIR);
    return false;
  }

  let totalFindings: ValidationFinding[] = [];
  let validCount = 0;

  for (const filename of patternFiles) {
    const filePath = path.join(PATTERNS_DIR, filename);
    let parsed: unknown;
    try {
      const content = await readFile(filePath, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      totalFindings.push({ file: filename, message: `Invalid JSON syntax: ${(err as Error).message}` });
      continue;
    }

    const findings = validatePattern(filename, parsed);
    if (findings.length > 0) {
      totalFindings.push(...findings);
    } else {
      validCount++;
      const p = parsed as PatternDocument;
      console.log(`  ✓ ${filename} ("${p.name}"): ${p.parts.length} part(s), ${p.nets.length} net(s)`);
    }
  }

  if (totalFindings.length > 0) {
    console.error(`\nValidation FAILED with ${totalFindings.length} error(s):`);
    for (const f of totalFindings) {
      console.error(`  - [${f.file}] ${f.message}`);
    }
    return false;
  }

  console.log(`\nAll ${validCount} pattern(s) validated successfully.`);
  return true;
}

// When run directly as a script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateAllPatterns().then((ok) => {
    if (!ok) process.exit(1);
  });
}
