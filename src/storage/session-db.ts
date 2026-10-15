import {mkdirSync} from 'node:fs';
import path from 'node:path';
import type {UsageEvent} from '../core/types';
export interface IndexedFile {size:number;mtimeMs:number;events:UsageEvent[]}
interface Db {exec(sql:string):void;prepare(sql:string):{run(...args:(string|number|null)[]):unknown;all(...args:(string|number|null)[]):unknown[]};close():void;}
export class SessionDatabase {
 private db:Db|null=null;
 constructor(private readonly directory:string){}
 get available(){return this.db!==null;}
 async open():Promise<boolean>{
  if(this.db)return true;
  try{const sqlite=await import('node:sqlite');mkdirSync(this.directory,{recursive:true,mode:0o700});const db=new sqlite.DatabaseSync(path.join(this.directory,'insights.sqlite')) as unknown as Db;
   db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT,model_id TEXT,started_at TEXT);
    CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY,fingerprint TEXT,source_file TEXT NOT NULL,session_id TEXT NOT NULL,observed_at TEXT NOT NULL,model_id TEXT,project_id TEXT,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,reasoning_output_tokens INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_token_events_source ON token_events(source_file);
    CREATE INDEX IF NOT EXISTS idx_token_events_time ON token_events(observed_at);
    CREATE TABLE IF NOT EXISTS import_state(source_file TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime_ms REAL NOT NULL);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,strftime('%s','now'));`);
   const cols=db.prepare('PRAGMA table_info(token_events)').all() as {name?:string}[];if(!cols.some(c=>c.name==='fingerprint'))db.exec('ALTER TABLE token_events ADD COLUMN fingerprint TEXT');
   db.exec("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,strftime('%s','now'))");
   this.db=db;return true;
  }catch{return false;}
 }
 read():Map<string,IndexedFile>{
  const result=new Map<string,IndexedFile>();if(!this.db)return result;
  for(const item of this.db.prepare('SELECT source_file,size,mtime_ms FROM import_state').all()){const r=item as Record<string,unknown>;result.set(String(r.source_file),{size:Number(r.size),mtimeMs:Number(r.mtime_ms),events:[]});}
  for(const item of this.db.prepare('SELECT * FROM token_events ORDER BY source_file,observed_at').all()){const r=item as Record<string,unknown>,file=String(r.source_file);const state=result.get(file);if(!state)continue;state.events.push({id:String(r.id),fingerprint:r.fingerprint===null?undefined:String(r.fingerprint),sourceFile:file,sessionId:String(r.session_id),timestamp:String(r.observed_at),model:r.model_id===null?undefined:String(r.model_id),project:r.project_id===null?undefined:String(r.project_id),inputTokens:Number(r.input_tokens),outputTokens:Number(r.output_tokens),cachedInputTokens:Number(r.cached_input_tokens),reasoningOutputTokens:Number(r.reasoning_output_tokens)});}
  return result;
 }
 sync(cache:Map<string,IndexedFile>):void{
  if(!this.db)return;const db=this.db;
  const indexed=new Map<string,{size:number;mtimeMs:number}>();for(const item of db.prepare('SELECT source_file,size,mtime_ms FROM import_state').all()){const r=item as Record<string,unknown>;indexed.set(String(r.source_file),{size:Number(r.size),mtimeMs:Number(r.mtime_ms)});}
  const remove=db.prepare('DELETE FROM token_events WHERE source_file=?'),deleteState=db.prepare('DELETE FROM import_state WHERE source_file=?');
  const state=db.prepare('INSERT INTO import_state(source_file,size,mtime_ms) VALUES(?,?,?) ON CONFLICT(source_file) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms');
  const project=db.prepare('INSERT OR IGNORE INTO projects(id,name) VALUES(?,?)'),model=db.prepare('INSERT OR IGNORE INTO models(id) VALUES(?)');
  const session=db.prepare('INSERT INTO sessions(id,project_id,model_id,started_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=COALESCE(excluded.project_id,sessions.project_id),model_id=COALESCE(excluded.model_id,sessions.model_id)');
  const event=db.prepare('INSERT INTO token_events(id,fingerprint,source_file,session_id,observed_at,model_id,project_id,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');try{
   for(const file of indexed.keys())if(!cache.has(file)){remove.run(file);deleteState.run(file);}
   for(const [file,data] of cache){const old=indexed.get(file);if(old&&old.size===data.size&&old.mtimeMs===data.mtimeMs)continue;remove.run(file);for(const e of data.events){if(e.project)project.run(e.project,path.basename(e.project));if(e.model)model.run(e.model);session.run(e.sessionId,e.project||null,e.model||null,e.timestamp||null);event.run(e.id,e.fingerprint||null,file,e.sessionId,e.timestamp,e.model||null,e.project||null,e.inputTokens,e.outputTokens,e.cachedInputTokens,e.reasoningOutputTokens);}state.run(file,data.size,data.mtimeMs);}
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 close(){this.db?.close();this.db=null;}
}
