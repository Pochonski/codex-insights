import {describe,expect,it} from 'vitest';
import {appendFileSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildCutoverEntry,SessionIndex} from '../src/collectors/sessions';
import {aggregate} from '../src/analytics/aggregate';
import {SessionDatabase} from '../src/storage/session-db';
import {readJsonSnapshot,readSqliteSnapshot} from '../src/reconciliation/snapshot';
import {applyLocalHistoryResetToIsolatedCopy,buildLocalHistoryResetPlan,publicLocalHistoryResetSummary,validateLocalHistoryResetPlan} from '../src/reset/local-history-reset';

const meta=(id:string,parent?:string)=>JSON.stringify({type:'session_meta',payload:{id,...(parent?{forked_from_id:parent}:{})}});
const usage=(input:number,at:string,cached=0,last?:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:Math.floor(input/10),reasoning_output_tokens:Math.floor(input/100)},...(last===undefined?{}:{last_token_usage:{input_tokens:last,cached_input_tokens:Math.min(cached,last),output_tokens:Math.floor(last/10),reasoning_output_tokens:Math.floor(last/100)}})}}});
const lines=(...items:string[])=>items.join('\n')+'\n';
const env=()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-reset-test-')),root=path.join(dir,'sessions');mkdirSync(root);return{dir,root,state:path.join(dir,'sessions-index.json'),file:(name:string)=>path.join(root,name+'.jsonl')}};
class UnavailableDatabase extends SessionDatabase{override async open(){return false;}}

describe('controlled local token history reset',()=>{
 it('creates a deterministic, non-executable dry-run plan with exact affected totals',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z',80),usage(150,'2026-01-01T00:01:00Z',120)));
  const index=new SessionIndex(f.state);await index.scan(f.root);const input=index.historicalAuditInput(),baseline=index.resetBaseline();index.close();
  const plan=buildLocalHistoryResetPlan(input.snapshot,baseline,'2026-02-01T00:00:00.000Z');
  expect(publicLocalHistoryResetSummary(plan)).toMatchObject({affectedEvents:2,affectedSessions:1,affectedTotals:{input:150,cached:120,output:15,reasoning:1},changesApplied:false,applicationEnabled:false});
  expect(validateLocalHistoryResetPlan(plan,input.snapshot,baseline).valid).toBe(true);
  const laterRead=new Map([...baseline].map(([file,entry])=>[file,{...entry,lastReadAt:Date.now()+10_000}]));expect(validateLocalHistoryResetPlan(plan,input.snapshot,laterRead).valid).toBe(true);
  expect(validateLocalHistoryResetPlan({...plan,snapshotDigest:'changed'},input.snapshot,baseline).valid).toBe(false);
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('cuts over an isolated SQLite copy without reimport and counts only later deltas across restart',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z',80),usage(150,'2026-01-01T00:01:00Z',120)));
  let index=new SessionIndex(f.state);await index.scan(f.root);const input=index.historicalAuditInput(),baseline=index.resetBaseline();index.close();
  const dbPath=path.join(f.dir,'insights.sqlite'),backup=path.join(f.dir,'before-reset.sqlite');copyFileSync(dbPath,backup);
  const plan=buildLocalHistoryResetPlan(input.snapshot,baseline);await applyLocalHistoryResetToIsolatedCopy(plan,f.dir,f.state);
  expect((await readSqliteSnapshot(dbPath)).events).toHaveLength(0);expect(readJsonSnapshot(f.state).events).toHaveLength(0);
  index=new SessionIndex(f.state);expect((await index.scan(f.root)).events).toHaveLength(0);expect((await index.scan(f.root)).events).toHaveLength(0);index.close();
  appendFileSync(f.file('base'),usage(170,'2026-01-01T00:02:00Z',138)+'\n');
  index=new SessionIndex(f.state);let scan=await index.scan(f.root);expect(aggregate(scan.events).total).toMatchObject({inputTokens:20,cachedInputTokens:18,outputTokens:2});index.close();
  index=new SessionIndex(f.state);scan=await index.scan(f.root);expect(aggregate(scan.events).total.inputTokens).toBe(20);index.close();
  rmSync(dbPath+'-wal',{force:true});rmSync(dbPath+'-shm',{force:true});copyFileSync(backup,dbPath);expect((await readSqliteSnapshot(dbPath)).events).toHaveLength(2);
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('uses the same cutover semantics with the JSON fallback',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z',80)));
  let index=new SessionIndex(f.state,new UnavailableDatabase(f.dir));await index.scan(f.root);const input=index.historicalAuditInput(),baseline=index.resetBaseline();index.close();
  const plan=buildLocalHistoryResetPlan(input.snapshot,baseline);await applyLocalHistoryResetToIsolatedCopy(plan,path.join(f.dir,'isolated-db'),f.state);
  expect(readJsonSnapshot(f.state).events).toHaveLength(0);
  index=new SessionIndex(f.state,new UnavailableDatabase(f.dir));expect((await index.scan(f.root)).events).toHaveLength(0);appendFileSync(f.file('base'),usage(125,'2026-01-01T00:01:00Z',100)+'\n');expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(25);index.close();
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('streams an oversized source into a baseline and later reads only appended usage',async()=>{const f=env();try{
  const padding=JSON.stringify({type:'other',payload:{padding:'x'.repeat(900_000)}})+'\n';
  writeFileSync(f.file('large'),lines(meta('large'),usage(100,'2026-01-01T00:00:00Z',80))+padding.repeat(30));
  const cutover=await buildCutoverEntry(f.file('large'));expect(cutover.entry.offset).toBe(cutover.entry.size);expect(cutover.entry.events).toHaveLength(0);expect(cutover.entry.observations).toHaveLength(1);
  const plan=buildLocalHistoryResetPlan({storage:'json',schemaVersion:6,events:[],observations:[],checkpoints:[]},new Map([[f.file('large'),cutover.entry]]));await applyLocalHistoryResetToIsolatedCopy(plan,path.join(f.dir,'isolated-db'),f.state);
  appendFileSync(f.file('large'),usage(125,'2026-01-01T00:01:00Z',100)+'\n');const index=new SessionIndex(f.state,new UnavailableDatabase(f.dir));const scan=await index.scan(f.root);expect(scan.metrics.bytesRead).toBeLessThan(10_000);expect(aggregate(scan.events).total.inputTokens).toBe(25);index.close();
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('preserves lineage for continuations and independent forks after the cutoff',async()=>{const f=env();try{
  writeFileSync(f.file('parent'),lines(meta('parent'),usage(150,'2026-01-01T00:00:00Z',120)));
  let index=new SessionIndex(f.state);await index.scan(f.root);const input=index.historicalAuditInput(),baseline=index.resetBaseline();index.close();
  await applyLocalHistoryResetToIsolatedCopy(buildLocalHistoryResetPlan(input.snapshot,baseline),f.dir,f.state);
  writeFileSync(f.file('left'),lines(meta('left','parent'),usage(150,'2026-01-01T00:01:00Z',120),usage(170,'2026-01-01T00:02:00Z',138)));
  writeFileSync(f.file('right'),lines(meta('right','parent'),usage(180,'2026-01-01T00:03:00Z',145,30)));
  index=new SessionIndex(f.state);const scan=await index.scan(f.root);expect(aggregate(scan.events).total.inputTokens).toBe(50);expect((await index.scan(f.root)).events).toHaveLength(scan.events.length);index.close();
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('rolls back an invalid SQLite baseline and keeps the JSON fallback unchanged',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(10,'2026-01-01T00:00:00Z')));const index=new SessionIndex(f.state);await index.scan(f.root);index.close();
  const before=readFileSync(f.state,'utf8'),db=new SessionDatabase(f.dir);await db.open();const current=db.read(),first=[...current][0];first[1].events=[...first[1].events];
  expect(()=>db.replaceWithBaseline(current)).toThrow('cannot contain token events');expect([...db.read().values()].flatMap(item=>item.events)).toHaveLength(1);db.close();expect(readFileSync(f.state,'utf8')).toBe(before);
 }finally{rmSync(f.dir,{recursive:true,force:true});}});

 it('refuses any isolated-copy application path resembling personal storage',async()=>{const f=env();try{const plan=buildLocalHistoryResetPlan({storage:'json',schemaVersion:6,events:[],observations:[],checkpoints:[]},new Map());await expect(applyLocalHistoryResetToIsolatedCopy(plan,path.join(f.dir,'globalStorage'),path.join(f.dir,'state.json'))).rejects.toThrow('live personal storage');}finally{rmSync(f.dir,{recursive:true,force:true});}});
});
