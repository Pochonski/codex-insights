import {describe,expect,it} from 'vitest';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {aggregate} from '../src/analytics/aggregate';
import {SessionIndex} from '../src/collectors/sessions';
import {summarizeHistoricalIntegrity} from '../src/reconciliation/dashboard-summary';
import {readJsonSnapshot,readSqliteSnapshot} from '../src/reconciliation/snapshot';
import {buildLocalHistoryResetPlan} from '../src/reset/local-history-reset';
import {executeLocalHistoryReset,executeLocalHistoryRestore,prepareLocalHistoryReset,RESET_CONFIRMATION,RESTORE_CONFIRMATION,restoreVerifiedLocalResetBackup,verifyLocalResetBackup} from '../src/reset/local-history-executor';
import {maintenanceLockPath} from '../src/storage/maintenance';
import {SessionDatabase} from '../src/storage/session-db';
import {QuotaHistoryStore} from '../src/storage/quota-history';

const meta=(id:string,parent?:string)=>JSON.stringify({type:'session_meta',payload:{id,...(parent?{forked_from_id:parent}:{})}});
const usage=(input:number,at:string,cached=0,last?:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:Math.floor(input/10),reasoning_output_tokens:Math.floor(input/100)},...(last===undefined?{}:{last_token_usage:{input_tokens:last,cached_input_tokens:Math.min(cached,last),output_tokens:Math.floor(last/10),reasoning_output_tokens:Math.floor(last/100)}})}}});
const lines=(...items:string[])=>items.join('\n')+'\n';
function env(){const root=mkdtempSync(path.join(tmpdir(),'codex-reset-executor-')),storage=path.join(root,'storage'),sessions=path.join(root,'sessions');mkdirSync(storage);mkdirSync(sessions);return{root,storage,sessions,state:path.join(storage,'sessions-index.json'),db:path.join(storage,'insights.sqlite'),backup:(name:string)=>path.join(root,name),file:(name:string)=>path.join(sessions,name+'.jsonl')}}
class UnavailableDatabase extends SessionDatabase{override async open(){return false;}}
const sqliteIt=(()=>{try{require('node:sqlite');return it;}catch{return it.skip;}})();
async function prepareFor(f:ReturnType<typeof env>,storage:'sqlite'|'json',name:string){const backup=f.backup(name),planFile=path.join(f.root,name+'.plan.json');await prepareLocalHistoryReset({storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,planFile,storage,assertWritersStopped:async()=>{}});return{backup,plan:JSON.parse(readFileSync(planFile,'utf8')) as ReturnType<typeof buildLocalHistoryResetPlan>};}
function insertQuota(file:string){const {DatabaseSync}=require('node:sqlite') as typeof import('node:sqlite');const db=new DatabaseSync(file);try{db.exec("CREATE TABLE IF NOT EXISTS quota_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,account_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,limit_id TEXT NOT NULL,window_kind TEXT NOT NULL,duration_mins INTEGER,used_percent REAL NOT NULL,reset_at INTEGER); INSERT INTO quota_samples(account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at) VALUES('private-hash',1,'codex','primary',300,42,99)");}finally{db.close();}}

describe('explicit local token reset executor',()=>{
 sqliteIt('backs up, resets SQLite, preserves quotas, prevents reimport, and restores completely',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z',80),usage(150,'2026-01-01T00:01:00Z',120)));let index=new SessionIndex(f.state);await index.scan(f.sessions);index.close();insertQuota(f.db);const {plan,backup}=await prepareFor(f,'sqlite','backup');let writerChecks=0;
  const result=await executeLocalHistoryReset({plan,storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,confirmation:RESET_CONFIRMATION,confirmedPlanId:plan.planId,assertWritersStopped:async()=>{writerChecks++;}});
  expect(result).toMatchObject({applied:true,remainingEvents:0,quotaDigestPreserved:true});expect(writerChecks).toBeGreaterThanOrEqual(2);expect((await verifyLocalResetBackup(backup)).snapshotDigest).toBe(plan.snapshotDigest);expect((await readSqliteSnapshot(f.db)).events).toHaveLength(0);expect(readJsonSnapshot(f.state).events).toHaveLength(0);expect(existsSync(maintenanceLockPath(f.storage))).toBe(false);
  index=new SessionIndex(f.state);let scan=await index.scan(f.sessions);expect(scan.events).toHaveLength(0);expect((await index.scan(f.sessions)).events).toHaveLength(0);const audit=index.historicalAuditInput();expect(summarizeHistoricalIntegrity(audit.snapshot,audit.evidence).eventsAnalyzed).toBe(0);index.close();
  appendFileSync(f.file('base'),usage(170,'2026-01-01T00:02:00Z',138)+'\n');index=new SessionIndex(f.state);scan=await index.scan(f.sessions);expect(aggregate(scan.events).total).toMatchObject({inputTokens:20,cachedInputTokens:18,outputTokens:2});index.close();
  await executeLocalHistoryRestore({backupDirectory:backup,storageDirectory:f.storage,stateFile:f.state,confirmation:RESTORE_CONFIRMATION,assertWritersStopped:async()=>{}});expect((await readSqliteSnapshot(f.db)).events).toHaveLength(2);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.db,{readOnly:true});try{expect(db.prepare('SELECT used_percent FROM quota_samples').get()).toMatchObject({used_percent:42});}finally{db.close();}
 }finally{rmSync(f.root,{recursive:true,force:true});}});

 it('applies equivalent cutover and restoration to the JSON fallback',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z',80)));let index=new SessionIndex(f.state,new UnavailableDatabase(f.storage));await index.scan(f.sessions);index.close();const original=readFileSync(f.state,'utf8'),{plan,backup}=await prepareFor(f,'json','backup-json');
  await executeLocalHistoryReset({plan,storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,confirmation:RESET_CONFIRMATION,confirmedPlanId:plan.planId,assertWritersStopped:async()=>{}});expect(readJsonSnapshot(f.state).events).toHaveLength(0);expect(existsSync(f.db)).toBe(false);
  index=new SessionIndex(f.state,new UnavailableDatabase(f.storage));expect((await index.scan(f.sessions)).events).toHaveLength(0);appendFileSync(f.file('base'),usage(125,'2026-01-01T00:01:00Z',100)+'\n');expect(aggregate((await index.scan(f.sessions)).events).total.inputTokens).toBe(25);index.close();await restoreVerifiedLocalResetBackup(backup,f.storage,f.state);expect(readFileSync(f.state,'utf8')).toBe(original);
 }finally{rmSync(f.root,{recursive:true,force:true});}});

 sqliteIt('does not reimport discarded totals after rewrite, truncation, or rotation',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z'),usage(150,'2026-01-01T00:01:00Z')));let index=new SessionIndex(f.state);await index.scan(f.sessions);index.close();const {plan,backup}=await prepareFor(f,'sqlite','rotation-backup');await executeLocalHistoryReset({plan,storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,confirmation:RESET_CONFIRMATION,confirmedPlanId:plan.planId,assertWritersStopped:async()=>{}});
  writeFileSync(f.file('base'),lines(meta('thread'),JSON.stringify({type:'response_item',payload:{id:'ctco_rewritten'}}),usage(100,'2026-01-01T00:02:00Z'),usage(150,'2026-01-01T00:03:00Z'),usage(170,'2026-01-01T00:04:00Z')));index=new SessionIndex(f.state);expect(aggregate((await index.scan(f.sessions)).events).total.inputTokens).toBe(20);index.close();
  renameSync(f.file('base'),f.file('rotated'));writeFileSync(f.file('base'),lines(meta('thread'),usage(170,'2026-01-01T00:05:00Z'),usage(190,'2026-01-01T00:06:00Z')));index=new SessionIndex(f.state);expect(aggregate((await index.scan(f.sessions)).events).total.inputTokens).toBe(40);expect(aggregate((await index.scan(f.sessions)).events).total.inputTokens).toBe(40);index.close();
 }finally{rmSync(f.root,{recursive:true,force:true});}});

 sqliteIt('restores the verified backup after a failure between SQLite and fallback commit',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z')));const index=new SessionIndex(f.state);await index.scan(f.sessions);index.close();const before=await readSqliteSnapshot(f.db),fallback=readFileSync(f.state,'utf8'),{plan,backup}=await prepareFor(f,'sqlite','rollback-backup');
  await expect(executeLocalHistoryReset({plan,storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,confirmation:RESET_CONFIRMATION,confirmedPlanId:plan.planId,assertWritersStopped:async()=>{},failureInjection:point=>{if(point==='after-storage')throw new Error('synthetic interruption');}})).rejects.toThrow('synthetic interruption');expect((await readSqliteSnapshot(f.db)).events).toEqual(before.events);expect(readFileSync(f.state,'utf8')).toBe(fallback);expect(existsSync(maintenanceLockPath(f.storage))).toBe(false);
 }finally{rmSync(f.root,{recursive:true,force:true});}});

 sqliteIt('rejects stale plans, missing confirmation, active writers, and leaves storage unchanged',async()=>{const f=env();try{
  writeFileSync(f.file('base'),lines(meta('thread'),usage(100,'2026-01-01T00:00:00Z')));const index=new SessionIndex(f.state);await index.scan(f.sessions);index.close();const {plan,backup}=await prepareFor(f,'sqlite','guard-backup'),before=await readSqliteSnapshot(f.db);
  const args={plan,storageDirectory:f.storage,stateFile:f.state,sources:f.sessions,backupDirectory:backup,confirmation:RESET_CONFIRMATION,confirmedPlanId:plan.planId,assertWritersStopped:async()=>{}};
  await expect(executeLocalHistoryReset({...args,confirmation:'yes'})).rejects.toThrow('confirmation');await expect(executeLocalHistoryReset({...args,assertWritersStopped:async()=>{throw new Error('writer active');}})).rejects.toThrow('writer active');appendFileSync(f.file('base'),usage(120,'2026-01-01T00:01:00Z')+'\n');await expect(executeLocalHistoryReset(args)).rejects.toThrow(/changed|differ|snapshot/i);expect((await readSqliteSnapshot(f.db)).events).toEqual(before.events);
 }finally{rmSync(f.root,{recursive:true,force:true});}});

 it('blocks normal session and quota writers while a maintenance lock exists',async()=>{const f=env();try{
  writeFileSync(maintenanceLockPath(f.storage),'maintenance-token',{mode:0o600});writeFileSync(f.file('base'),lines(meta('thread'),usage(10,'2026-01-01T00:00:00Z')));const index=new SessionIndex(f.state);const scan=await index.scan(f.sessions);expect(scan.events).toHaveLength(0);expect(scan.warnings.join(' ')).toContain('locked');index.close();const quota=new QuotaHistoryStore(f.storage);await expect(quota.open()).rejects.toThrow('locked');quota.close();
 }finally{rmSync(f.root,{recursive:true,force:true});}});
});
