import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PinNet, SchematicSymbol } from '../src/kicad/sexp.js';

// Reader output is mocked so each case can name exactly the parts, pins, and
// nets it needs (dotted rails, repeated pin names) without a bespoke schematic.
const reader = vi.hoisted(() => ({
  symbols: [] as SchematicSymbol[],
  nets: [] as string[],
  pins: [] as PinNet[],
}));

vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSymbols: async () => reader.symbols,
  listNets: async () => reader.nets,
  pinNets: async () => reader.pins,
}));

import { explainQuery, formatExplain } from '../src/commands/explain.js';

const sym = (ref: string, value = ''): SchematicSymbol => ({
  ref,
  value,
  footprint: '',
  libId: '',
  sheet: '/',
  at: { x: 0, y: 0, rot: 0 },
  uuid: ref,
  unit: 1,
});
const pin = (ref: string, pinNumber: string, pinName: string, net: string | null): PinNet => ({
  ref,
  pinNumber,
  pinName,
  net,
});

let repo = '';

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'copperhead-explain-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await mkdir(path.join(repo, 'hardware'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'hardware/board.kicad_sch', docs: 'docs/' }),
    'utf8',
  );
  await writeFile(path.join(repo, 'hardware', 'board.kicad_sch'), '(kicad_sch)\n', 'utf8');
  reader.symbols = [];
  reader.nets = [];
  reader.pins = [];
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('explainQuery resolution order', () => {
  it('resolves a dotted net name whose prefix looks like a refdes', async () => {
    reader.symbols = [sym('U1')];
    reader.nets = ['VDD1.8', 'GND'];
    reader.pins = [pin('U1', '1', 'VDD', 'VDD1.8'), pin('U1', '2', 'GND', 'GND')];
    const res = await explainQuery(repo, 'VDD1.8');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hit.kind).toBe('net');
    if (res.hit.kind !== 'net') return;
    expect(res.hit.name).toBe('VDD1.8');
    expect(res.hit.pins.map((p) => `${p.ref}.${p.number}`)).toEqual(['U1.1']);
  });

  it('still reports an unknown part when nothing else matches', async () => {
    reader.symbols = [sym('U1')];
    reader.nets = ['GND'];
    const res = await explainQuery(repo, 'U9.3');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('no part U9');
  });

  it('reports an unknown pin with the part pin list', async () => {
    reader.symbols = [sym('R1')];
    reader.pins = [pin('R1', '1', '~', 'A'), pin('R1', '2', '~', 'B')];
    const res = await explainQuery(repo, 'R1.7');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('no pin 7 on R1 (pins: 1, 2)');
  });

  it('never says "nothing named" for a pin name repeated on one part', async () => {
    reader.symbols = [sym('J1')];
    reader.pins = [pin('J1', 'S1', 'SHIELD', 'GND'), pin('J1', 'S2', 'SHIELD', 'GND'), pin('J1', 'A4', 'VBUS', 'VBUS')];
    const res = await explainQuery(repo, 'SHIELD');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('pin name SHIELD is on J1 pins S1, S2: use REF.PIN');
  });

  it('fails REF.PIN by name when same-named pins sit on different nets', async () => {
    reader.symbols = [sym('U1')];
    reader.nets = ['GND'];
    reader.pins = [pin('U1', '2', 'NC', null), pin('U1', '3', 'NC', 'GND')];
    const res = await explainQuery(repo, 'U1.NC');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('U1 pins 2, 3 are named NC: use U1.<number>');

    const byNumber = await explainQuery(repo, 'U1.3');
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok || byNumber.hit.kind !== 'pin') return;
    expect(byNumber.hit.net).toBe('GND');
  });

  it('returns the first same-named pin on one net and lists the others', async () => {
    reader.symbols = [sym('U1')];
    reader.nets = ['GND'];
    reader.pins = [pin('U1', '4', 'GND', 'GND'), pin('U1', '9', 'GND', 'GND'), pin('U1', '1', 'VCC', 'VCC')];
    const res = await explainQuery(repo, 'U1.GND');
    expect(res.ok).toBe(true);
    if (!res.ok || res.hit.kind !== 'pin') return;
    expect(res.hit.number).toBe('4');
    expect(res.hit.sharedWith).toEqual(['9']);
    expect(formatExplain(res)).toContain('also U1 pin(s) 9 (same name, same net)');
  });
});
