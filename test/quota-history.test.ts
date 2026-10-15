import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {QuotaHistoryStore} from '../src/storage/quota-history';
import type {QuotaStatus} from '../src/providers/quotas';
const status:QuotaStatus={state:'connected',plan:'plus',fetchedAt:new Date().toISOString(),message:null,ordinaryUsageAllowed:true,buckets:[{id:'codex',name:'Codex',model:null,windows:[{kind:'primary',durationMinutes:300,usedPercent:35,resetAt:null}]}]};
describe('quota SQLite history',()=>{
 it('records, retrieves and deduplicates by minute without storing raw account IDs',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-quota-history-'));
  const store=new QuotaHistoryStore(dir);
  try{
   if(!await store.open())return; // older Node extension hosts may lack node:sqlite
   store.save('test-account',status);store.save('test-account',status);
   const points=store.read('test-account','codex',300);
   expect(points).toHaveLength(1);expect(points[0].usedPercent).toBe(35);
   expect(store.read('different-account','codex',300)).toHaveLength(0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
describe('quota history migration',()=>{
 it('imports an existing JSON fallback into SQLite without losing reset timestamps',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-quota-import-'));
  const {writeFileSync}=await import('node:fs');
  const observedAt=Math.floor(Date.now()/60000)*60-60;
  writeFileSync(path.join(dir,'quota-history.json'),JSON.stringify([{accountHash:QuotaHistoryStore.accountHash('old-account'),observedAt,limitId:'codex',windowKind:'primary',windowDurationMins:300,usedPercent:73,resetAt:observedAt+300}]),{mode:0o600});
  const store=new QuotaHistoryStore(dir);
  try{expect(await store.open()).toBe(true);const points=store.read('old-account','codex',300);expect(points).toMatchObject([{usedPercent:73,resetAt:observedAt+300}]);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
describe('shared database migrations',()=>{
 it('adds session schema without replacing existing quota samples',async()=>{try{await import('node:sqlite');}catch{return;}const dir=mkdtempSync(path.join(tmpdir(),'codex-schema-upgrade-'));const quota=new QuotaHistoryStore(dir);try{await quota.open();quota.save('account',status);quota.close();const {SessionDatabase}=await import('../src/storage/session-db');const sessionDb=new SessionDatabase(dir);expect(await sessionDb.open()).toBe(true);sessionDb.close();const reopened=new QuotaHistoryStore(dir);try{await reopened.open();expect(reopened.read('account','codex',300)).toHaveLength(1);}finally{reopened.close();}}finally{quota.close();rmSync(dir,{recursive:true,force:true});}});
});
describe('storage recovery safety',()=>{
 it('does not overwrite an invalid JSON fallback',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-quota-corrupt-json-'));const {writeFileSync}=await import('node:fs');const file=path.join(dir,'quota-history.json');writeFileSync(file,'{"incomplete"',{mode:0o600});const store=new QuotaHistoryStore(dir);try{await expect(store.open()).rejects.toThrow('preserved');expect(readFileSync(file,'utf8')).toBe('{"incomplete"');expect(()=>store.save('account',status)).not.toThrow();expect(readFileSync(file,'utf8')).toBe('{"incomplete"');}finally{store.close();rmSync(dir,{recursive:true,force:true});}});
 it('keeps an invalid SQLite file intact and reports a recoverable error',async()=>{try{await import('node:sqlite');}catch{return;}const dir=mkdtempSync(path.join(tmpdir(),'codex-quota-corrupt-db-'));const {writeFileSync}=await import('node:fs');const file=path.join(dir,'insights.sqlite');writeFileSync(file,'not-a-sqlite-database',{mode:0o600});const before=readFileSync(file);const store=new QuotaHistoryStore(dir);try{await expect(store.open()).rejects.toThrow('preserved');expect(readFileSync(file)).toEqual(before);}finally{store.close();rmSync(dir,{recursive:true,force:true});}});
 it('can apply the same migrations repeatedly',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-quota-idempotent-'));try{for(let i=0;i<2;i++){const store=new QuotaHistoryStore(dir);expect(await store.open()).toBe(true);store.close();}}finally{rmSync(dir,{recursive:true,force:true});}});
});
