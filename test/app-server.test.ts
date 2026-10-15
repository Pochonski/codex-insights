import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CodexAppServerClient} from '../src/providers/app-server-client';
import {CodexQuotaProvider} from '../src/providers/quotas';
const SERVER=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),started=path.join(__dirname,'started');fs.writeFileSync(started,String((Number(fs.existsSync(started)?fs.readFileSync(started,'utf8'):0)||0)+1));
const readline=require('node:readline');
const input=readline.createInterface({input:process.stdin});
input.on('line',(line)=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 let result;
 if(m.method==='initialize'){result={userAgent:'fixture',codexHome:'/tmp/fake',platformFamily:'unix',platformOs:'linux'};}
 else if(m.method==='account/read'){result={account:{type:'chatgpt',email:'dummy@example.com',planType:'plus'},requiresOpenaiAuth:true};}
 else if(m.method==='account/rateLimits/read'){result={ordinaryUsageAllowed:true,accountId:'test',rateLimits:{limitId:'codex',limitName:'Codex',normalModelSlug:null,primary:{usedPercent:50,windowDurationMins:300,resetsAt:1790000000},secondary:null,credits:null,individualLimit:null,spendControlReached:null,planType:'plus',rateLimitReachedType:null},rateLimitsByLimitId:null,rateLimitResetCredits:null,rateLimitUpsell:null};}
 else if(m.method==='account/login/start'){result={type:'chatgpt',loginId:'123',authUrl:'https://auth.openai.com/example'};}
 else return;
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`;
describe('Codex App Server stdio transport',()=>{
 it('initializes and reads quotas using the actual JSON-lines flow',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-insights-rpc-'));
  const fake=path.join(dir,'codex-mock');
  writeFileSync(fake,SERVER);chmodSync(fake,0o755);
  const client=new CodexAppServerClient({executable:fake,requestTimeoutMs:3000});
  try{
   const provider=new CodexQuotaProvider(client);
   const result=await provider.fetch();
   expect(result.status.state).toBe('connected');
   expect(result.status.buckets[0].windows[0].usedPercent).toBe(50);
   await Promise.all([provider.fetch(),provider.fetch()]);expect(readFileSync(path.join(dir,'started'),'utf8')).toBe('1');
   const login=await provider.beginChatGptLogin();expect(login.url).toContain('auth.openai.com');
  }finally{client.dispose();rmSync(dir,{recursive:true,force:true});}
 },10000);
});
