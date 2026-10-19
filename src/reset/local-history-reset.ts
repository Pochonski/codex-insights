import {createHash} from 'node:crypto';
import {mkdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {HistoricalSnapshot,Counters} from '../reconciliation/historical';
import {snapshotDigest} from '../reconciliation/historical';
import {SessionDatabase,type IndexedFile} from '../storage/session-db';

export interface LocalHistoryResetPlan {
  format:1;
  kind:'complete-local-token-reset';
  createdAt:string;
  cutoffAt:string;
  snapshotDigest:string;
  baselineDigest:string;
  planId:string;
  affected:{events:number;sessions:number;totals:Counters};
  baseline:{files:number;observations:number;partialFiles:number;entries:[string,IndexedFile][]};
  applicationEnabled:false;
}

export interface LocalHistoryResetSummary {
  mode:'dry-run'; strategy:'complete-reset'; cutoffAt:string;
  affectedEvents:number; affectedSessions:number; affectedTotals:Counters;
  baselineFiles:number; baselineObservations:number; partialFiles:number;
  historicalJsonlModified:false; officialQuotasModified:false; changesApplied:false;
  applicationEnabled:false;
}

const zero=():Counters=>({input:0,cached:0,output:0,reasoning:0});
const add=(a:Counters,b:Counters):Counters=>({input:a.input+b.input,cached:a.cached+b.cached,output:a.output+b.output,reasoning:a.reasoning+b.reasoning});
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordered=(baseline:Map<string,IndexedFile>):[string,IndexedFile][]=>[...baseline].sort(([a],[b])=>a.localeCompare(b)).map(([file,item])=>[file,{...item,lastReadAt:item.mtimeMs,events:[],observations:[...(item.observations??[])].sort((a,b)=>a.id.localeCompare(b.id)).map(value=>({...value}))}]);

export function buildLocalHistoryResetPlan(snapshot:HistoricalSnapshot,baseline:Map<string,IndexedFile>,now=new Date().toISOString()):LocalHistoryResetPlan{
  const entries=ordered(baseline);
  for(const [,entry] of entries){
    if(entry.events.length)throw new Error('Reset baseline contains token events.');
    if(entry.offset<0||entry.offset>entry.size)throw new Error('Reset baseline contains an invalid byte checkpoint.');
  }
  const totals=snapshot.events.reduce((sum,event)=>add(sum,event.counters),zero());
  const sessions=new Set(snapshot.events.map(event=>event.sessionId)).size;
  const sourceHash=digest(entries);
  const core={format:1 as const,kind:'complete-local-token-reset' as const,createdAt:now,cutoffAt:now,snapshotDigest:snapshotDigest(snapshot),baselineDigest:sourceHash,
    affected:{events:snapshot.events.length,sessions,totals},baseline:{files:entries.length,observations:entries.reduce((n,[,entry])=>n+(entry.observations?.length??0),0),partialFiles:entries.filter(([,entry])=>!!entry.partial).length,entries},applicationEnabled:false as const};
  return {...core,planId:digest(core)};
}

export function validateLocalHistoryResetPlan(plan:LocalHistoryResetPlan,snapshot:HistoricalSnapshot,baseline:Map<string,IndexedFile>):{valid:boolean;reason:string}{
  if(plan.format!==1||plan.kind!=='complete-local-token-reset'||plan.applicationEnabled!==false)return {valid:false,reason:'Unsupported or executable reset plan.'};
  if(plan.snapshotDigest!==snapshotDigest(snapshot)||plan.baselineDigest!==digest(ordered(baseline)))return {valid:false,reason:'The storage snapshot or JSONL baseline changed after plan generation.'};
  const expected=buildLocalHistoryResetPlan(snapshot,baseline,plan.createdAt);
  return expected.planId===plan.planId&&digest(expected)===digest(plan)?{valid:true,reason:'Plan matches the isolated snapshot; application remains disabled.'}:{valid:false,reason:'Reset plan contents differ from the deterministic result.'};
}

export function publicLocalHistoryResetSummary(plan:LocalHistoryResetPlan):LocalHistoryResetSummary{
  return {mode:'dry-run',strategy:'complete-reset',cutoffAt:plan.cutoffAt,affectedEvents:plan.affected.events,affectedSessions:plan.affected.sessions,affectedTotals:{...plan.affected.totals},baselineFiles:plan.baseline.files,baselineObservations:plan.baseline.observations,partialFiles:plan.baseline.partialFiles,historicalJsonlModified:false,officialQuotasModified:false,changesApplied:false,applicationEnabled:false};
}

/** Test-only/application-review primitive. Public CLI application stays blocked. */
export async function applyLocalHistoryResetToIsolatedCopy(plan:LocalHistoryResetPlan,directory:string,stateFile:string):Promise<void>{
  mkdirSync(directory,{recursive:true,mode:0o700});
  const resolvedDirectory=realpathSync(directory),resolvedStateParent=realpathSync(path.dirname(stateFile)),temporaryRoot=realpathSync(os.tmpdir());
  const outsideTemporary=(value:string)=>{const relative=path.relative(temporaryRoot,value);return relative.startsWith('..')||path.isAbsolute(relative);};
  if(outsideTemporary(resolvedDirectory)||outsideTemporary(resolvedStateParent))throw new Error('Isolated reset application is restricted to temporary test storage.');
  const segments=resolvedDirectory.split(path.sep).map(part=>part.toLowerCase());
  if(segments.includes('globalstorage')||segments.includes('.codex'))throw new Error('Refusing to write live personal storage.');
  if(plan.applicationEnabled!==false)throw new Error('Executable reset plans are unsupported.');
  const {planId,...core}=plan;if(digest(core)!==planId)throw new Error('Reset plan integrity check failed.');
  const baseline=new Map(plan.baseline.entries.map(([file,entry])=>[file,{...entry,events:[],observations:(entry.observations??[]).map(item=>({...item}))}]));
  const database=new SessionDatabase(directory);
  try{if(await database.open())database.replaceWithBaseline(baseline);}finally{database.close();}
  const serializable=[...baseline].map(([file,entry])=>({file,...entry}));
  mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o700});
  const temporary=stateFile+'.reset-'+process.pid;
  writeFileSync(temporary,JSON.stringify(serializable),{encoding:'utf8',mode:0o600});
  renameSync(temporary,stateFile);
}
