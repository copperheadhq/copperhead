import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CopperheadConfig } from '../config.js';
import { exportFab, kicadCliVersion, type FabExportFile, type FabExportResult } from '../kicad/cli.js';
import { childSheetFiles, JLC_PROFILE, jlcProfile, type JlcProfile } from '../kicad/jlc-profile.js';
import { parseBom } from '../kicad/bom-export.js';
import { child, isList, parseSexp } from '../kicad/sexp.js';
import { storedZip } from '../util/stored-zip.js';

const MANIFEST = 'export-manifest.json';
const ARCHIVE = 'jlcpcb.zip';
const REQUIRED = ['gerbers','drill','outline.dxf','board.step','board.svg','schematic.svg','BOM.csv','jlcpcb.zip'];
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
interface RecordedFile extends FabExportFile { sha256: string }
interface Manifest {
  schema: 1; profile: typeof JLC_PROFILE; state: 'complete'; kicadVersion: string;
  zoneFill: 'not-applicable-no-copper-zones'; manufacturerAcceptance: 'not-verified';
  sources: Record<string,string>; files: RecordedFile[];
}

/** Refuse traversal and symlinks in every component, including existing parents. */
async function safePath(root:string, relative:string, writing=false):Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p=>!p || p==='..' || p==='.')) throw new Error(`unsafe output/input path: ${relative}`);
  let current = root;
  const parts = relative.split(/[\\/]/);
  for (const [index, part] of ['', ...parts].entries()) {
    current=path.join(current,part);
    const directory=index<parts.length;
    try {
      const stat=await lstat(current);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`not a regular ${directory?'directory':'file'}: ${relative}`);
    } catch(e) {
      if (!writing || (e as NodeJS.ErrnoException).code!=='ENOENT') throw e;
      if (directory) await mkdir(current); // parents were checked one at a time
    }
  }
  return current;
}
async function writeOutput(out:string, relative:string, bytes:Buffer|string):Promise<void> {
  await writeFile(await safePath(out,relative,true),bytes);
}

async function sources(root:string,config:CopperheadConfig,full=true):Promise<Record<string,string>> {
  if(!config.board || (full && !config.schematic)) throw new Error('complete outputs require configured board and schematic');
  const records:Record<string,string>={};
  const capture=async(rel:string)=>{ const data=await readFile(await safePath(root,rel)); records[rel]=hash(data); return data.toString('utf8'); };
  await capture(config.board);
  try { await capture(path.join(config.docs,'BOM.md')); }
  catch(e) { if(full || (e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  const load=async(rel:string):Promise<void>=>{
    if(records[rel]) return;
    const text=await capture(rel);
    for(const sheet of childSheetFiles(text)) await load(path.join(path.dirname(rel),sheet));
  };
  if(config.schematic) await load(config.schematic);
  // Project settings can affect exports; capture them when present.
  for(const rel of new Set([config.board,...(config.schematic?[config.schematic]:[])].map(file=>file.replace(/\.kicad_(pcb|sch)$/i,'.kicad_pro')))) {
    try { await capture(rel); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  }
  return Object.fromEntries(Object.entries(records).sort(([a],[b])=>a.localeCompare(b)));
}

function orderingBom(text:string):string {
  const rows=parseBom(text);
  if(!rows.length) throw new Error('BOM.md has no component rows for ordering BOM.csv');
  const seen=new Set<string>();
  const quote=(s:string)=>/[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
  return 'Refdes,MPN,Qty\r\n'+rows.map(row=>{
    if(!/^[A-Za-z]+\d+$/.test(row.refdes) || seen.has(row.refdes)) throw new Error(`ordering BOM requires one unique refdes per row: ${row.refdes}`);
    seen.add(row.refdes);
    if(!row.hasMpn || /^n\s*\/\s*a$/i.test(row.mpn)) throw new Error(`ordering BOM is missing an MPN for ${row.refdes}`);
    return [row.refdes,row.mpn,'1'].map(quote).join(',')+'\r\n';
  }).join('');
}

async function validateManufacturing(out:string,files:FabExportFile[],profile:JlcProfile):Promise<{name:string;data:Buffer}[]> {
  const gerbers=files.filter(f=>f.artifact==='gerbers' && !f.path.endsWith('.gbrjob'));
  const drill=files.filter(f=>f.artifact==='drill');
  if(gerbers.length!==profile.layers.length || drill.length!==2) throw new Error('JLC profile requires exactly the selected Gerbers and separate PTH/NPTH drill files');
  const remaining=new Set(profile.functions);
  const kinds=new Set(['PTH','NPTH']);
  const entries=[];
  for(const file of [...gerbers,...drill].sort((a,b)=>a.path.localeCompare(b.path))) {
    const data=await readFile(await safePath(out,file.path));
    const text=data.toString('utf8');
    if(file.artifact==='gerbers') {
      const fn=/%TF\.FileFunction,([^*]+)\*%/.exec(text)?.[1];
      if(!fn || !remaining.delete(fn) || !text.includes('%MOMM*%') || !text.includes('%FSLAX46Y46*%')) throw new Error(`JLC Gerber metadata/layer mismatch: ${file.path}`);
    } else {
      const kind=/-NPTH\.drl$/i.test(file.path)?'NPTH':/-PTH\.drl$/i.test(file.path)?'PTH':null;
      if(!kind || !kinds.delete(kind) || !text.startsWith('M48') || !text.includes('/ absolute / metric / decimal') ||
          !new RegExp(`TF\\.FileFunction,${kind==='PTH'?'Plated':'NonPlated'},[^\\r\\n]+,${kind}(?:\\r?\\n|$)`).test(text)) throw new Error(`JLC drill metadata mismatch: ${file.path}`);
    }
    const name=path.basename(file.path);
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('JLC archive needs ASCII manufacturing filenames; rename the board before export');
    entries.push({name,data});
  }
  return entries;
}

/** Explicitly scoped KiCad 9 profile; only called after an explicit selection. */
async function exportJlcOutputsPackage(root:string,config:CopperheadConfig):Promise<FabExportResult> {
  const out=path.join(root,'outputs');
  const failed=(reason:string):FabExportResult=>({produced:[],files:[],failed:[{artifact:'JLC package',reason}]});
  let result:FabExportResult|undefined;
  try {
    // Invalidate a previous successful run before any possibly failing step.
    await writeOutput(out,MANIFEST,JSON.stringify({schema:1,state:'incomplete',manufacturerAcceptance:'not-verified'})+'\n');
    const before=await sources(root,config);
    const profile=jlcProfile(await readFile(await safePath(root,config.board!),'utf8'));
    const version=await kicadCliVersion();
    if(!/^9\./.test(version)) throw new Error(`JLC profile is validated only for KiCad 9; found ${version}`);
    const bom=orderingBom(await readFile(await safePath(root,path.join(config.docs,'BOM.md')),'utf8'));
    result=await exportFab(path.join(root,config.board!),path.join(root,config.schematic!),out,profile);
    if(result.failed.length) return result;
    const entries=await validateManufacturing(out,result.files,profile);
    for(const [artifact,data] of [['BOM.csv',Buffer.from(bom)], [ARCHIVE,storedZip(entries)]] as const) {
      await writeOutput(out,artifact,data);
      result.files.push({artifact,path:artifact,bytes:data.length}); result.produced.push(artifact);
    }
    if(JSON.stringify(before)!==JSON.stringify(await sources(root,config))) throw new Error('source changed during export; rerun outputs');
    const files:RecordedFile[]=[];
    for(const file of result.files) {
      const bytes=await readFile(await safePath(out,file.path));
      if(!bytes.length || bytes.length!==file.bytes) throw new Error(`export size changed: ${file.path}`);
      files.push({...file,sha256:hash(bytes)});
    }
    const manifest:Manifest={schema:1,state:'complete',profile:JLC_PROFILE,kicadVersion:version,
      zoneFill:'not-applicable-no-copper-zones',manufacturerAcceptance:'not-verified',sources:before,files};
    const data=JSON.stringify(manifest,null,2)+'\n';
    await writeOutput(out,MANIFEST,data);
    const gap=await jlcOutputsPackageGap(root,config);
    if(gap) throw new Error(gap);
    result.files.push({artifact:MANIFEST,path:MANIFEST,bytes:Buffer.byteLength(data)}); result.produced.push(MANIFEST);
    return result;
  } catch(e) {
    try { await writeOutput(out,MANIFEST,JSON.stringify({schema:1,state:'incomplete',manufacturerAcceptance:'not-verified'})+'\n'); } catch { /* unsafe destination remains rejected */ }
    const reason=(e as Error).message;
    if(result) { result.failed.push({artifact:'JLC package',reason}); return result; }
    return failed(reason);
  }
}

/** Read-only finish/resume contract. Integrity evidence is not a factory approval. */
async function jlcOutputsPackageGap(root:string,config:CopperheadConfig):Promise<string|null> {
  try {
    const out=path.join(root,'outputs');
    const m=JSON.parse(await readFile(await safePath(out,MANIFEST),'utf8')) as Manifest;
    if(m.schema!==1 || m.state!=='complete' || m.profile!==JLC_PROFILE || !/^9\./.test(m.kicadVersion) ||
        m.zoneFill!=='not-applicable-no-copper-zones' || m.manufacturerAcceptance!=='not-verified') throw new Error('missing successful supported profile evidence');
    if(JSON.stringify(m.sources)!==JSON.stringify(await sources(root,config))) throw new Error('export sources changed; rerun export_outputs');
    const profile=jlcProfile(await readFile(await safePath(root,config.board!),'utf8'));
    const seen=new Set<string>();
    for(const file of m.files) {
      if(seen.has(file.path)) throw new Error('duplicate export file'); seen.add(file.path);
      const data=await readFile(await safePath(out,file.path));
      if(!data.length || data.length!==file.bytes || hash(data)!==file.sha256) throw new Error(`missing, empty or changed output: ${file.path}`);
    }
    for(const artifact of REQUIRED) if(!m.files.some(f=>f.artifact===artifact)) throw new Error(`required output missing: ${artifact}`);
    if(await readFile(await safePath(out,'BOM.csv'),'utf8')!==orderingBom(await readFile(await safePath(root,path.join(config.docs,'BOM.md')),'utf8'))) throw new Error('ordering BOM differs from BOM.md');
    const expected=storedZip(await validateManufacturing(out,m.files,profile));
    if(!(await readFile(await safePath(out,ARCHIVE))).equals(expected)) throw new Error('manufacturing ZIP does not match its verified file inventory');
    return null;
  } catch(e) { return `outputs package incomplete: ${(e as Error).message}`; }
}


const GENERIC_ARCHIVE = 'fabrication.zip';
const GENERIC_REQUIRED = ['gerbers', 'drill', 'outline.dxf', 'board.step', 'board.svg', GENERIC_ARCHIVE];
interface GenericManifest {
  schema: 1; profile: 'generic'; state: 'complete'; kicadVersion: string;
  profileVerification: 'not-requested'; zoneFill: 'not-verified'; manufacturerAcceptance: 'not-verified';
  sources: Record<string, string>; files: RecordedFile[];
}

/** Unknown profiles never silently select the generic path. */
function selectedProfile(config: CopperheadConfig): 'generic' | typeof JLC_PROFILE {
  const profile = config.outputProfile ?? 'generic';
  if (profile !== 'generic' && profile !== JLC_PROFILE) throw new Error('unsupported outputProfile; select a supported profile and rerun export_outputs');
  return profile;
}

/** Generic packing preserves KiCad filenames, including Unicode and spaces. */
async function genericArchive(root: string, config: CopperheadConfig, out: string, files: FabExportFile[]): Promise<Buffer> {
  const entries = [];
  const manufacturing = await genericGerbers(root, config, out, files);
  const drills = files.filter(f => f.artifact === 'drill' && /\.drl$/i.test(f.path));
  for (const file of [...manufacturing, ...drills]) {
    entries.push({ name: path.basename(file.path), data: await readFile(await safePath(out, file.path)) });
  }
  return storedZip(entries, { utf8Names: true });
}

/** Select the complete board manufacturing inventory; leave technical layers on disk. */
async function genericGerbers(root: string, config: CopperheadConfig, out: string, files: FabExportFile[]): Promise<FabExportFile[]> {
  const board = parseSexp(await readFile(await safePath(root, config.board!), 'utf8'))[0];
  if (!isList(board ?? '') || board![0] !== 'kicad_pcb') throw new Error('expected a KiCad board');
  const rows = child(board!, 'layers');
  const layers = (rows ?? []).filter(isList).map(row => row[1]).filter((name): name is string =>
    typeof name === 'string' && /^(?:(?:F|B|In\d+)\.Cu|[FB]\.(?:Mask|SilkS|Paste)|Edge\.Cuts)$/.test(name));
  if (!layers.includes('F.Cu') || !layers.includes('B.Cu')) throw new Error('board has no complete copper layer list');
  const copper = layers.filter(n => n.endsWith('.Cu')).sort((a, b) =>
    (a === 'F.Cu' ? 0 : a === 'B.Cu' ? 100 : Number(a.slice(2, -3))) -
    (b === 'F.Cu' ? 0 : b === 'B.Cu' ? 100 : Number(b.slice(2, -3))));
  const functions: Record<string, string> = { 'F.Mask': 'Soldermask,Top', 'B.Mask': 'Soldermask,Bot',
    'F.SilkS': 'Legend,Top', 'B.SilkS': 'Legend,Bot', 'F.Paste': 'Paste,Top', 'B.Paste': 'Paste,Bot', 'Edge.Cuts': 'Profile,NP' };
  copper.forEach((name, i) => { functions[name] = `Copper,L${i + 1},${i === 0 ? 'Top' : i === copper.length - 1 ? 'Bot' : 'Inr'}`; });
  const found = new Set<string>();
  const selected: FabExportFile[] = [];
  for (const file of files.filter(f => f.artifact === 'gerbers' && !f.path.endsWith('.gbrjob'))) {
    const text = await readFile(await safePath(out, file.path), 'utf8');
    const fn = /%TF\.FileFunction,([^*]+)\*%/.exec(text)?.[1];
    for (const layer of layers) {
      // KiCad 8+ defaults to X2. Canonical filename suffixes also cover non-X2 output.
      if (fn === functions[layer] || fn?.startsWith(`${functions[layer]},`) || (!fn && path.basename(file.path).startsWith(`${path.basename(config.board!, '.kicad_pcb')}-${layer.replaceAll('.', '_')}.`))) {
        found.add(layer);
        selected.push(file);
        break;
      }
    }
  }
  for (const layer of layers) if (!found.has(layer)) throw new Error(`required Gerber layer missing: ${layer}`);
  return selected;
}

/** The export tool may be board-only; Stage 6 always requires the full design package. */
async function genericOutputsGap(root: string, config: CopperheadConfig, full: boolean): Promise<string | null> {
  try {
    const out = path.join(root, 'outputs');
    const m = JSON.parse(await readFile(await safePath(out, MANIFEST), 'utf8')) as GenericManifest;
    if (m.schema !== 1 || m.state !== 'complete' || m.profile !== 'generic' ||
        m.profileVerification !== 'not-requested' || m.zoneFill !== 'not-verified' ||
        m.manufacturerAcceptance !== 'not-verified' || !m.kicadVersion) throw new Error('missing successful generic export evidence');
    const current = await sources(root, config, full);
    if (JSON.stringify(m.sources) !== JSON.stringify(current)) throw new Error('export sources changed');
    const seen = new Set<string>();
    for (const file of m.files) {
      if (seen.has(file.path)) throw new Error('duplicate export file');
      seen.add(file.path);
      const bytes = await readFile(await safePath(out, file.path));
      if (!bytes.length || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`missing, empty or changed output: ${file.path}`);
    }
    const required = [...GENERIC_REQUIRED, ...(config.schematic ? ['schematic.svg'] : []),
      ...(full || m.files.some(f => f.artifact === 'BOM.csv') ? ['BOM.csv'] : [])];
    for (const artifact of required) if (!m.files.some(f => f.artifact === artifact)) throw new Error(`required output missing: ${artifact}`);
    if (required.includes('BOM.csv') && await readFile(await safePath(out, 'BOM.csv'), 'utf8') !==
        orderingBom(await readFile(await safePath(root, path.join(config.docs, 'BOM.md')), 'utf8'))) throw new Error('ordering BOM differs from BOM.md');
    if (!(await readFile(await safePath(out, GENERIC_ARCHIVE))).equals(await genericArchive(root, config, out, m.files))) throw new Error('generic ZIP differs from its export inventory');
    return null;
  } catch (e) { return `outputs package incomplete: ${(e as Error).message}; rerun export_outputs with the selected outputProfile (legacy files are not verified evidence)`; }
}

async function exportGenericOutputs(root: string, config: CopperheadConfig): Promise<FabExportResult> {
  const out = path.join(root, 'outputs');
  const incomplete = JSON.stringify({ schema: 1, profile: 'generic', state: 'incomplete', manufacturerAcceptance: 'not-verified' }) + '\n';
  let result: FabExportResult | undefined;
  try {
    await writeOutput(out, MANIFEST, incomplete);
    const before = await sources(root, config, false);
    const version = await kicadCliVersion();
    result = await exportFab(path.join(root, config.board!), config.schematic ? path.join(root, config.schematic) : null, out);
    if (result.failed.length) return result;
    const extras: [string, Buffer][] = [[GENERIC_ARCHIVE, await genericArchive(root, config, out, result.files)]];
    if (before[path.join(config.docs, 'BOM.md')]) {
      try { extras.push(['BOM.csv', Buffer.from(orderingBom(await readFile(await safePath(root, path.join(config.docs, 'BOM.md')), 'utf8')))]); }
      catch (e) { result.warnings = [`BOM.csv not exported; create Stage 6 incomplete: ${(e as Error).message}`]; }
    } else result.warnings = ['BOM.csv not exported; create Stage 6 requires an ordering BOM.md'];
    for (const [artifact, bytes] of extras) {
      await writeOutput(out, artifact, bytes);
      result.files.push({ artifact, path: artifact, bytes: bytes.length }); result.produced.push(artifact);
    }
    if (JSON.stringify(before) !== JSON.stringify(await sources(root, config, false))) throw new Error('source changed during export');
    const files: RecordedFile[] = [];
    for (const file of result.files) {
      const bytes = await readFile(await safePath(out, file.path));
      if (!bytes.length || bytes.length !== file.bytes) throw new Error(`export size changed: ${file.path}`);
      files.push({ ...file, sha256: hash(bytes) });
    }
    const manifest: GenericManifest = { schema: 1, state: 'complete', profile: 'generic', kicadVersion: version,
      profileVerification: 'not-requested', zoneFill: 'not-verified', manufacturerAcceptance: 'not-verified', sources: before, files };
    const data = JSON.stringify(manifest, null, 2) + '\n';
    await writeOutput(out, MANIFEST, data);
    const gap = await genericOutputsGap(root, config, false);
    if (gap) throw new Error(gap);
    result.files.push({ artifact: MANIFEST, path: MANIFEST, bytes: Buffer.byteLength(data) }); result.produced.push(MANIFEST);
    return result;
  } catch (e) {
    try { await writeOutput(out, MANIFEST, incomplete); } catch { /* Never follow unsafe destinations. */ }
    return { produced: result?.produced ?? [], files: result?.files ?? [], failed: [{ artifact: 'generic exports', reason: (e as Error).message }] };
  }
}

export async function exportOutputsPackage(root: string, config: CopperheadConfig): Promise<FabExportResult> {
  try {
    return selectedProfile(config) === JLC_PROFILE ? await exportJlcOutputsPackage(root, config) : await exportGenericOutputs(root, config);
  } catch (e) { return { produced: [], files: [], failed: [{ artifact: 'output profile', reason: (e as Error).message }] }; }
}

/** Profile-bound finish/resume contract. Never migrate old evidence by relabeling it. */
export async function outputsPackageGap(root: string, config: CopperheadConfig): Promise<string | null> {
  try {
    const gap = selectedProfile(config) === JLC_PROFILE ? await jlcOutputsPackageGap(root, config) : await genericOutputsGap(root, config, true);
    return gap ? `${gap}; rerun export_outputs for outputProfile=${selectedProfile(config)}` : null;
  } catch (e) { return `outputs package incomplete: ${(e as Error).message}`; }
}
