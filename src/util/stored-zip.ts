const MAX_ENTRIES = 99;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DOS_DATE = 0x0021; // 1980-01-01, with a fixed midnight time.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Deterministic, single-disk ZIP STORE for a small fabrication file set.
 * Entries are sorted by ASCII basename; timestamps are fixed. No ZIP64,
 * compression, encryption, directory entries, extra fields, or comments.
 * Allows 0–99 files, up to 64 MiB each and 256 MiB including ZIP headers.
 * Names must be portable ASCII basenames of 1–255 characters: start with an
 * alphanumeric, then use alphanumerics, '.', '_', or '-'; no trailing dot or
 * Windows device names. Case-insensitive duplicates are rejected.
 */
export function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP supports at most ${MAX_ENTRIES} files`);
  }
  const names = new Set<string>();
  let totalBytes = 22; // End of central directory record.
  const files = entries.map(({ name, data }) => {
    if (typeof name !== 'string' || name.length > 255
      || !/^[A-Za-z0-9]/.test(name) || /[^A-Za-z0-9._-]/.test(name) || name.endsWith('.')
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
      throw new Error(`Unsafe ZIP basename: ${JSON.stringify(name)}`);
    }
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate ZIP basename: ${name}`);
    names.add(key);
    if (!Buffer.isBuffer(data)) throw new Error(`ZIP data must be a Buffer: ${name}`);
    if (data.length > MAX_FILE_BYTES) {
      throw new Error(`ZIP file exceeds ${MAX_FILE_BYTES} bytes: ${name}`);
    }
    const nameBytes = Buffer.from(name, 'ascii');
    totalBytes += 30 + 46 + 2 * nameBytes.length + data.length;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error(`ZIP archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    return { name, nameBytes, data };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  let centralBytes = 0;
  for (const { nameBytes, data } of files) {
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // Version needed: ZIP 1.0 (STORE).
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(10, 4); // Made by ZIP 1.0 / MS-DOS.
    record.writeUInt16LE(10, 6);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(localOffset, 42);
    central.push(record, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
    centralBytes += record.length + nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...central, end], totalBytes);
}
