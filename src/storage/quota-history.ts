import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import type {QuotaStatus} from '../providers/quotas';
import {assertStorageUnlocked} from './maintenance';
export interface QuotaPoint {observedAt:number;usedPercent:number;windowDurationMins:number|null;limitId:string;windowKind:string;resetAt:number|null;}
interface Row extends QuotaPoint {accountHash:string;}
interface DatabaseLike {exec(sql:string):void;prepare(sql:string):{run(...args:(string|number|null)[]):unknown;all(...args:(string|number|null)[]):unknown[]};close():void;}
const RETENTION=90*86400;
export class QuotaHistoryStore {
 private db:DatabaseLike|null=null;private fallback:Row[]|null=null;
 private _error:string|null=null;
 private readonly filepath:string;
 constructor(private readonly storageDirectory:string){this.filepath=path.join(storageDirectory,'quota-history.json');}
 get mode(){return this.db?'sqlite':this.fallback?'json':'unavailable';}
 get error(){return this._error;}
 async open():Promise<boolean>{
  if(this.db||this.fallback)return true;
  assertStorageUnlocked(this.storageDirectory);
  mkdirSync(this.storageDirectory,{recursive:true,mode:0o700});
  let sqlite:typeof import('node:sqlite')|null=null;
  try{sqlite=await import('node:sqlite');}catch(error){const code=(error as {code?:string}).code;if(code!=='ERR_UNKNOWN_BUILTIN_MODULE'&&code!=='ERR_MODULE_NOT_FOUND')throw error;}
  if(sqlite){let db:DatabaseLike|null=null;try{const sqlitePath=path.join(this.storageDirectory,'insights.sqlite');
   // A malformed sole JSON store must remain unavailable; never create an empty SQLite
   // database that would make an apparent recovery indistinguishable from lost history.
   if(!existsSync(sqlitePath)&&existsSync(this.filepath)){try{const prior:unknown=JSON.parse(readFileSync(this.filepath,'utf8'));if(!Array.isArray(prior))throw new Error('Invalid quota history format');}catch{this._error='The quota history JSON is invalid. The original file was preserved.';throw new Error(this._error);}}
   db=new sqlite.DatabaseSync(sqlitePath) as unknown as DatabaseLike;
   db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quota_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,account_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,limit_id TEXT NOT NULL,window_kind TEXT NOT NULL,duration_mins INTEGER,used_percent REAL NOT NULL CHECK(used_percent BETWEEN 0 AND 100),reset_at INTEGER,UNIQUE(account_hash,observed_at,limit_id,window_kind));
    CREATE INDEX IF NOT EXISTS idx_quota_history ON quota_samples(account_hash,observed_at);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,strftime('%s','now')); COMMIT;`);
   // Import a prior JSON fallback when a newer VS Code runtime gains node:sqlite.
   if(existsSync(this.filepath)){
    let prior:unknown;
    try{prior=JSON.parse(readFileSync(this.filepath,'utf8'));}catch{this._error='The quota history JSON is invalid. SQLite history remains available; the JSON file was preserved.';}
    if(prior!==undefined){
     if(!Array.isArray(prior))this._error='The quota history JSON is invalid. SQLite history remains available; the JSON file was preserved.';
     else{const insert=db.prepare('INSERT OR IGNORE INTO quota_samples(account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at) VALUES(?,?,?,?,?,?,?)');db.exec('BEGIN IMMEDIATE');
      try{for(const item of prior)if(isRow(item))insert.run(item.accountHash,item.observedAt,item.limitId,item.windowKind,item.windowDurationMins,item.usedPercent,item.resetAt);db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}}
    }
   }
   this.db=db;return true;
  }catch(error){try{db?.close();}catch{}if(this._error)throw error;this._error='The SQLite quota database could not be opened. The original file was preserved.';throw new Error(this._error);}}
  try{const raw=existsSync(this.filepath)?JSON.parse(readFileSync(this.filepath,'utf8')) as unknown:[];if(!Array.isArray(raw))throw new Error();this.fallback=raw.filter(isRow);this._error=null;}catch{this._error='The quota history JSON is invalid. The original file was preserved.';throw new Error(this._error);}
  return true;
 }
 static accountHash(accountId:string){return createHash('sha256').update(accountId).digest('hex');}
 save(accountId:string|null,status:QuotaStatus):void{
  if(!accountId||status.state!=='connected')return;
  assertStorageUnlocked(this.storageDirectory);
  const accountHash=QuotaHistoryStore.accountHash(accountId),now=Math.floor(Date.now()/60000)*60;
  const rows:Row[]=[];for(const bucket of status.buckets)for(const w of bucket.windows){const resetAt=w.resetAt?Math.floor(Date.parse(w.resetAt)/1000):null;rows.push({accountHash,observedAt:now,limitId:bucket.id,windowKind:w.kind,windowDurationMins:w.durationMinutes,usedPercent:w.usedPercent,resetAt:Number.isFinite(resetAt)?resetAt:null});}
  if(this.db){const insert=this.db.prepare('INSERT INTO quota_samples(account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_hash,observed_at,limit_id,window_kind) DO UPDATE SET used_percent=excluded.used_percent,reset_at=excluded.reset_at');this.db.exec('BEGIN IMMEDIATE');try{for(const r of rows)insert.run(r.accountHash,r.observedAt,r.limitId,r.windowKind,r.windowDurationMins,r.usedPercent,r.resetAt);this.db.prepare('DELETE FROM quota_samples WHERE observed_at < ?').run(now-RETENTION);this.db.exec('COMMIT');}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
  else if(this.fallback){const merged=new Map<string,Row>();for(const r of this.fallback.concat(rows))if(r.observedAt>=now-RETENTION)merged.set(`${r.accountHash}:${r.observedAt}:${r.limitId}:${r.windowKind}`,r);this.fallback=[...merged.values()].sort((a,b)=>a.observedAt-b.observedAt);const temp=this.filepath+'.tmp';writeFileSync(temp,JSON.stringify(this.fallback),{encoding:'utf8',mode:0o600});renameSync(temp,this.filepath);}
 }
 read(accountId:string|null,limitId:string,duration:number,sinceHours=24):QuotaPoint[]{
  if(!accountId)return [];const hash=QuotaHistoryStore.accountHash(accountId),since=Math.floor(Date.now()/1000)-sinceHours*3600;
  let result:QuotaPoint[]=[];
  if(this.db)result=this.db.prepare('SELECT observed_at,used_percent,duration_mins,limit_id,window_kind,reset_at FROM quota_samples WHERE account_hash=? AND limit_id=? AND duration_mins=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 30000').all(hash,limitId,duration,since).reverse().map(item=>{const r=item as Record<string,unknown>;return {observedAt:Number(r.observed_at),usedPercent:Number(r.used_percent),windowDurationMins:r.duration_mins===null?null:Number(r.duration_mins),limitId:String(r.limit_id),windowKind:String(r.window_kind),resetAt:r.reset_at===null?null:Number(r.reset_at)};});
  else if(this.fallback)result=this.fallback.filter(r=>r.accountHash===hash&&r.limitId===limitId&&r.windowDurationMins===duration&&r.observedAt>=since).map(({accountHash:_private,...point})=>point);
  return downsample(result,650);
 }
 close(){this.db?.close();this.db=null;this.fallback=null;}
}
function isRow(v:unknown):v is Row {if(!v||typeof v!=='object')return false;const x=v as Record<string,unknown>;return typeof x.accountHash==='string'&&typeof x.limitId==='string'&&typeof x.observedAt==='number'&&typeof x.usedPercent==='number'&&x.usedPercent>=0&&x.usedPercent<=100;}
function downsample(points:QuotaPoint[],limit:number){if(points.length<=limit)return points;const stride=Math.ceil(points.length/Math.max(1,limit-2));const keep=new Set([0,points.length-1]);for(let i=1;i<points.length;i++)if(points[i].resetAt!==points[i-1].resetAt||points[i].usedPercent+1<points[i-1].usedPercent){keep.add(i-1);keep.add(i);}for(let i=0;i<points.length;i+=stride)keep.add(i);return [...keep].sort((a,b)=>a-b).map(i=>points[i]);}
