import { describe, expect, it } from 'vitest';
import { storedZip } from '../src/util/stored-zip.js';

describe('storedZip', () => {
  it('writes the standard CRC-32 check vector and ZIP records', () => {
    // CRC-32('123456789') = 0xcbf43926, independently checked with Python zlib.
    const name = 'board.GTL';
    const payload = Buffer.from('123456789');
    const zip = storedZip([{ name, data: payload }]);
    const central = 30 + name.length + payload.length;
    const end = central + 46 + name.length;
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.readUInt16LE(4)).toBe(10);
    expect(zip.readUInt16LE(6)).toBe(0); // Flags, including no data descriptor.
    expect(zip.readUInt16LE(8)).toBe(0); // STORE.
    expect(zip.readUInt16LE(10)).toBe(0); // Midnight.
    expect(zip.readUInt16LE(12)).toBe(0x21); // 1980-01-01.
    expect(zip.readUInt32LE(14)).toBe(0xcbf43926);
    expect(zip.readUInt32LE(18)).toBe(payload.length);
    expect(zip.readUInt32LE(22)).toBe(payload.length);
    expect(zip.readUInt16LE(26)).toBe(name.length);
    expect(zip.readUInt16LE(28)).toBe(0);
    expect(zip.subarray(30, 30 + name.length).toString('ascii')).toBe(name);
    expect(zip.subarray(30 + name.length, central)).toEqual(payload);
    expect(zip.subarray(central, central + 4).toString('hex')).toBe('504b0102');
    expect(zip.readUInt32LE(central + 16)).toBe(0xcbf43926);
    expect(zip.readUInt32LE(central + 20)).toBe(payload.length);
    expect(zip.readUInt32LE(central + 24)).toBe(payload.length);
    expect(zip.readUInt16LE(central + 28)).toBe(name.length);
    expect(zip.readUInt16LE(central + 30)).toBe(0);
    expect(zip.readUInt16LE(central + 32)).toBe(0);
    expect(zip.readUInt32LE(central + 42)).toBe(0);
    expect(zip.subarray(central + 46, end).toString('ascii')).toBe(name);
    expect(zip.subarray(end, end + 4).toString('hex')).toBe('504b0506');
    expect(zip.readUInt16LE(end + 4)).toBe(0);
    expect(zip.readUInt16LE(end + 6)).toBe(0);
    expect(zip.readUInt16LE(end + 8)).toBe(1);
    expect(zip.readUInt16LE(end + 10)).toBe(1);
    expect(zip.readUInt32LE(end + 12)).toBe(46 + name.length);
    expect(zip.readUInt32LE(end + 16)).toBe(central);
    expect(zip.readUInt16LE(end + 20)).toBe(0);
    expect(zip.length).toBe(end + 22);
  });

  it('sorts entries reproducibly without mutating the input', () => {
    const entries = [
      { name: 'z.drl', data: Buffer.from([0, 255, 127, 128]) },
      { name: 'A.GTL', data: Buffer.from('123456789') },
    ];
    const zip = storedZip(entries);
    expect(storedZip([...entries].reverse())).toEqual(zip);
    expect(storedZip(entries)).toEqual(zip);
    expect(entries.map(({ name }) => name)).toEqual(['z.drl', 'A.GTL']);
    const end = zip.length - 22;
    let central = zip.readUInt32LE(end + 16);
    let expectedLocal = 0;
    for (const { name, data } of [...entries].reverse()) {
      expect(zip.readUInt32LE(central)).toBe(0x02014b50);
      expect(zip.readUInt32LE(central + 42)).toBe(expectedLocal);
      expect(zip.readUInt32LE(expectedLocal)).toBe(0x04034b50);
      expect(zip.subarray(central + 46, central + 46 + name.length).toString()).toBe(name);
      expect(zip.subarray(expectedLocal + 30 + name.length,
        expectedLocal + 30 + name.length + data.length)).toEqual(data);
      expectedLocal += 30 + name.length + data.length;
      central += 46 + name.length;
    }
    expect(central).toBe(end);
    expect(zip.readUInt16LE(end + 8)).toBe(2);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
  });

  it('supports empty entries and a canonical empty archive', () => {
    expect(storedZip([]).toString('hex')).toBe('504b0506000000000000000000000000000000000000');
    const zip = storedZip([{ name: 'empty.GTL', data: Buffer.alloc(0) }]);
    expect(zip.readUInt32LE(14)).toBe(0);
    expect(zip.readUInt32LE(18)).toBe(0);
    expect(zip.readUInt32LE(22)).toBe(0);
  });

  it.each(['', '.', '..', '../board.GTL', 'a/b.GTL', 'a\\b.GTL', '/board.GTL',
    'C:board.GTL', 'bad\0.GTL', 'café.GTL', 'a\n.GTL', 'a.GTL\n', 'a.GTL\r', 'space name.GTL',
    '.hidden.GTL', 'a.', 'CON', 'nul.GTL', 'COM1.drl', 'lpt9.GTL', 'a'.repeat(256)])(
    'rejects unsafe basename %j', (name) => {
      expect(() => storedZip([{ name, data: Buffer.from('x') }])).toThrow(/Unsafe ZIP basename/);
    });

  it.each(['board.GTL', 'BOARD.gtl'])('rejects duplicate name %s', (duplicate) => {
    expect(() => storedZip([
      { name: 'board.GTL', data: Buffer.from('a') },
      { name: duplicate, data: Buffer.from('b') },
    ])).toThrow(/Duplicate ZIP basename/);
  });

  it('accepts 99 entries and rejects 100 before producing an archive', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ name: `layer-${i}.gbr`, data: Buffer.alloc(0) }));
    const zip = storedZip(entries.slice(0, 99));
    expect(zip.readUInt16LE(zip.length - 12)).toBe(99);
    expect(() => storedZip(entries)).toThrow(/at most 99 files/);
  });

  it('accepts the 255-character name boundary', () => {
    const zip = storedZip([{ name: 'a'.repeat(255), data: Buffer.alloc(0) }]);
    expect(zip.readUInt16LE(26)).toBe(255);
  });

  it('rejects non-Buffer input', () => {
    expect(() => storedZip([{ name: 'a.GTL', data: new Uint8Array(1) as Buffer }])).toThrow(/must be a Buffer/);
  });

  it('rejects oversized files before reading data', () => {
    // Override only the reported length, avoiding a 64 MiB test allocation.
    const data = Buffer.alloc(0);
    Object.defineProperty(data, 'length', { value: 64 * 1024 * 1024 + 1 });
    expect(() => storedZip([{ name: 'a.GTL', data }])).toThrow(/ZIP file exceeds/);
  });

  it('rejects an oversized archive, including headers, before reading data', () => {
    const data = Buffer.alloc(0);
    Object.defineProperty(data, 'length', { value: 64 * 1024 * 1024 });
    expect(() => storedZip(['a', 'b', 'c', 'd'].map((name) => ({ name, data })))).toThrow(/ZIP archive exceeds/);
  });
});


describe('generic UTF-8 archive names', () => {
  it('preserves Unicode/spaces and marks both ZIP headers as UTF-8', () => {
    const name = '电路 board-F_Cu.gbr';
    const data = Buffer.from('G04*');
    const zip = storedZip([{ name, data }], { utf8Names: true });
    const nameBytes = Buffer.from(name);
    expect(zip.readUInt16LE(6)).toBe(0x0800);
    expect(zip.readUInt16LE(26)).toBe(nameBytes.length);
    expect(zip.subarray(30, 30 + nameBytes.length)).toEqual(nameBytes);
    const central = 30 + nameBytes.length + data.length;
    expect(zip.readUInt16LE(central + 8)).toBe(0x0800);
    expect(() => storedZip([{ name, data }])).toThrow(/Unsafe ZIP basename/);
  });
  it.each(['../board.gbr', 'a/b.gbr', 'a\\b.gbr', 'C:board.gbr', '.', '..', 'bad\0.gbr', 'NUL.gbr', '电'.repeat(86)])('still rejects unsafe generic name %j', name => {
    expect(() => storedZip([{ name, data: Buffer.from('x') }], { utf8Names: true })).toThrow(/Unsafe ZIP basename/);
  });
});
