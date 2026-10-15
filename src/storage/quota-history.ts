import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import type {QuotaStatus} from '../providers/quotas';
export interface QuotaPoint {observedAt:number;usedPercent:number;windowDurationMins:number|null;limitId:string;windowKind:string;resetAt:number|null;}
interface Row extends QuotaPoint {accountHash:string;}
interface DatabaseLike {exec(sql:string):void;prepare(sql:string):{run(...args:(string|number|null)[]):unknown;all(...args:(string|number|null)[]):unknown[]};close():void;}
const RETENTION=90*86400;
export class QuotaHistoryStore {
 private db:DatabaseLike|null=null;private fallback:Row[]|null=null;
 private readonly filepath:string;
 constructor(private readonly storageDirectory:string){this.filepath=path.join(storageDirectory,'quota-history.json');}
 get mode(){return this.db?'sqlite':this.fallback?'json':'unavailable';}
 async open():Promise<boolean>{
  if(this.db||this.fallback)return true;
  mkdirSync(this.storageDirectory,{recursive:true,mode:0o700});
  try{const sqlite=await import('node:sqlite');const db=new sqlite.DatabaseSync(path.join(this.storageDirectory,'insights.sqlite')) as unknown as DatabaseLike;
   db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quota_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,account_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,limit_id TEXT NOT NULL,window_kind TEXT NOT NULL,duration_mins INTEGER,used_percent REAL NOT NULL CHECK(used_percent BETWEEN 0 AND 100),reset_at INTEGER,UNIQUE(account_hash,observed_at,limit_id,window_kind));
    CREATE INDEX IF NOT EXISTS idx_quota_history ON quota_samples(account_hash,observed_at);
    INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,strftime('%s','now'));`);
   // Import a prior JSON fallback when a newer VS Code runtime gains node:sqlite.
   if(existsSync(this.filepath)){
    try{const prior:unknown=JSON.parse(readFileSync(this.filepath,'utf8'));
     if(Array.isArray(prior)){const insert=db.prepare('INSERT OR IGNORE INTO quota_samples(account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at) VALUES(?,?,?,?,?,?,?)');
      for(const item of prior)if(isRow(item))insert.run(item.accountHash,item.observedAt,item.limitId,item.windowKind,item.windowDurationMins,item.usedPercent,item.resetAt);
     }
    }catch{/* Keep the original fallback file for recovery. */}
   }
   this.db=db;return true;
  }catch{/* Node runtime without node:sqlite */}
  try{const raw=existsSync(this.filepath)?JSON.parse(readFileSync(this.filepath,'utf8')) as unknown:[];this.fallback=Array.isArray(raw)?raw.filter(isRow):[];}catch{this.fallback=[];}
  return true;
 }
 static accountHash(accountId:string){return createHash('sha256').update(accountId).digest('hex');}
 save(accountId:string|null,status:QuotaStatus):void{
  if(!accountId||status.state!=='connected')return;
  const accountHash=QuotaHistoryStore.accountHash(accountId),now=Math.floor(Date.now()/60000)*60;
  const rows:Row[]=[];for(const bucket of status.buckets)for(const w of bucket.windows){const resetAt=w.resetAt?Math.floor(Date.parse(w.resetAt)/1000):null;rows.push({accountHash,observedAt:now,limitId:bucket.id,windowKind:w.kind,windowDurationMins:w.durationMinutes,usedPercent:w.usedPercent,resetAt:Number.isFinite(resetAt)?resetAt:null});}
  if(this.db){const insert=this.db.prepare('INSERT INTO quota_samples(account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_hash,observed_at,limit_id,window_kind) DO UPDATE SET used_percent=excluded.used_percent,reset_at=excluded.reset_at');for(const r of rows)insert.run(r.accountHash,r.observedAt,r.limitId,r.windowKind,r.windowDurationMins,r.usedPercent,r.resetAt);this.db.prepare('DELETE FROM quota_samples WHERE observed_at < ?').run(now-RETENTION);}
  else if(this.fallback){const merged=new Map<string,Row>();for(const r of this.fallback.concat(rows))if(r.observedAt>=now-RETENTION)merged.set(`${r.accountHash}:${r.observedAt}:${r.limitId}:${r.windowKind}`,r);this.fallback=[...merged.values()].sort((a,b)=>a.observedAt-b.observedAt);const temp=this.filepath+'.tmp';writeFileSync(temp,JSON.stringify(this.fallback),{encoding:'utf8',mode:0o600});renameSync(temp,this.filepath);}
 }
 read(accountId:string|null,limitId:string,duration:number,sinceHours=24):QuotaPoint[]{
  if(!accountId)return [];const hash=QuotaHistoryStore.accountHash(accountId),since=Math.floor(Date.now()/1000)-sinceHours*3600;
  let result:QuotaPoint[]=[];
  if(this.db)result=this.db.prepare('SELECT observed_at,used_percent,duration_mins,limit_id,window_kind,reset_at FROM quota_samples WHERE account_hash=? AND limit_id=? AND duration_mins=? AND observed_at>=? ORDER BY observed_at ASC LIMIT 30000').all(hash,limitId,duration,since).map(item=>{const r=item as Record<string,unknown>;return {observedAt:Number(r.observed_at),usedPercent:Number(r.used_percent),windowDurationMins:r.duration_mins===null?null:Number(r.duration_mins),limitId:String(r.limit_id),windowKind:String(r.window_kind),resetAt:r.reset_at===null?null:Number(r.reset_at)};});
  else if(this.fallback)result=this.fallback.filter(r=>r.accountHash===hash&&r.limitId===limitId&&r.windowDurationMins===duration&&r.observedAt>=since).map(({accountHash:_private,...point})=>point);
  return downsample(result,650);
 }
 close(){this.db?.close();this.db=null;this.fallback=null;}
}
function isRow(v:unknown):v is Row {if(!v||typeof v!=='object')return false;const x=v as Record<string,unknown>;return typeof x.accountHash==='string'&&typeof x.limitId==='string'&&typeof x.observedAt==='number'&&typeof x.usedPercent==='number'&&x.usedPercent>=0&&x.usedPercent<=100;}
function downsample(points:QuotaPoint[],limit:number){if(points.length<=limit)return points;const stride=Math.ceil(points.length/Math.max(1,limit-2));const keep=new Set([0,points.length-1]);for(let i=1;i<points.length;i++)if(points[i].resetAt!==points[i-1].resetAt||points[i].usedPercent+1<points[i-1].usedPercent){keep.add(i-1);keep.add(i);}for(let i=0;i<points.length;i+=stride)keep.add(i);return [...keep].sort((a,b)=>a-b).map(i=>points[i]);}
