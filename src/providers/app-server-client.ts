import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { InitializeParams } from '../protocol/generated/InitializeParams';

type JsonRecord = Record<string, unknown>;
interface PendingRequest { resolve(value:unknown):void; reject(reason:Error):void; timeout:NodeJS.Timeout; }
export interface RpcClientOptions { executable?:string; requestTimeoutMs?:number; }
const MAX_LINE = 2 * 1024 * 1024;

/** A private stdio subprocess. No HTTP listener, auth-file access or raw stderr logging. */
export class CodexAppServerClient extends EventEmitter {
 private child?:ChildProcessWithoutNullStreams;
 private buffer='';
 private requests=new Map<number,PendingRequest>();
 private nextId=1;
 private connecting?:Promise<void>;
 private ready=false;
 private disposed=false;
 constructor(private readonly options:RpcClientOptions={}) { super(); }
 get connected():boolean { return this.ready && !!this.child && this.child.exitCode===null; }
 async start():Promise<void> {
  if(this.disposed)throw new Error('Codex RPC client was disposed');
  if(this.connected)return;
  if(this.connecting)return this.connecting;
  this.connecting=this.initialize().finally(()=>{this.connecting=undefined;});
  return this.connecting;
 }
 private async initialize():Promise<void> {
  this.cleanup(new Error('Restarting App Server'));
  const child=spawn(this.options.executable || 'codex',['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  this.child=child;
  child.stdin.on('error',()=>{this.failAll(new Error('Codex App Server pipe closed'));this.ready=false;});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>this.onData(chunk));
  // Do not forward stderr: it may contain account data or configuration details.
  child.stderr.on('data',()=>{});
  child.on('error',error=>{this.failAll(new Error(`Unable to launch Codex App Server: ${error.message}`));this.ready=false;this.emit('disconnect');});
  child.on('exit',(code,signal)=>{this.failAll(new Error(`Codex App Server stopped (${String(code ?? signal)})`));this.ready=false;this.emit('disconnect');});
  const params:InitializeParams={clientInfo:{name:'codex-insights',title:'Codex Insights',version:'0.3.0'},capabilities:null};
  try {
   await this.requestInternal('initialize',params);
   this.notify('initialized',{});
   this.ready=true;
  } catch(error) {
   this.cleanup(error instanceof Error?error:new Error(String(error)));
   throw error;
  }
 }
 private onData(chunk:string):void {
  this.buffer+=chunk;
  if(this.buffer.length>MAX_LINE){this.cleanup(new Error('Codex RPC line exceeds safety limit'));return;}
  let index:number;
  while((index=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,index).trim();this.buffer=this.buffer.slice(index+1);
   if(!line)continue;
   let msg:JsonRecord;
   try{const parsed:unknown=JSON.parse(line);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))continue;msg=parsed as JsonRecord;}catch{continue;}
   if(typeof msg.id==='number' && ('result' in msg || 'error' in msg)){
    const req=this.requests.get(msg.id);if(!req)continue;
    this.requests.delete(msg.id);clearTimeout(req.timeout);
    if('error' in msg){const e=msg.error as JsonRecord|undefined;req.reject(new Error(typeof e?.message==='string'?e.message:'Codex RPC request failed'));}
    else req.resolve(msg.result);
   } else if(typeof msg.method==='string') {
    // Ignore server-initiated requests (not used by this read-only client).
    if(msg.id===undefined)this.emit('notification',msg.method,msg.params);
   }
  }
 }
 private requestInternal(method:string,params?:unknown):Promise<unknown> {
  if(!this.child || this.child.stdin.destroyed) return Promise.reject(new Error('Codex App Server is unavailable'));
  const id=this.nextId++;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.requests.delete(id);reject(new Error(`Codex RPC timeout: ${method}`));},this.options.requestTimeoutMs ?? 15000);
   this.requests.set(id,{resolve,reject,timeout});
   const packet=JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n';
   this.child!.stdin.write(packet,(err)=>{if(err){const req=this.requests.get(id);if(req){clearTimeout(req.timeout);this.requests.delete(id);reject(err);}}});
  });
 }
 async request<T>(method:string,params?:unknown):Promise<T> {await this.start();return this.requestInternal(method,params) as Promise<T>;}
 private notify(method:string,params?:unknown):void {this.child?.stdin.write(JSON.stringify({method,...(params===undefined?{}:{params})})+'\n');}
 private failAll(error:Error):void{for(const req of this.requests.values()){clearTimeout(req.timeout);req.reject(error);}this.requests.clear();}
 private cleanup(error:Error):void{this.ready=false;this.failAll(error);this.child?.removeAllListeners();this.child?.stdout.removeAllListeners();this.child?.stderr.removeAllListeners();this.child?.kill();this.child=undefined;this.buffer='';}
 dispose():void{this.disposed=true;this.cleanup(new Error('Codex App Server client disposed'));this.removeAllListeners();}
}
