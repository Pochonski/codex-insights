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
 else if(m.method==='quit')process.exit(0);
});`;
describe('RPC failures and recovery',()=>{
 it('rejects server errors and reconnects after subprocess exit',async()=>{const dir=mkdtempSync(path.join(tmpdir(),'codex-rpc-errors-'));const file=path.join(dir,'codex');writeFileSync(file,fixture);chmodSync(file,0o755);const rpc=new CodexAppServerClient({executable:file,requestTimeoutMs:1000});try{await expect(rpc.request('fail')).rejects.toThrow('failure');await expect(rpc.request('quit')).rejects.toThrow();await new Promise(r=>setTimeout(r,30));expect(rpc.connected).toBe(false);expect(await rpc.request('account/read')).toMatchObject({account:null});}finally{rpc.dispose();rmSync(dir,{recursive:true,force:true});}},5000);
 it('reports missing executable without hanging',async()=>{const rpc=new CodexAppServerClient({executable:'/does/not/exist/codex',requestTimeoutMs:500});try{await expect(rpc.start()).rejects.toThrow();}finally{rpc.dispose();}},3000);
});
