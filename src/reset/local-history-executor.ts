import {createHash,randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,copyFile,mkdir,mkdtemp,open,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readJsonSnapshot,readSqliteSnapshot} from '../reconciliation/snapshot';
import {snapshotDigest} from '../reconciliation/historical';
import {maintenanceLockPath} from '../storage/maintenance';
import {SessionDatabase} from '../storage/session-db';
import {buildLocalHistoryResetPlan,buildResetBaselineFromSources,publicLocalHistoryResetSummary,validateLocalHistoryResetPlan,type LocalHistoryResetPlan} from './local-history-reset';

export const RESET_CONFIRMATION='RESET LOCAL TOKEN HISTORY';
export const RESTORE_CONFIRMATION='RESTORE CODEX INSIGHTS BACKUP AND DISCARD NEWER LOCAL STATISTICS';
type FileRecord={name:string;sha256:string;bytes:number};
export interface LocalResetBackupManifest{format:1;createdAt:string;storage:'sqlite'|'json';snapshotDigest:string;quotaDigest:string;files:FileRecord[]}
export interface LocalResetExecutionResult{applied:true;planId:string;backupDirectory:string;removed:ReturnType<typeof publicLocalHistoryResetSummary>;remainingEvents:0;baselineFiles:number;baselineObservations:number;quotaDigestPreserved:true}
export interface LocalResetExecutionOptions{plan:LocalHistoryResetPlan;storageDirectory:string;stateFile:string;sources:string;backupDirectory:string;confirmation:string;confirmedPlanId:string;assertWritersStopped:()=>Promise<void>;/** Test-only fault injection; the CLI never supplies it. */failureInjection?:(point:'after-storage'|'after-fallback')=>void}
export interface LocalResetRestoreOptions{storageDirectory:string;stateFile:string;backupDirectory:string;confirmation:string;assertWritersStopped:()=>Promise<void>}
export interface LocalResetPrepareOptions{storageDirectory:string;stateFile:string;sources:string;backupDirectory:string;planFile:string;storage:'sqlite'|'json';assertWritersStopped:()=>Promise<void>}

const hash=async(file:string)=>{const data=await readFile(file);return createHash('sha256').update(data).digest('hex');};
const jsonHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=(parent:string,child:string)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
async function quotaDigest(file:string):Promise<string>{
 if(!existsSync(file))return jsonHash([]);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA query_only=ON');const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quota_samples'").get();if(!table)return jsonHash([]);return jsonHash([...db.prepare('SELECT account_hash,observed_at,limit_id,window_kind,duration_mins,used_percent,reset_at FROM quota_samples ORDER BY id').iterate()]);}finally{db.close();}
}
async function verifySqlite(file:string):Promise<void>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});try{if((db.prepare('PRAGMA integrity_check').get() as {integrity_check?:string}).integrity_check!=='ok')throw new Error('SQLite backup integrity_check failed.');}finally{db.close();}}
async function copyPrivate(source:string,destination:string):Promise<void>{await copyFile(source,destination);await chmod(destination,0o600);}

export async function createVerifiedLocalResetBackup(storageDirectory:string,stateFile:string,backupDirectory:string,storage:'sqlite'|'json'):Promise<LocalResetBackupManifest>{
 const storagePath=path.resolve(storageDirectory),backupPath=path.resolve(backupDirectory);if(inside(storagePath,backupPath)||inside(backupPath,storagePath))throw new Error('Backup directory must be separate from extension storage.');
 await mkdir(backupPath,{mode:0o700});const files:FileRecord[]=[];const databaseFile=path.join(storagePath,'insights.sqlite');
 if(storage==='sqlite'){
  if(!existsSync(databaseFile))throw new Error('The reset plan requires SQLite but insights.sqlite is missing.');const {DatabaseSync,backup}=await import('node:sqlite');const source=new DatabaseSync(databaseFile,{readOnly:true});try{source.exec('PRAGMA query_only=ON');await backup(source,path.join(backupPath,'insights.sqlite'));}finally{source.close();}await chmod(path.join(backupPath,'insights.sqlite'),0o600);await verifySqlite(path.join(backupPath,'insights.sqlite'));
 }
 for(const [source,name] of [[stateFile,'sessions-index.json'],[path.join(storagePath,'quota-history.json'),'quota-history.json']] as const)if(existsSync(source))await copyPrivate(source,path.join(backupPath,name));
 for(const name of ['insights.sqlite','sessions-index.json','quota-history.json']){const file=path.join(backupPath,name);if(existsSync(file)){const info=await stat(file);files.push({name,sha256:await hash(file),bytes:info.size});}}
 const snapshot=storage==='sqlite'?await readSqliteSnapshot(path.join(backupPath,'insights.sqlite')):readJsonSnapshot(path.join(backupPath,'sessions-index.json'));
 const manifest:LocalResetBackupManifest={format:1,createdAt:new Date().toISOString(),storage,snapshotDigest:snapshotDigest(snapshot),quotaDigest:storage==='sqlite'?await quotaDigest(path.join(backupPath,'insights.sqlite')):existsSync(path.join(backupPath,'quota-history.json'))?await hash(path.join(backupPath,'quota-history.json')):jsonHash([]),files};
 await writeFile(path.join(backupPath,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});return manifest;
}

export async function verifyLocalResetBackup(backupDirectory:string):Promise<LocalResetBackupManifest>{
 const root=path.resolve(backupDirectory),manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8')) as LocalResetBackupManifest;if(manifest?.format!==1||!Array.isArray(manifest.files))throw new Error('Invalid reset backup manifest.');for(const item of manifest.files){const file=path.join(root,item.name),info=await stat(file);if(info.size!==item.bytes||await hash(file)!==item.sha256)throw new Error('Reset backup hash mismatch.');}if(manifest.storage==='sqlite')await verifySqlite(path.join(root,'insights.sqlite'));return manifest;
}

export async function restoreVerifiedLocalResetBackup(backupDirectory:string,storageDirectory:string,stateFile:string):Promise<void>{
 const manifest=await verifyLocalResetBackup(backupDirectory),databaseFile=path.join(storageDirectory,'insights.sqlite');
 await rm(databaseFile+'-wal',{force:true});await rm(databaseFile+'-shm',{force:true});
 if(manifest.storage==='sqlite')await copyPrivate(path.join(backupDirectory,'insights.sqlite'),databaseFile);else await rm(databaseFile,{force:true});
 for(const [name,destination] of [['sessions-index.json',stateFile],['quota-history.json',path.join(storageDirectory,'quota-history.json')]] as const){const source=path.join(backupDirectory,name);if(existsSync(source))await copyPrivate(source,destination);else await rm(destination,{force:true});}
 if(manifest.storage==='sqlite'){await verifySqlite(databaseFile);if(snapshotDigest(await readSqliteSnapshot(databaseFile))!==manifest.snapshotDigest)throw new Error('Restored SQLite snapshot does not match the backup manifest.');}
 else if(snapshotDigest(readJsonSnapshot(stateFile))!==manifest.snapshotDigest)throw new Error('Restored JSON snapshot does not match the backup manifest.');
}

export async function executeLocalHistoryRestore(options:LocalResetRestoreOptions):Promise<LocalResetBackupManifest>{
 if(options.confirmation!==RESTORE_CONFIRMATION)throw new Error('Exact restore confirmation is required.');await options.assertWritersStopped();const storage=path.resolve(options.storageDirectory),token=randomBytes(32).toString('hex'),lock=maintenanceLockPath(storage);await writeFile(lock,token,{flag:'wx',mode:0o600});try{await options.assertWritersStopped();const manifest=await verifyLocalResetBackup(options.backupDirectory);await restoreVerifiedLocalResetBackup(options.backupDirectory,storage,path.resolve(options.stateFile));return manifest;}finally{try{if((await readFile(lock,'utf8')).trim()===token)await rm(lock,{force:true});}catch{}}
}

export async function prepareLocalHistoryReset(options:LocalResetPrepareOptions):Promise<{planId:string;backupDirectory:string;planFile:string;summary:ReturnType<typeof publicLocalHistoryResetSummary>}>{
 await options.assertWritersStopped();const storage=path.resolve(options.storageDirectory),stateFile=path.resolve(options.stateFile),sources=path.resolve(options.sources),backupDirectory=path.resolve(options.backupDirectory),planFile=path.resolve(options.planFile);if(inside(storage,backupDirectory)||inside(sources,backupDirectory)||inside(storage,planFile))throw new Error('Backup and plan must be outside storage and session sources.');
 const token=randomBytes(32).toString('hex'),lock=maintenanceLockPath(storage);await writeFile(lock,token,{flag:'wx',mode:0o600});const work=await mkdtemp(path.join(os.tmpdir(),'codex-insights-reset-prepare-'));await chmod(work,0o700);
 try{await options.assertWritersStopped();const backup=await createVerifiedLocalResetBackup(storage,stateFile,backupDirectory,options.storage),snapshot=options.storage==='sqlite'?await readSqliteSnapshot(path.join(backupDirectory,'insights.sqlite')):readJsonSnapshot(path.join(backupDirectory,'sessions-index.json')),cutover=await buildResetBaselineFromSources(sources,path.join(work,'baseline.json')),plan=buildLocalHistoryResetPlan(snapshot,cutover.baseline);const current=options.storage==='sqlite'?await readSqliteSnapshot(path.join(storage,'insights.sqlite')):readJsonSnapshot(stateFile);if(backup.snapshotDigest!==snapshotDigest(current)||!validateLocalHistoryResetPlan(plan,current,cutover.baseline).valid)throw new Error('Storage or session sources changed while preparing the reset.');const handle=await open(planFile,'wx',0o600);try{await handle.writeFile(JSON.stringify(plan,null,2));await handle.sync();}finally{await handle.close();}return{planId:plan.planId,backupDirectory,planFile,summary:publicLocalHistoryResetSummary(plan)};}finally{try{if((await readFile(lock,'utf8')).trim()===token)await rm(lock,{force:true});}catch{}await rm(work,{recursive:true,force:true});}
}

export async function executeLocalHistoryReset(options:LocalResetExecutionOptions):Promise<LocalResetExecutionResult>{
 if(options.confirmation!==RESET_CONFIRMATION||options.confirmedPlanId!==options.plan.planId)throw new Error('Exact reset confirmation and plan ID are required.');
 const storageDirectory=path.resolve(options.storageDirectory),stateFile=path.resolve(options.stateFile),sources=path.resolve(options.sources),backupDirectory=path.resolve(options.backupDirectory);
 if(!inside(storageDirectory,stateFile)||inside(storageDirectory,backupDirectory)||inside(sources,backupDirectory))throw new Error('Unsafe storage, state, or backup path relationship.');
 await options.assertWritersStopped();const token=randomBytes(32).toString('hex'),lock=maintenanceLockPath(storageDirectory);await writeFile(lock,token,{flag:'wx',mode:0o600});
 const work=await mkdtemp(path.join(os.tmpdir(),'codex-insights-reset-execution-'));await chmod(work,0o700);
 try{
  await options.assertWritersStopped();
  const current=options.plan.storage==='sqlite'?await readSqliteSnapshot(path.join(storageDirectory,'insights.sqlite')):readJsonSnapshot(stateFile);
  let cutover=await buildResetBaselineFromSources(sources,path.join(work,'baseline-before.json'));
  let validation=validateLocalHistoryResetPlan(options.plan,current,cutover.baseline);if(!validation.valid)throw new Error(validation.reason);
  const backup=await verifyLocalResetBackup(backupDirectory);if(backup.snapshotDigest!==options.plan.snapshotDigest)throw new Error('Verified backup does not match the approved reset plan.');
  await options.assertWritersStopped();cutover=await buildResetBaselineFromSources(sources,path.join(work,'baseline-final.json'));validation=validateLocalHistoryResetPlan(options.plan,current,cutover.baseline);if(!validation.valid)throw new Error(validation.reason);
  const baseline=new Map(options.plan.baseline.entries),stage=stateFile+'.reset-stage-'+token,rollback=stateFile+'.reset-rollback-'+token;
  const serialized=JSON.stringify([...baseline].map(([file,entry])=>({file,...entry,events:[]})));const handle=await open(stage,'wx',0o600);try{await handle.writeFile(serialized);await handle.sync();}finally{await handle.close();}
  const quotaBefore=options.plan.storage==='sqlite'?await quotaDigest(path.join(storageDirectory,'insights.sqlite')):existsSync(path.join(storageDirectory,'quota-history.json'))?await hash(path.join(storageDirectory,'quota-history.json')):jsonHash([]);
  try{
   if(options.plan.storage==='sqlite'){const database=new SessionDatabase(storageDirectory,token);try{if(!await database.open())throw new Error('SQLite is unavailable.');database.replaceWithBaseline(baseline);}finally{database.close();}}options.failureInjection?.('after-storage');
   if(existsSync(stateFile))await rename(stateFile,rollback);await rename(stage,stateFile);
   options.failureInjection?.('after-fallback');
   const after=options.plan.storage==='sqlite'?await readSqliteSnapshot(path.join(storageDirectory,'insights.sqlite')):readJsonSnapshot(stateFile);if(after.events.length!==0)throw new Error('Reset verification found remaining token events.');
   const quotaAfter=options.plan.storage==='sqlite'?await quotaDigest(path.join(storageDirectory,'insights.sqlite')):existsSync(path.join(storageDirectory,'quota-history.json'))?await hash(path.join(storageDirectory,'quota-history.json')):jsonHash([]);if(quotaAfter!==quotaBefore||quotaAfter!==backup.quotaDigest)throw new Error('Quota history changed during reset.');
   const finalCutover=await buildResetBaselineFromSources(sources,path.join(work,'baseline-after.json'));if(!validateLocalHistoryResetPlan(options.plan,current,finalCutover.baseline).valid)throw new Error('Session sources changed during reset; restoring backup.');
   await rm(rollback,{force:true});return{applied:true,planId:options.plan.planId,backupDirectory,removed:publicLocalHistoryResetSummary(options.plan),remainingEvents:0,baselineFiles:options.plan.baseline.files,baselineObservations:options.plan.baseline.observations,quotaDigestPreserved:true};
  }catch(error){await restoreVerifiedLocalResetBackup(backupDirectory,storageDirectory,stateFile);await rm(rollback,{force:true});throw error;}finally{await rm(stage,{force:true});}
 }finally{try{if((await readFile(lock,'utf8')).trim()===token)await rm(lock,{force:true});}catch{}await rm(work,{recursive:true,force:true});}
}
