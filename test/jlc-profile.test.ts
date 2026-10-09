import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { STAGES } from '../src/commands/create.js';
import { jlcProfile } from '../src/kicad/jlc-profile.js';
import { resetKicadCliCache } from '../src/kicad/cli.js';
import type { RunContext } from '../src/agent/context.js';
const exec = vi.hoisted(() => vi.fn());
vi.mock('execa', async (original) => ({ ...(await original<typeof import('execa')>()), execa: exec }));
const ok = { failed: false, exitCode: 0, stdout: '', stderr: '' };
const board = '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))';
const bom = '| Refdes | Value | Footprint | MPN |\n|---|---|---|---|\n| R1 | 1k | R_0603 | RC0603 |\n';
const expectedLayers = ['F.Cu','B.Cu','F.Mask','B.Mask','F.SilkS','B.SilkS','Edge.Cuts','F.Paste','B.Paste'];
const functions: Record<string, [string,string]> = {
 'F.Cu':['gtl','Copper,L1,Top'], 'B.Cu':['gbl','Copper,L2,Bot'], 'F.Mask':['gts','Soldermask,Top'],
 'B.Mask':['gbs','Soldermask,Bot'], 'F.SilkS':['gto','Legend,Top'], 'B.SilkS':['gbo','Legend,Bot'],
 'Edge.Cuts':['gm1','Profile,NP'], 'F.Paste':['gtp','Paste,Top'], 'B.Paste':['gbp','Paste,Bot'],
};
async function put(file:string, text:string) { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file,text); }
async function emit(args:string[]) {
 if (args[0] === 'version') return { ...ok, stdout:'9.0.2' };
 const out = args[args.indexOf('--output') + 1]!;
 if(args[2] === 'gerbers') {
  for (const layer of expectedLayers) { const [ext,fn] = functions[layer]!; await put(path.join(out,`board-${layer.replace('.','_')}.${ext}`), `%TF.FileFunction,${fn}*%\n%FSLAX46Y46*%\n%MOMM*%\n%TO.N,GND*%\nM02*\n`); }
 } else if(args[2] === 'drill') {
  for (const type of ['PTH','NPTH']) await put(path.join(out,`board-${type}.drl`), `M48\n; FORMAT={-:-/ absolute / metric / decimal}\n; #@! TF.FileFunction,${type==='PTH'?'Plated':'NonPlated'},1,2,${type}\nMETRIC\nM30\n`);
 } else if(args[2] === 'dxf') await put(path.join(out,'board-Edge_Cuts.dxf'),'0\nSECTION\n0\nEOF\n');
 else if(args[2] === 'step') await put(out,'ISO-10303-21;\nEND-ISO-10303-21;\n');
 else if(args[2] === 'svg') await put(args[0] === 'sch' ? path.join(out,'board.svg') : out,'<svg xmlns="http://www.w3.org/2000/svg"/>\n');
 return ok;
}
describe('explicit JLC export and existing outputs contract', () => {
 let root:string; let ctx:RunContext;
 const handler = HANDLERS.find(x=>x.schema.name==='export_outputs')!;
 const stage = STAGES.find(x=>x.name==='outputs')!;
 beforeEach(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'jlc-profile-'));
  const config = { outputProfile:'jlcpcb-kicad9-2026-09-24', board:'board.kicad_pcb', schematic:'board.kicad_sch',docs:'docs' };
  await put(path.join(root,'.copperhead/config.json'),JSON.stringify(config));
  await put(path.join(root,config.board),board);
  await put(path.join(root,config.schematic),'(kicad_sch)');
  await put(path.join(root,'docs/BOM.md'),bom);
  ctx={repoRoot:root,config,filesTouched:new Set()} as unknown as RunContext;
  resetKicadCliCache(); exec.mockReset(); exec.mockImplementation(async(_bin,args:string[])=>emit(args));
 });
 afterEach(async()=>{ resetKicadCliCache(); await rm(root,{recursive:true,force:true}); });
 it('explicitly pins supported manufacturing layers and separate metric decimal absolute drilling',async()=>{
  const result = await handler.handler(ctx,{});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true});
  const calls=exec.mock.calls.map(c=>c[1] as string[]);
  const gerber=calls.find(c=>c[2]==='gerbers')!;
  expect(gerber[gerber.indexOf('--layers')+1]).toBe(expectedLayers.join(','));
  expect(gerber).not.toEqual(expect.arrayContaining(['--no-x2','--no-netlist','--no-protel-ext']));
  expect(calls.find(c=>c[2]==='drill')).toEqual(expect.arrayContaining(['--format','excellon','--drill-origin','absolute','--excellon-units','mm','--excellon-zeros-format','decimal','--excellon-oval-format','alternate','--excellon-separate-th']));
 });
 it('produces the ZIP, full ordering BOM and source-bound manifest, without factory-approval claims',async()=>{
  const result=await handler.handler(ctx,{});
  expect(result).toMatchObject({ok:true});
  expect((await readFile(path.join(root,'outputs/jlcpcb.zip'))).subarray(0,4).toString('hex')).toBe('504b0304');
  expect(await readFile(path.join(root,'outputs/BOM.csv'),'utf8')).toBe('Refdes,MPN,Qty\r\nR1,RC0603,1\r\n');
  expect(JSON.parse(await readFile(path.join(root,'outputs/export-manifest.json'),'utf8'))).toMatchObject({profile:'jlcpcb-kicad9-2026-09-24',zoneFill:'not-applicable-no-copper-zones',manufacturerAcceptance:'not-verified'});
  expect(await stage.isComplete(root,'docs')).toBe(true);
 });
 it('does not accept a standalone dummy Gerber as completed outputs',async()=>{
  await put(path.join(root,'outputs/dummy.gbr'),'G04*\n');
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('rejects unverifiable copper zones before plotting, without changing the board',async()=>{
  const zoned=board.slice(0,-1)+' (zone (net 1) (layer "F.Cu")))';
  await put(path.join(root,'board.kicad_pcb'),zoned);
  const result=await handler.handler(ctx,{});
  expect(result).toMatchObject({ok:false});
  expect(typeof result==='string'?result:result.text).toMatch(/zone.*fill|fill.*zone/i);
  expect(exec.mock.calls.some(c=>(c[1] as string[])[2]==='gerbers')).toBe(false);
  expect(await readFile(path.join(root,'board.kicad_pcb'),'utf8')).toBe(zoned);
 });
 it('does not mark an unverified KiCad major version profile successful',async()=>{
  exec.mockImplementation(async(_bin,args:string[])=>args[0]==='version'?{...ok,stdout:'10.0.0'}:emit(args));
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
 });
 it.each(['board.kicad_pcb','board.kicad_sch','docs/BOM.md'])('invalidates completion after %s changes',async(file)=>{
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  await put(path.join(root,file),(await readFile(path.join(root,file),'utf8'))+'\n; changed\n');
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it.each(['gerbers/board-F_Cu.gtl','gerbers/board-NPTH.drl','board.step','board.svg','BOM.csv','jlcpcb.zip'])('rejects missing required artifact %s',async(file)=>{
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  await rm(path.join(root,'outputs',file),{force:true});
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('failed reruns cannot leave a prior success manifest valid',async()=>{
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  exec.mockImplementation(async(_bin,args:string[])=>args[2]==='step'?{...ok,failed:true,exitCode:1,stderr:'test STEP failure'}:emit(args));
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('excludes unrelated stale exports from the manufacturing ZIP',async()=>{
  await put(path.join(root,'outputs/gerbers/old-merged.drl'),'old merged drill');
  await put(path.join(root,'outputs/gerbers/old-Courtyard.gbr'),'stale courtyard');
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  const zip=await readFile(path.join(root,'outputs/jlcpcb.zip'));
  expect(zip.includes(Buffer.from('old-merged'))).toBe(false);
  expect(zip.includes(Buffer.from('old-Courtyard'))).toBe(false);
  expect(await readFile(path.join(root,'outputs/gerbers/old-merged.drl'),'utf8')).toBe('old merged drill');
 });
 it('rejects omitted Gerber layers even when the exporter exits zero',async()=>{
  exec.mockImplementation(async(_bin,args:string[])=>{
   const result=await emit(args);
   if(args[2]==='gerbers') await rm(path.join(args[args.indexOf('--output')+1]!,'board-B_Cu.gbl'));
   return result;
  });
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('rejects corrupt drill metadata rather than trusting the filename',async()=>{
  exec.mockImplementation(async(_bin,args:string[])=>{
   const result=await emit(args);
   if(args[2]==='drill') await put(path.join(args[args.indexOf('--output')+1]!,'board-NPTH.drl'),'M48\ncombined unverified drill\nM30\n');
   return result;
  });
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
 });
 it('binds child schematics and project settings into source freshness',async()=>{
  await put(path.join(root,'board.kicad_sch'),'(kicad_sch (sheet (property "Sheetfile" "power.kicad_sch")))');
  await put(path.join(root,'power.kicad_sch'),'(kicad_sch)');
  await put(path.join(root,'board.kicad_pro'),'{}');
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  await put(path.join(root,'power.kicad_sch'),'(kicad_sch)\n');
  expect(await stage.isComplete(root,'docs')).toBe(false);
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  await put(path.join(root,'board.kicad_pro'),'{"changed":true}');
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('rejects a byte-modified archive without relying on size',async()=>{
  expect(await handler.handler(ctx,{})).toMatchObject({ok:true});
  const file=path.join(root,'outputs/jlcpcb.zip'); const data=await readFile(file); data[50]=data[50]!^1; await writeFile(file,data);
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it.each(['N/A', 'n / a'])('rejects %s as an ordering MPN placeholder',async(mpn)=>{
  await put(path.join(root,'docs/BOM.md'),bom.replace('RC0603',mpn));
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
  expect(await stage.isComplete(root,'docs')).toBe(false);
 });
 it('rejects an ordering BOM with ambiguous quantity or a missing MPN',async()=>{
  await put(path.join(root,'docs/BOM.md'),bom.replace('R1 |','R1,R2 |'));
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
  await put(path.join(root,'docs/BOM.md'),bom.replace('RC0603','TBD'));
  expect(await handler.handler(ctx,{})).toMatchObject({ok:false});
 });

});

describe('manufacturing layer and zone selection',()=>{
 it('retains all four copper layers in stack order, including renamed display layers',()=>{
  const four=board.replace('(31 "B.Cu" signal)','(2 "In2.Cu" power "Ground") (1 "In1.Cu" signal "Power") (31 "B.Cu" signal)');
  expect(jlcProfile(four).layers.slice(0,4)).toEqual(['F.Cu','In1.Cu','In2.Cu','B.Cu']);
  expect(jlcProfile(four).functions.slice(0,4)).toEqual(['Copper,L1,Top','Copper,L2,Inr','Copper,L3,Inr','Copper,L4,Bot']);
 });
 it('rejects incomplete copper stacks',()=>{
  expect(()=>jlcProfile(board.replace('(31 "B.Cu" signal)','(2 "In2.Cu" signal) (31 "B.Cu" signal)'))).toThrow(/stack/);
 });
 it('allows rule-area keepouts, which contain no copper fill',()=>{
  expect(jlcProfile(board.slice(0,-1)+' (zone (keepout (tracks not_allowed))))').layers).toEqual(expectedLayers);
 });
 it('rejects footprint copper zones too',()=>{
  expect(()=>jlcProfile(board.slice(0,-1)+' (footprint "module" (zone (layer "F.Cu"))))')).toThrow(/zone fill/);
 });
});
