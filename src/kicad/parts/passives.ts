/**
 * Passive expansion (design D3): a passive entry gives a value and a package;
 * this table supplies the canonical symbol and the stock KiCad footprint id,
 * so the model never types two hundred `Resistor_SMD:R_0603_1608Metric`s by
 * hand. An entry's explicit `libId`/`footprint` always wins; the table is only
 * the default. Unknown prefix or package → null, and the validator asks for
 * explicit ids.
 */

export interface PassiveDefault {
  libId: string;
  footprint: string;
}

const METRIC: Record<string, string> = { '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225' };

/** Canonicalise a package spelling: case, spaces, a trailing "metric"/"imperial" noise. */
function key(pkg: string): string {
  return pkg
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^(sod|sot|do)[-_ ]?/, '$1-')
    .replace(/metric$|imperial$/, '');
}

type Table = Record<string, PassiveDefault>;

function chip(lib: string, prefix: string, symbol: string): Table {
  const out: Table = {};
  for (const [imp, met] of Object.entries(METRIC)) out[imp] = { libId: symbol, footprint: `${lib}:${prefix}_${imp}_${met}Metric` };
  return out;
}

const TABLES: Record<string, Table> = {
  R: {
    ...chip('Resistor_SMD', 'R', 'Device:R'),
    axial: { libId: 'Device:R', footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
    din0207: { libId: 'Device:R', footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
  },
  C: {
    ...chip('Capacitor_SMD', 'C', 'Device:C'),
    disc: { libId: 'Device:C', footprint: 'Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm' },
    'elec6.3x5.4': { libId: 'Device:C_Polarized', footprint: 'Capacitor_SMD:CP_Elec_6.3x5.4' },
    radial5mm: { libId: 'Device:C_Polarized', footprint: 'Capacitor_THT:CP_Radial_D5.0mm_P2.00mm' },
  },
  L: chip('Inductor_SMD', 'L', 'Device:L'),
  FB: chip('Inductor_SMD', 'L', 'Device:FerriteBead'),
  D: {
    ...chip('Diode_SMD', 'D', 'Device:D'),
    'sod-123': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-123' },
    'sod-123f': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-123F' },
    'sod-323': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-323' },
    'sod-323f': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-323F' },
    sma: { libId: 'Device:D', footprint: 'Diode_SMD:D_SMA' },
    smb: { libId: 'Device:D', footprint: 'Diode_SMD:D_SMB' },
    'do-35': { libId: 'Device:D', footprint: 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal' },
    'do-41': { libId: 'Device:D', footprint: 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal' },
  },
  LED: {
    ...chip('LED_SMD', 'LED', 'Device:LED'),
    '3mm': { libId: 'Device:LED', footprint: 'LED_THT:LED_D3.0mm' },
    '5mm': { libId: 'Device:LED', footprint: 'LED_THT:LED_D5.0mm' },
  },
  F: chip('Fuse', 'Fuse', 'Device:Fuse'),
  Y: {
    '3225': { libId: 'Device:Crystal_GND24', footprint: 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm' },
    '5032': { libId: 'Device:Crystal', footprint: 'Crystal:Crystal_SMD_5032-2Pin_5.0x3.2mm' },
    '2012': { libId: 'Device:Crystal', footprint: 'Crystal:Crystal_SMD_2012-2Pin_2.0x1.2mm' },
    hc49: { libId: 'Device:Crystal', footprint: 'Crystal:Crystal_HC49-U_Vertical' },
  },
  SW: {
    '6mm': { libId: 'Switch:SW_Push', footprint: 'Button_Switch_THT:SW_PUSH_6mm' },
    '6x6': { libId: 'Switch:SW_Push', footprint: 'Button_Switch_THT:SW_PUSH_6mm' },
    pts645: { libId: 'Switch:SW_Push', footprint: 'Button_Switch_SMD:SW_SPST_PTS645Sx43SMTR92' },
  },
  TP: {
    '1mm': { libId: 'Connector:TestPoint', footprint: 'TestPoint:TestPoint_Pad_D1.0mm' },
    '1.0mm': { libId: 'Connector:TestPoint', footprint: 'TestPoint:TestPoint_Pad_D1.0mm' },
    '1.5mm': { libId: 'Connector:TestPoint', footprint: 'TestPoint:TestPoint_Pad_D1.5mm' },
  },
};

/** Refdes prefixes the table knows (an entry with one of these may give `package` instead of ids). */
export function isPassivePrefix(prefix: string): boolean {
  return prefix.toUpperCase() in TABLES;
}

/** Packages the table knows for a prefix, for the "unknown package" finding. */
export function knownPackages(prefix: string): string[] {
  return Object.keys(TABLES[prefix.toUpperCase()] ?? {});
}

/** The canonical symbol and stock footprint for `prefix` + `package`, or null when unknown. */
export function passiveDefault(prefix: string, pkg: string): PassiveDefault | null {
  const table = TABLES[prefix.toUpperCase()];
  if (!table) return null;
  return table[key(pkg)] ?? null;
}

/** Every footprint id the table can emit (for the install-coverage test). */
export function allPassiveFootprints(): string[] {
  return [...new Set(Object.values(TABLES).flatMap((t) => Object.values(t).map((d) => d.footprint)))].sort();
}
