import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import type {InitializeParams} from '../protocol/generated/InitializeParams';

type JsonRecord=Record<string,unknown>;
export type ConnectionState='offline'|'connecting'|'connected'|'reconnecting'|'incompatible'|'error';
interface PendingRequest {resolve(value:unknown):void;reject(reason:Error):void;timeout:NodeJS.Timeout;}
export interface RpcClientOptions {executable?:string;requestTimeoutMs?:number;maxRetries?:number;retryBaseMs?:number;retryMaxMs?:number;jitter?:number;}
const MAX_LINE=2*1024*1024;
const SAFE_METHODS=new Set(['account/read','account/rateLimits/read']);
class RpcResponseError extends Error {}

/** A private stdio subprocess. No HTTP listener, auth-file access or raw stderr logging. */
export class CodexAppServerClient extends EventEmitter {
 private child?:ChildProcessWithoutNullStreams;
 private buffer='';
 private requests=new Map<number,PendingRequest>();
 private nextId=1;
 private connecting?:Promise<void>;
 private ready=false;
 private disposed=false;
 private retryTimer?:NodeJS.Timeout;
 private retryReject?:(error:Error)=>void;
 private retryWait?:Promise<void>;
 private _state:ConnectionState='offline';
 constructor(private readonly options:RpcClientOptions={}){super();}
 get connected():boolean{return this.ready&&!!this.child&&this.child.exitCode===null;}
 get state():ConnectionState{return this._state;}
 private setState(state:ConnectionState):void{if(this._state===state)return;this._state=state;this.emit('state',state);}
 async start():Promise<void>{
  if(this.disposed)throw new Error('Codex RPC client was disposed');
  if(this.connected)return;
  if(this.connecting)return this.connecting;
  this.setState(this._state==='offline'?'connecting':'reconnecting');
  this.connecting=this.initialize().finally(()=>{this.connecting=undefined;});
  return this.connecting;
 }
 private async initialize():Promise<void>{
  this.stopChild(new Error('Restarting Codex App Server'),false);
  const executable=(this.options.executable||'codex').trim();
  if(!executable||executable.includes('\0')){this.setState('error');throw new Error('Invalid Codex executable path');}
  const child=spawn(executable,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  this.child=child;
  child.stdin.on('error',()=>this.handleTransportFailure(child,new Error('Codex App Server pipe closed')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{if(child===this.child)this.onData(chunk);});
  // Deliberately drain without logging: stderr can contain account or configuration data.
  child.stderr.on('data',()=>{});
  child.on('error',error=>this.handleTransportFailure(child,new Error(`Unable to launch Codex App Server: ${error.message}`)));
  child.on('exit',(code,signal)=>this.handleTransportFailure(child,new Error(`Codex App Server stopped (${String(code??signal)})`)));
  const params:InitializeParams={clientInfo:{name:'codex-insights',title:'Codex Insights',version:'0.3.1'},capabilities:null};
  try{
   await this.requestInternal('initialize',params);
   this.notify('initialized',{});
   this.ready=true;this.setState('connected');
  }catch(error){
   const failure=error instanceof Error?error:new Error(String(error));
   if(failure instanceof RpcResponseError&&/method not found|unsupported|incompatible/i.test(failure.message))this.setState('incompatible');else this.setState('offline');
   this.stopChild(failure,false);throw failure;
  }
 }
 private handleTransportFailure(child:ChildProcessWithoutNullStreams,error:Error):void{
  if(child!==this.child)return;
  this.stopChild(error,false);if(!this.disposed)this.setState('offline');this.emit('disconnect',error);
 }
 private onData(chunk:string):void{
  this.buffer+=chunk;let index:number;
  while((index=this.buffer.indexOf('\n'))>=0){
   const raw=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
   if(raw.length>MAX_LINE){this.protocolFailure(new Error('Codex RPC line exceeds safety limit'));return;}
   const line=raw.trim();if(!line)continue;let msg:JsonRecord;
   try{const parsed:unknown=JSON.parse(line);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();msg=parsed as JsonRecord;}
   catch{this.protocolFailure(new Error('Codex App Server returned invalid JSON'));return;}
   if(typeof msg.id==='number'&&('result'in msg||'error'in msg)){
    const request=this.requests.get(msg.id);if(!request)continue;this.requests.delete(msg.id);clearTimeout(request.timeout);
    if('error'in msg){const value=msg.error as JsonRecord|undefined;const message=typeof value?.message==='string'?value.message.replace(/[\r\n]+/g,' ').slice(0,300):'Codex RPC request failed';request.reject(new RpcResponseError(message));}else request.resolve(msg.result);
   }else if(typeof msg.method==='string'&&msg.id===undefined)this.emit('notification',msg.method,msg.params);
  }
  if(this.buffer.length>MAX_LINE)this.protocolFailure(new Error('Codex RPC line exceeds safety limit'));
 }
 private protocolFailure(error:Error):void{const child=this.child;if(child)this.handleTransportFailure(child,error);}
 private requestInternal(method:string,params?:unknown):Promise<unknown>{
  if(!this.child||this.child.stdin.destroyed)return Promise.reject(new Error('Codex App Server is unavailable'));
  const id=this.nextId++;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{if(!this.requests.has(id))return;this.requests.delete(id);const error=new Error(`Codex RPC timeout: ${method}`);reject(error);const child=this.child;if(child)this.handleTransportFailure(child,error);},this.options.requestTimeoutMs??15000);
   this.requests.set(id,{resolve,reject,timeout});
   const packet=JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n';
   this.child!.stdin.write(packet,error=>{if(!error)return;const request=this.requests.get(id);if(request){clearTimeout(request.timeout);this.requests.delete(id);reject(new Error('Codex App Server pipe write failed'));}});
  });
 }
 async request<T>(method:string,params?:unknown):Promise<T>{
  const maxRetries=SAFE_METHODS.has(method)?Math.max(0,this.options.maxRetries??2):0;let last:unknown;
  for(let attempt=0;attempt<=maxRetries;attempt++){
   try{await this.start();return await this.requestInternal(method,params) as T;}
   catch(error){last=error;if(this.disposed||error instanceof RpcResponseError||attempt===maxRetries)throw error;this.setState('reconnecting');await this.backoff(attempt);}
  }
  throw last;
 }
 private backoff(attempt:number):Promise<void>{
  if(this.retryWait)return this.retryWait;
  const base=Math.max(0,this.options.retryBaseMs??250),max=Math.max(base,this.options.retryMaxMs??5000),jitter=Math.max(0,Math.min(1,this.options.jitter??0.2));
  const nominal=Math.min(max,base*(2**attempt)),delay=Math.max(0,Math.round(nominal*(1+(Math.random()*2-1)*jitter)));
  const wait=new Promise<void>((resolve,reject)=>{this.retryReject=reject;this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;this.retryReject=undefined;this.disposed?reject(new Error('Codex RPC client was disposed')):resolve();},delay);});this.retryWait=wait;void wait.then(()=>{if(this.retryWait===wait)this.retryWait=undefined;},()=>{if(this.retryWait===wait)this.retryWait=undefined;});return wait;
 }
 private notify(method:string,params?:unknown):void{this.child?.stdin.write(JSON.stringify({method,...(params===undefined?{}:{params})})+'\n',()=>{});}
 private failAll(error:Error):void{for(const request of this.requests.values()){clearTimeout(request.timeout);request.reject(error);}this.requests.clear();}
 private stopChild(error:Error,emitState=true):void{
  this.ready=false;this.failAll(error);const child=this.child;this.child=undefined;this.buffer='';
  if(child){child.removeAllListeners();child.stdin.removeAllListeners();child.stdout.removeAllListeners();child.stderr.removeAllListeners();if(child.exitCode===null){child.kill('SIGTERM');const force=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000);force.unref();}}
  if(emitState&&!this.disposed)this.setState('offline');
 }
 dispose():void{if(this.disposed)return;this.disposed=true;if(this.retryTimer){clearTimeout(this.retryTimer);this.retryTimer=undefined;this.retryReject?.(new Error('Codex RPC client was disposed'));this.retryReject=undefined;}this.stopChild(new Error('Codex App Server client disposed'),false);this.setState('offline');this.removeAllListeners();}
}
