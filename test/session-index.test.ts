import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SessionIndex} from '../src/collectors/sessions';
import {aggregate} from '../src/analytics/aggregate';
const record=(n:number)=>JSON.stringify({timestamp:'2026-10-15T00:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}});
describe('persistent session index',()=>{
 it('recovers the canonical session after a legacy ctco checkpoint without changing old token amounts',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-legacy-identity-'));
  try{
   const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);
   const file=path.join(root,'synthetic.jsonl'),state=path.join(dir,'index.json');
   const meta=JSON.stringify({type:'session_meta',payload:{id:'conversation-1',session_id:'conversation-1'}})+'\n';
   const tool=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',id:'ctco_synthetic'}})+'\n';
   const old=meta+tool+record(100)+'\n';
   writeFileSync(file,old+record(150)+'\n');
   writeFileSync(state,JSON.stringify([{file,size:Buffer.byteLength(old),mtimeMs:1,offset:Buffer.byteLength(old),identity:null,generation:null,parserVersion:2,partial:'',lastReadAt:1,parserState:JSON.stringify({sessionId:'ctco_synthetic',lastTotals:{input:100,output:0,cached:0,reasoning:0},lastTimestamp:Date.parse('2026-10-15T00:00:00Z')}),events:[{id:'legacy-event',fingerprint:'legacy-fingerprint',sourceFile:file,sessionId:'ctco_synthetic',timestamp:'2026-10-15T00:00:00Z',inputTokens:100,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}]}]));
   const index=new SessionIndex(state);
   try{const first=await index.scan(root);expect(first.events).toHaveLength(2);expect(first.events.find(event=>event.id==='legacy-event')?.inputTokens).toBe(100);expect(first.events.find(event=>event.id!=='legacy-event')).toMatchObject({sessionId:'conversation-1',inputTokens:50});expect(aggregate(first.events).total.inputTokens).toBe(150);const second=await index.scan(root);expect(second.events).toHaveLength(2);}finally{index.close();}
   const reopened=new SessionIndex(state);
   try{const afterRestart=await reopened.scan(root);expect(afterRestart.events).toHaveLength(2);expect(aggregate(afterRestart.events).total.inputTokens).toBe(150);}finally{reopened.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('deduplicates unchanged files across scans and restarts, and handles truncation with a new canonical identity',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-index-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);const file=path.join(root,'session.jsonl'),state=path.join(dir,'state.json');writeFileSync(file,record(100)+'\n'+record(150)+'\n');let scan=await new SessionIndex(state).scan(root);expect(scan.events.map(e=>e.inputTokens)).toEqual([100,50]);scan=await new SessionIndex(state).scan(root);expect(scan.events).toHaveLength(2);writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'new-thread'}})+'\n'+record(20)+'\n');scan=await new SessionIndex(state).scan(root);expect(scan.events.map(e=>e.inputTokens)).toEqual([20,100,50]);expect(readFileSync(state,'utf8')).not.toContain('total_token_usage');expect(statSync(state).mode&0o077).toBe(0);}finally{rmSync(dir,{recursive:true,force:true});}});
});
describe('unavailable sessions directory',()=>{
 it('keeps previously indexed events when the root disappears',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-index-offline-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);writeFileSync(path.join(root,'session.jsonl'),record(10)+'\n');const index=new SessionIndex(path.join(dir,'index.json'));expect((await index.scan(root)).events).toHaveLength(1);await fs.rename(root,root+'-offline');const stale=await index.scan(root);expect(stale.events).toHaveLength(1);expect(stale.warnings[0]).toContain('unavailable');}finally{rmSync(dir,{recursive:true,force:true});}});
});
describe('SQLite session entities',()=>{
 it('persists normalized events and restores the index if JSON fallback is missing',async()=>{
  try{await import('node:sqlite');}catch{return;}
  const dir=mkdtempSync(path.join(tmpdir(),'codex-sqlite-index-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);const file=path.join(root,'session.jsonl'),state=path.join(dir,'sessions-index.json');writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'s1',cwd:'/projects/demo'}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'gpt-test'}})+'\n'+record(42)+'\n');const index=new SessionIndex(state);const first=await index.scan(root);expect(first.events[0]).toMatchObject({sessionId:'s1',model:'gpt-test',project:'/projects/demo',inputTokens:42});expect(index.storageMode).toContain('sqlite');index.close();
   const sqlite=await import('node:sqlite');const db=new sqlite.DatabaseSync(path.join(dir,'insights.sqlite'));try{expect(db.prepare('SELECT COUNT(*) AS n FROM token_events').get()).toMatchObject({n:1});expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toMatchObject({n:1});expect(db.prepare('SELECT COUNT(*) AS n FROM models').get()).toMatchObject({n:1});expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toMatchObject({n:1});expect(db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()).toMatchObject({version:2});expect(db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()).toMatchObject({version:5});}finally{db.close();}
   await fs.unlink(state);const restored=new SessionIndex(state);try{expect((await restored.scan(root)).events[0].inputTokens).toBe(42);}finally{restored.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
describe('historical session retention',()=>{
 it('retains observed events when a JSONL file is removed',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-retain-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);const file=path.join(root,'s.jsonl');writeFileSync(file,record(25)+'\n');const index=new SessionIndex(path.join(dir,'index.json'));expect((await index.scan(root)).events).toHaveLength(1);await fs.unlink(file);expect((await index.scan(root)).events).toHaveLength(1);index.close();}finally{rmSync(dir,{recursive:true,force:true});}});
});
describe('rotated file copies',()=>{
 it('counts and persists identical observations only once across filenames',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rotation-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);const content=JSON.stringify({type:'session_meta',payload:{id:'stable-session'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',id:'ctco_synthetic'}})+'\n'+record(90)+'\n';writeFileSync(path.join(root,'original.jsonl'),content);writeFileSync(path.join(root,'copy.jsonl'),content);const index=new SessionIndex(path.join(dir,'index.json'));try{const scan=await index.scan(root);expect(scan.events).toHaveLength(1);expect(scan.events.every(event=>event.sessionId==='stable-session')).toBe(true);expect(aggregate(scan.events).total.inputTokens).toBe(90);}finally{index.close();}let sqlite:typeof import('node:sqlite');try{sqlite=await import('node:sqlite');}catch{return;}const db=new sqlite.DatabaseSync(path.join(dir,'insights.sqlite'));try{expect(db.prepare('SELECT COUNT(*) AS n FROM token_events').get()).toMatchObject({n:1});expect(db.prepare('SELECT version FROM schema_migrations WHERE version=4').get()).toMatchObject({version:4});}finally{db.close();}}finally{rmSync(dir,{recursive:true,force:true});}});
});
describe('corrupt session fallback',()=>{
 it('preserves invalid JSON and continues from SQLite without overwriting it',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-session-corrupt-'));try{const root=path.join(dir,'sessions');const fs=await import('node:fs/promises');await fs.mkdir(root);const state=path.join(dir,'sessions-index.json');writeFileSync(state,'[invalid',{mode:0o600});writeFileSync(path.join(root,'s.jsonl'),record(10)+'\n');const index=new SessionIndex(state);try{const scan=await index.scan(root);expect(scan.events).toHaveLength(1);expect(scan.warnings.join(' ')).toContain('preserved');expect(readFileSync(state,'utf8')).toBe('[invalid');}finally{index.close();}}finally{rmSync(dir,{recursive:true,force:true});}});
});
