import {mkdirSync} from 'node:fs';
import path from 'node:path';
import type {UsageEvent} from '../core/types';
import {assertStorageUnlocked} from './maintenance';

export const SESSION_PARSER_VERSION=2;
export interface CounterObservation {id:string;key:string;sourceFile:string;sessionId:string;parentSessionId?:string;timestamp:string;input:number;output:number;cached:number;reasoning:number;lastInput?:number;lastOutput?:number;lastCached?:number;lastReasoning?:number;decision:'counted'|'duplicate'|'inherited'|'ambiguous';}
export interface IndexedFile {size:number;mtimeMs:number;offset:number;identity:string|null;generation:string|null;parserState:string|null;partial:string|null;parserVersion:number;lastReadAt:number|null;events:UsageEvent[];observations?:CounterObservation[]}
export interface FileCheckpoint extends Omit<IndexedFile,'events'>{}
export interface IncrementalFileUpdate {file:string;checkpoint:FileCheckpoint;events:UsageEvent[];observations?:CounterObservation[];archiveFile?:string;}
interface Db {exec(sql:string):void;prepare(sql:string):{run(...args:(string|number|null)[]):unknown;all(...args:(string|number|null)[]):unknown[]};close():void;}

const DEFAULT_CHECKPOINT:Omit<FileCheckpoint,'size'|'mtimeMs'>={offset:0,identity:null,generation:null,parserState:null,partial:null,parserVersion:SESSION_PARSER_VERSION,lastReadAt:null};

/** SQLite session storage. Checkpoints and inserted token events commit in the same transaction. */
export class SessionDatabase {
 private db:Db|null=null;
 private _error:string|null=null;
 constructor(private readonly directory:string,private readonly maintenanceToken?:string){}
 get available(){return this.db!==null;}
 get error(){return this._error;}
 async open():Promise<boolean>{
  if(this.db)return true;
  assertStorageUnlocked(this.directory,this.maintenanceToken);
  let sqlite:typeof import('node:sqlite');
  try{sqlite=await import('node:sqlite');}catch(error){const code=(error as {code?:string}).code;if(code==='ERR_UNKNOWN_BUILTIN_MODULE'||code==='ERR_MODULE_NOT_FOUND')return false;throw error;}
  mkdirSync(this.directory,{recursive:true,mode:0o700});let db:Db|null=null;
  try{db=new sqlite.DatabaseSync(path.join(this.directory,'insights.sqlite')) as unknown as Db;
   db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
   try{db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT,model_id TEXT,started_at TEXT);
    CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY,fingerprint TEXT,source_file TEXT NOT NULL,session_id TEXT NOT NULL,observed_at TEXT NOT NULL,model_id TEXT,project_id TEXT,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,reasoning_output_tokens INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_token_events_source ON token_events(source_file);
    CREATE INDEX IF NOT EXISTS idx_token_events_time ON token_events(observed_at);
    CREATE TABLE IF NOT EXISTS import_state(source_file TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime_ms REAL NOT NULL);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,strftime('%s','now'));`);
   const eventColumns=db.prepare('PRAGMA table_info(token_events)').all() as {name?:string}[];
   if(!eventColumns.some(column=>column.name==='fingerprint'))db.exec('ALTER TABLE token_events ADD COLUMN fingerprint TEXT');
   db.exec(`INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,strftime('%s','now'));
    DELETE FROM token_events WHERE fingerprint IS NOT NULL AND rowid NOT IN (SELECT MIN(rowid) FROM token_events WHERE fingerprint IS NOT NULL GROUP BY fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_events_fingerprint ON token_events(fingerprint) WHERE fingerprint IS NOT NULL;
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,strftime('%s','now'));`);
   const stateColumns=db.prepare('PRAGMA table_info(import_state)').all() as {name?:string}[];const names=new Set(stateColumns.map(column=>column.name));
   if(!names.has('offset'))db.exec('ALTER TABLE import_state ADD COLUMN offset INTEGER NOT NULL DEFAULT 0');
   if(!names.has('identity'))db.exec('ALTER TABLE import_state ADD COLUMN identity TEXT');
   if(!names.has('generation'))db.exec('ALTER TABLE import_state ADD COLUMN generation TEXT');
   if(!names.has('parser_state'))db.exec('ALTER TABLE import_state ADD COLUMN parser_state TEXT');
   if(!names.has('partial'))db.exec('ALTER TABLE import_state ADD COLUMN partial TEXT');
   if(!names.has('parser_version'))db.exec(`ALTER TABLE import_state ADD COLUMN parser_version INTEGER NOT NULL DEFAULT ${SESSION_PARSER_VERSION}`);
   if(!names.has('last_read_at'))db.exec('ALTER TABLE import_state ADD COLUMN last_read_at INTEGER');
   db.exec(`CREATE INDEX IF NOT EXISTS idx_token_events_session_time ON token_events(session_id,observed_at);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,strftime('%s','now'));
    CREATE TABLE IF NOT EXISTS counter_observations(id TEXT PRIMARY KEY, observation_key TEXT NOT NULL, source_file TEXT NOT NULL, session_id TEXT NOT NULL, parent_session_id TEXT, observed_at TEXT NOT NULL, input_total INTEGER NOT NULL, output_total INTEGER NOT NULL, cached_total INTEGER NOT NULL, reasoning_total INTEGER NOT NULL, last_input INTEGER, last_output INTEGER, last_cached INTEGER, last_reasoning INTEGER, decision TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_counter_observations_key ON counter_observations(observation_key);
    CREATE INDEX IF NOT EXISTS idx_counter_observations_session ON counter_observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_counter_observations_source ON counter_observations(source_file);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(6,strftime('%s','now')); COMMIT;`);
   }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
   this.db=db;this._error=null;return true;
  }catch{try{db?.close();}catch{}this._error='The SQLite session database could not be opened. The original file was preserved.';throw new Error(this._error);}
 }
 read():Map<string,IndexedFile>{
  const result=new Map<string,IndexedFile>();if(!this.db)return result;
  for(const item of this.db.prepare('SELECT source_file,size,mtime_ms,offset,identity,generation,parser_state,partial,parser_version,last_read_at FROM import_state').all()){
   const row=item as Record<string,unknown>;result.set(String(row.source_file),{size:Number(row.size),mtimeMs:Number(row.mtime_ms),offset:Math.max(0,Number(row.offset)||0),identity:nullableString(row.identity),generation:nullableString(row.generation),parserState:nullableString(row.parser_state),partial:nullableString(row.partial),parserVersion:Number(row.parser_version)||1,lastReadAt:row.last_read_at===null?null:Number(row.last_read_at),events:[]});
  }
  for(const item of this.db.prepare('SELECT * FROM token_events ORDER BY source_file,observed_at').all()){
   const row=item as Record<string,unknown>,file=String(row.source_file);let state=result.get(file);
   // Archived generations deliberately have no import_state row but must survive restarts.
   if(!state){state={size:0,mtimeMs:0,events:[],...DEFAULT_CHECKPOINT};result.set(file,state);}
   state.events.push(toEvent(row,file));
  }
  for(const item of this.db.prepare('SELECT * FROM counter_observations ORDER BY source_file,observed_at').all()){
   const row=item as Record<string,unknown>,file=String(row.source_file);let state=result.get(file);
   if(!state){state={size:0,mtimeMs:0,events:[],...DEFAULT_CHECKPOINT};result.set(file,state);}
   (state.observations??=[]).push(toObservation(row,file));
  }
  return result;
 }
 applyIncremental(update:IncrementalFileUpdate):void{
  if(!this.db)return;assertStorageUnlocked(this.directory,this.maintenanceToken);const db=this.db;const removeState=db.prepare('DELETE FROM import_state WHERE source_file=?');
  const moveEvents=db.prepare('UPDATE token_events SET source_file=? WHERE source_file=?');
  const moveObservations=db.prepare('UPDATE counter_observations SET source_file=? WHERE source_file=?');
  const checkpoint=db.prepare(`INSERT INTO import_state(source_file,size,mtime_ms,offset,identity,generation,parser_state,partial,parser_version,last_read_at) VALUES(?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(source_file) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,offset=excluded.offset,identity=excluded.identity,generation=excluded.generation,parser_state=excluded.parser_state,partial=excluded.partial,parser_version=excluded.parser_version,last_read_at=excluded.last_read_at`);
  const inserts=preparedInserts(db);
  db.exec('BEGIN IMMEDIATE');try{
   if(update.archiveFile){moveEvents.run(update.archiveFile,update.file);moveObservations.run(update.archiveFile,update.file);removeState.run(update.file);}
   for(const event of update.events)insertEvent(inserts,event,update.file);
   for(const observation of update.observations??[])insertObservation(inserts,observation,update.file);
   writeCheckpoint(checkpoint,update.file,update.checkpoint);
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 /** Legacy full-cache synchronization retained for migration tools and benchmarks. */
 sync(cache:Map<string,IndexedFile>):void{
  if(!this.db)return;assertStorageUnlocked(this.directory,this.maintenanceToken);const db=this.db;const indexed=new Map<string,{size:number;mtimeMs:number}>();
  for(const item of db.prepare('SELECT source_file,size,mtime_ms FROM import_state').all()){const row=item as Record<string,unknown>;indexed.set(String(row.source_file),{size:Number(row.size),mtimeMs:Number(row.mtime_ms)});}
  const remove=db.prepare('DELETE FROM token_events WHERE source_file=?'),removeObservations=db.prepare('DELETE FROM counter_observations WHERE source_file=?'),deleteState=db.prepare('DELETE FROM import_state WHERE source_file=?');const checkpoint=db.prepare(`INSERT INTO import_state(source_file,size,mtime_ms,offset,identity,generation,parser_state,partial,parser_version,last_read_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_file) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,offset=excluded.offset,identity=excluded.identity,generation=excluded.generation,parser_state=excluded.parser_state,partial=excluded.partial,parser_version=excluded.parser_version,last_read_at=excluded.last_read_at`);const inserts=preparedInserts(db);
  db.exec('BEGIN IMMEDIATE');try{
   for(const file of indexed.keys())if(!cache.has(file)){remove.run(file);removeObservations.run(file);deleteState.run(file);}
   for(const [file,data] of cache){const old=indexed.get(file);if(old&&old.size===data.size&&old.mtimeMs===data.mtimeMs)continue;remove.run(file);removeObservations.run(file);for(const event of data.events)insertEvent(inserts,event,file);for(const observation of data.observations??[])insertObservation(inserts,observation,file);writeCheckpoint(checkpoint,file,{...DEFAULT_CHECKPOINT,...data});}
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 /**
  * Replaces token statistics with a parser baseline in one SQLite transaction.
  * This primitive is intentionally not called by extension activation or Refresh.
  * Callers must validate a private reset plan and hold a verified backup first.
  */
 replaceWithBaseline(cache:Map<string,IndexedFile>):void{
  if(!this.db)throw new Error('SQLite session storage is not open.');
  assertStorageUnlocked(this.directory,this.maintenanceToken);
  const db=this.db;const checkpoint=db.prepare(`INSERT INTO import_state(source_file,size,mtime_ms,offset,identity,generation,parser_state,partial,parser_version,last_read_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);const inserts=preparedInserts(db);
  db.exec('BEGIN IMMEDIATE');try{
   db.exec('DELETE FROM token_events; DELETE FROM counter_observations; DELETE FROM import_state; DELETE FROM sessions; DELETE FROM projects; DELETE FROM models;');
   for(const [file,data] of cache){
    if(data.events.length)throw new Error('A reset baseline cannot contain token events.');
    for(const observation of data.observations??[])insertObservation(inserts,observation,file);
    writeCheckpoint(checkpoint,file,{...DEFAULT_CHECKPOINT,...data});
   }
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 close(){this.db?.close();this.db=null;}
}

function nullableString(value:unknown):string|null{return typeof value==='string'?value:null;}
function optionalNumber(value:unknown):number|undefined{return typeof value==='number'?value:undefined;}
function toObservation(row:Record<string,unknown>,sourceFile:string):CounterObservation{return {id:String(row.id),key:String(row.observation_key),sourceFile,sessionId:String(row.session_id),parentSessionId:nullableString(row.parent_session_id)??undefined,timestamp:String(row.observed_at),input:Number(row.input_total),output:Number(row.output_total),cached:Number(row.cached_total),reasoning:Number(row.reasoning_total),lastInput:optionalNumber(row.last_input),lastOutput:optionalNumber(row.last_output),lastCached:optionalNumber(row.last_cached),lastReasoning:optionalNumber(row.last_reasoning),decision:String(row.decision) as CounterObservation['decision']};}
function insertObservation(statements:ReturnType<typeof preparedInserts>,item:CounterObservation,sourceFile:string):void{statements.observation.run(item.id,item.key,sourceFile,item.sessionId,item.parentSessionId??null,item.timestamp,item.input,item.output,item.cached,item.reasoning,item.lastInput??null,item.lastOutput??null,item.lastCached??null,item.lastReasoning??null,item.decision);}
function toEvent(row:Record<string,unknown>,sourceFile:string):UsageEvent{return {id:String(row.id),fingerprint:row.fingerprint===null?undefined:String(row.fingerprint),sourceFile,sessionId:String(row.session_id),timestamp:String(row.observed_at),model:row.model_id===null?undefined:String(row.model_id),project:row.project_id===null?undefined:String(row.project_id),inputTokens:Number(row.input_tokens),outputTokens:Number(row.output_tokens),cachedInputTokens:Number(row.cached_input_tokens),reasoningOutputTokens:Number(row.reasoning_output_tokens)};}
function preparedInserts(db:Db){return {project:db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES(?,?)'),model:db.prepare('INSERT OR IGNORE INTO models(id) VALUES(?)'),session:db.prepare('INSERT INTO sessions(id,project_id,model_id,started_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=COALESCE(excluded.project_id,sessions.project_id),model_id=COALESCE(excluded.model_id,sessions.model_id)'),event:db.prepare('INSERT OR IGNORE INTO token_events(id,fingerprint,source_file,session_id,observed_at,model_id,project_id,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),observation:db.prepare('INSERT OR IGNORE INTO counter_observations(id,observation_key,source_file,session_id,parent_session_id,observed_at,input_total,output_total,cached_total,reasoning_total,last_input,last_output,last_cached,last_reasoning,decision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')};}
function insertEvent(statements:ReturnType<typeof preparedInserts>,event:UsageEvent,sourceFile:string){if(event.project)statements.project.run(event.project,path.basename(event.project));if(event.model)statements.model.run(event.model);statements.session.run(event.sessionId,event.project||null,event.model||null,event.timestamp||null);statements.event.run(event.id,event.fingerprint||null,sourceFile,event.sessionId,event.timestamp,event.model||null,event.project||null,event.inputTokens,event.outputTokens,event.cachedInputTokens,event.reasoningOutputTokens);}
function writeCheckpoint(statement:ReturnType<Db['prepare']>,file:string,checkpoint:FileCheckpoint){statement.run(file,checkpoint.size,checkpoint.mtimeMs,checkpoint.offset,checkpoint.identity,checkpoint.generation,checkpoint.parserState,checkpoint.partial,checkpoint.parserVersion,checkpoint.lastReadAt);}
