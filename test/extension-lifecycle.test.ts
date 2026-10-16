import {describe,it,expect} from 'vitest';
import {buildSync} from 'esbuild';
import vm from 'node:vm';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
describe('Extension Host lifecycle (simulated VS Code)',()=>{
 it('registers dashboard, exchanges a snapshot, and releases resources',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-host-'));const sessions=path.join(dir,'sessions');const {mkdirSync}=await import('node:fs');mkdirSync(sessions);
  const commands=new Map<string,()=>void>();const posted:unknown[]=[];let receive:(m:unknown)=>void=()=>{};let statusDisposed=false,panelDisposed=false,clearedTimers=0;
  const uri=(p:string)=>({path:p,fsPath:p,with:({path:q}:{path:string})=>uri(q),toString:()=>`file://${p}`});
  const panel={webview:{cspSource:'vscode-resource:',asWebviewUri:(u:unknown)=>u,onDidReceiveMessage:(fn:(m:unknown)=>void)=>{receive=fn;return {dispose(){}};},postMessage:(m:unknown)=>{posted.push(m);return Promise.resolve(true);},html:''},reveal(){},onDidDispose:()=>({dispose(){}}),dispose(){panelDisposed=true;}};
  const vscode={StatusBarAlignment:{Right:2},ViewColumn:{One:1},MarkdownString:class{value:string;isTrusted:unknown;constructor(value:string){this.value=value;}},ThemeColor:class{constructor(public id:string){}},Uri:{joinPath:(u:{path:string},name:string)=>uri(path.join(u.path,name)),parse:(value:string)=>value},window:{createStatusBarItem:()=>({show(){},dispose(){statusDisposed=true;},text:'',tooltip:'',command:''}),createWebviewPanel:()=>panel,showWarningMessage(){},showErrorMessage(){}},workspace:{getConfiguration:()=>({get:(key:string,defaultValue:unknown)=>({sessionsPath:sessions,codexExecutable:'/does/not/exist/codex'} as Record<string,unknown>)[key]??defaultValue}),onDidChangeConfiguration:()=>({dispose(){}})},commands:{registerCommand:(name:string,fn:()=>void)=>{commands.set(name,fn);return {dispose(){commands.delete(name);}};}},env:{openExternal:async()=>true,clipboard:{writeText:async()=>{}}}};
  const code=buildSync({entryPoints:['src/extension/index.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],write:false}).outputFiles[0].text;
  const module={exports:{} as Record<string,(...args:unknown[])=>void>};const sandbox={module,exports:module.exports,require:(name:string)=>name==='vscode'?vscode:require(name),process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval:(timer:NodeJS.Timeout)=>{clearedTimers++;clearInterval(timer);},URL,console};
  try{vm.runInNewContext(code,sandbox,{filename:'extension.js'});module.exports.activate({subscriptions:[],globalStorageUri:uri(dir),extensionUri:uri(dir)});expect(commands.has('codexInsights.openDashboard')).toBe(true);expect(commands.has('codexInsights.copySummary')).toBe(true);commands.get('codexInsights.openDashboard')?.();expect(panel.webview.html).toContain("default-src 'none'");receive({command:'ready',filters:{period:'all'}});await wait(60);expect(posted.some(m=>(m as {type?:string}).type==='snapshot')).toBe(true);await module.exports.deactivate();expect(statusDisposed).toBe(true);expect(panelDisposed).toBe(true);expect(clearedTimers).toBeGreaterThanOrEqual(3);}finally{module.exports.deactivate?.();rmSync(dir,{recursive:true,force:true});}
 },5000);
});
