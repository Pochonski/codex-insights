import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { UsageEvent } from '../core/types';
import {SessionDatabase,type IndexedFile} from '../storage/session-db';

export function defaultSessionsPath():string { return path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'sessions'); }
export async function findSessionFiles(root:string, maxFiles=2000):Promise<string[]> {
  const files:string[]=[]; const stack=[root];
  while(stack.length && files.length<maxFiles){ const dir=stack.pop()!; let entries;
    try { entries=await fs.readdir(dir,{withFileTypes:true}); } catch { continue; }
    for(const e of entries){ if(e.isSymbolicLink()) continue; const full=path.join(dir,e.name);
      if(e.isDirectory()) stack.push(full); else if(e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
      if(files.length>=maxFiles) break;
    }
  }
  return files.sort();
}
function num(v:unknown):number { return typeof v==='number' && Number.isFinite(v) && v>=0 ? Math.floor(v):0; }
function obj(v:unknown):Record<string,unknown> { return v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown>:{}; }
export function parseSession(content:string,sourceFile:string):UsageEvent[] {
  let sessionId=path.basename(sourceFile,'.jsonl'); let model:string|undefined; let project:string|undefined; let lastTotals:Record<string,number>|undefined;
  const events:UsageEvent[]=[]; let lineNo=0;
  for(const line of content.split(/\r?\n/)){lineNo++; if(!line.trim())continue; let record:Record<string,unknown>;
    try{record=obj(JSON.parse(line));}catch{continue;}
    const payload=obj(record.payload); const info=obj(payload.info);
    if(record.type==='session_meta'){if(typeof payload.id==='string')sessionId=payload.id;if(typeof payload.cwd==='string'&&payload.cwd.trim())project=payload.cwd;}
    if(record.type==='turn_context'){if(typeof payload.model==='string')model=payload.model;if(typeof payload.cwd==='string'&&payload.cwd.trim())project=payload.cwd;}
    if(record.type!=='event_msg' || payload.type!=='token_count')continue;
    const total=obj(info.total_token_usage);
    // total_token_usage is cumulative; calculate deltas to avoid double counting.
    if(!Object.keys(total).length)continue;
    const keys=['input_tokens','output_tokens','cached_input_tokens','reasoning_output_tokens'];
    const now=Object.fromEntries(keys.map(k=>[k,num(total[k])]));
    const delta=Object.fromEntries(keys.map(k=>[k,Math.max(0,now[k]-(lastTotals?.[k]??0))]));
    // A lower cumulative total indicates a counter reset: count new totals from zero.
    if(lastTotals && keys.some(k=>now[k]<lastTotals![k]))for(const k of keys)delta[k]=now[k];
    lastTotals=now;
    if(!keys.some(k=>delta[k]>0))continue;
    const timestamp=typeof record.timestamp==='string'?record.timestamp:'';
    events.push({id:createHash('sha256').update(sourceFile+':'+lineNo).digest('hex'),fingerprint:createHash('sha256').update(sessionId+':'+JSON.stringify(record)).digest('hex'),sessionId,timestamp,model,project,inputTokens:delta.input_tokens,outputTokens:delta.output_tokens,cachedInputTokens:delta.cached_input_tokens,reasoningOutputTokens:delta.reasoning_output_tokens,sourceFile});
  }
  return events;
}
export async function collectSessions(root:string):Promise<{filesScanned:number;events:UsageEvent[];warnings:string[]}>{
  const files=await findSessionFiles(root);const events:UsageEvent[]=[];const warnings:string[]=[];
  for(const file of files){try{const stat=await fs.stat(file);if(stat.size>25*1024*1024){warnings.push(`Skipped oversized file: ${path.basename(file)}`);continue;}events.push(...parseSession(await fs.readFile(file,'utf8'),file));}catch{warnings.push(`Could not read ${path.basename(file)}`);}}
  return {filesScanned:files.length,events,warnings};
}

/** Persistent file index: unchanged JSONL files are not reparsed after refresh or restart. */
export class SessionIndex {
 private cache=new Map<string,IndexedFile>();
 private loaded=false;private readonly database:SessionDatabase;
 constructor(private readonly stateFile:string){this.database=new SessionDatabase(path.dirname(stateFile));}
 get storageMode(){return this.database.available?'sqlite + json fallback':'json';}
 close(){this.database.close();}
 private async load(){if(this.loaded)return;this.loaded=true;await this.database.open();try{const parsed:unknown=JSON.parse(await fs.readFile(this.stateFile,'utf8'));if(Array.isArray(parsed))for(const item of parsed){if(item&&typeof item==='object'){const v=item as Record<string,unknown>;if(typeof v.file==='string'&&typeof v.size==='number'&&typeof v.mtimeMs==='number'&&Array.isArray(v.events))this.cache.set(v.file,{size:v.size,mtimeMs:v.mtimeMs,events:v.events as UsageEvent[]});}}}catch{/* Read the SQLite index if the JSON fallback is absent. */}
  if(!this.cache.size&&this.database.available)this.cache=this.database.read();}
 async scan(root:string):Promise<{filesScanned:number;events:UsageEvent[];warnings:string[]}>{
  await this.load();
  try{await fs.readdir(root);}catch{return {filesScanned:0,events:[...this.cache.values()].flatMap(v=>v.events),warnings:['Sessions directory is unavailable; showing the last indexed data.']};}
  const files=await findSessionFiles(root);const warnings:string[]=[];let changed=false;
  for(const file of files){try{const stat=await fs.stat(file);if(stat.size>25*1024*1024){warnings.push(`Skipped oversized file: ${path.basename(file)}`);continue;}const prior=this.cache.get(file);if(prior&&prior.size===stat.size&&prior.mtimeMs===stat.mtimeMs)continue;
   const events=parseSession(await fs.readFile(file,'utf8'),file);
   if(prior){const match=new Map(events.map(e=>[e.id,JSON.stringify([e.timestamp,e.sessionId,e.inputTokens,e.outputTokens,e.cachedInputTokens,e.reasoningOutputTokens]) ]));
    const lost=prior.events.filter(e=>match.get(e.id)!==JSON.stringify([e.timestamp,e.sessionId,e.inputTokens,e.outputTokens,e.cachedInputTokens,e.reasoningOutputTokens]));
    if(lost.length){const archivedFile=`${file}#archived:${prior.mtimeMs}`;this.cache.set(archivedFile,{size:prior.size,mtimeMs:prior.mtimeMs,events:lost.map(e=>({...e,id:createHash('sha256').update(e.id+archivedFile).digest('hex'),sourceFile:archivedFile}))});}
   }
   this.cache.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,events});changed=true;
  }catch{warnings.push(`Could not read ${path.basename(file)}`);}}
  if(changed){await fs.mkdir(path.dirname(this.stateFile),{recursive:true});const temp=this.stateFile+'.tmp';await fs.writeFile(temp,JSON.stringify([...this.cache].map(([file,v])=>({file,...v}))),{mode:0o600});await fs.rename(temp,this.stateFile);}
  try{this.database.sync(this.cache);}catch{warnings.push('SQLite session index could not be updated; JSON fallback remains available.');}
  return {filesScanned:files.length,events:[...this.cache.values()].flatMap(v=>v.events),warnings};
 }
}
