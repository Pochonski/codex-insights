import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CodexAppServerClient} from '../src/providers/app-server-client';
const fixture=`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
 else if(m.method==='fail')process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'failure'}})+'\\n');
 else if(m.method==='account/read')process.stdout.write(JSON.stringify({id:m.id,result:{account:null}})+'\\n');
 else if(m.method==='healthy')process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');
 else if(m.method==='invalid')process.stdout.write('{invalid json\\n');
 else if(m.method==='hang'){}
 else if(m.method==='idleExit'){process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');setTimeout(()=>process.exit(0),10);}
 else if(m.method==='quit')process.exit(0);
});`;
describe('RPC failures and recovery',()=>{
 it('rejects server errors and reconnects after subprocess exit',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-errors-'));const file=path.join(dir,'codex');writeFileSync(file,fixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:1000});try{await expect(rpc.request('fail')).rejects.toThrow('failure');await expect(rpc.request('quit')).rejects.toThrow();await new Promise(r=>setTimeout(r,30));expect(rpc.connected).toBe(false);expect(await rpc.request('account/read')).toMatchObject({account:null});}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},5000);
 it('reports missing executable without hanging',async()=>{const rpc=new CodexAppServerClient({executable:'/does/not/exist/codex',requestTimeoutMs:500});try{await expect(rpc.start()).rejects.toThrow();}finally{rpc.dispose();}},3000);
 it('terminates a hung process after timeout and starts a clean process for the next request',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-timeout-'));const file=path.join(dir,'codex');writeFileSync(file,fixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:80,maxRetries:0});try{await expect(rpc.request('hang')).rejects.toThrow('timeout');expect(rpc.connected).toBe(false);await expect(rpc.request<{ok:boolean}>('healthy')).resolves.toEqual({ok:true});}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},3000);
 it('rejects invalid JSON and pending requests when disposed',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-protocol-'));const file=path.join(dir,'codex');writeFileSync(file,fixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:1000,maxRetries:0});try{await expect(rpc.request('invalid')).rejects.toThrow('invalid JSON');const pending=rpc.request('hang');await new Promise(resolve=>setTimeout(resolve,20));rpc.dispose();await expect(pending).rejects.toThrow('disposed');}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},3000);
 it('detects an idle process exit and reconnects on demand',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-idle-'));const file=path.join(dir,'codex');writeFileSync(file,fixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:500,maxRetries:0});try{await expect(rpc.request('idleExit')).resolves.toEqual({ok:true});await new Promise(resolve=>setTimeout(resolve,40));expect(rpc.connected).toBe(false);await expect(rpc.request('healthy')).resolves.toEqual({ok:true});}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},3000);
 it('retries an idempotent read after the subprocess dies',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-retry-'));const file=path.join(dir,'codex');const retryFixture=`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),counter=path.join(__dirname,'starts');let starts=0;try{starts=Number(fs.readFileSync(counter,'utf8'))||0}catch{}starts++;fs.writeFileSync(counter,String(starts));const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');else if(m.method==='account/read'){if(starts===1)process.exit(1);else process.stdout.write(JSON.stringify({id:m.id,result:{account:null}})+'\\n');}});`;writeFileSync(file,retryFixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:500,maxRetries:1,retryBaseMs:1,jitter:0});try{await expect(rpc.request('account/read')).resolves.toMatchObject({account:null});}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},3000);
});
