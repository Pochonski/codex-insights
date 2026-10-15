import type {GetAccountResponse} from '../protocol/generated/v2/GetAccountResponse';
import type {GetAccountRateLimitsResponse} from '../protocol/generated/v2/GetAccountRateLimitsResponse';
import type {RateLimitSnapshot} from '../protocol/generated/v2/RateLimitSnapshot';
import type {RateLimitWindow} from '../protocol/generated/v2/RateLimitWindow';
import type {LoginAccountResponse} from '../protocol/generated/v2/LoginAccountResponse';
import type {CodexAppServerClient} from './app-server-client';
import type {ConnectionState} from './app-server-client';

export interface QuotaWindow {kind:'primary'|'secondary';durationMinutes:number|null;usedPercent:number;resetAt:string|null;}
export interface QuotaBucket {id:string;name:string;model:string|null;windows:QuotaWindow[];}
export interface QuotaStatus {
 state:'connected'|'stale'|'signed-out'|'api-key'|'error'|'loading';
 plan:string|null; buckets:QuotaBucket[]; ordinaryUsageAllowed:boolean|null;
 fetchedAt:string|null; message:string|null; connectionState?:ConnectionState;
}
export const emptyQuota=(state:QuotaStatus['state']='loading',message:string|null=null):QuotaStatus=>({state,plan:null,buckets:[],ordinaryUsageAllowed:null,fetchedAt:null,message});
export function staleQuota(previous:QuotaStatus,message:string,connectionState:ConnectionState='offline'):QuotaStatus{
 if(!previous.fetchedAt||!previous.buckets.length)return {...emptyQuota('error',message),connectionState};
 return {...previous,state:'stale',message,connectionState};
}
function normalizeWindow(kind:QuotaWindow['kind'],window:RateLimitWindow|null):QuotaWindow|null{
 if(!window||!Number.isFinite(window.usedPercent))return null;
 const secs=window.resetsAt;
 return {kind,durationMinutes:typeof window.windowDurationMins==='number'?window.windowDurationMins:null,usedPercent:Math.max(0,Math.min(100,window.usedPercent)),resetAt:typeof secs==='number'&&Number.isFinite(secs)?new Date(secs*1000).toISOString():null};
}
function bucket(id:string,snapshot:RateLimitSnapshot):QuotaBucket{
 const windows=[normalizeWindow('primary',snapshot.primary),normalizeWindow('secondary',snapshot.secondary)].filter((w):w is QuotaWindow=>w!==null);
 return {id,name:typeof snapshot.limitName==='string'&&snapshot.limitName?snapshot.limitName:id,model:typeof snapshot.normalModelSlug==='string'?snapshot.normalModelSlug:null,windows};
}
export function normalizeQuotas(account:GetAccountResponse,limits:GetAccountRateLimitsResponse):QuotaStatus {
 if(!account?.account)return emptyQuota('signed-out','Sign in with ChatGPT to view plan quotas');
 if(account.account.type!=='chatgpt')return emptyQuota('api-key','API key accounts do not expose ChatGPT plan quotas');
 const entries=Object.entries(limits?.rateLimitsByLimitId||{}).filter((entry):entry is [string,RateLimitSnapshot]=>!!entry[1]&&typeof entry[1]==='object');
 // Use legacy bucket only when it is not represented in the multi-bucket response.
 const legacy=limits?.rateLimits;
 const snapshots=entries.length?entries:legacy?[[legacy.limitId||'codex',legacy] as const]:[];
 const buckets=snapshots.map(([id,s])=>bucket(id,s)).filter(b=>b.windows.length>0);
 const plan=account.account.planType==='unknown'?legacy?.planType:account.account.planType;
 return {state:'connected',plan:plan||null,buckets,ordinaryUsageAllowed:typeof limits?.ordinaryUsageAllowed==='boolean'?limits.ordinaryUsageAllowed:null,fetchedAt:new Date().toISOString(),message:buckets.length?null:'No quota windows were returned by Codex',connectionState:'connected'};
}
export class CodexQuotaProvider {
 constructor(private readonly rpc:CodexAppServerClient){}
 async fetch():Promise<{status:QuotaStatus;accountId:string|null}>{
  const account=await this.rpc.request<GetAccountResponse>('account/read',{refreshToken:false});
  if(!account?.account || account.account.type!=='chatgpt')return {status:normalizeAccountWithoutLimits(account),accountId:null};
  const limits=await this.rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read',{excludeResetCreditDetails:true});
  return {status:normalizeQuotas(account,limits),accountId:typeof limits?.accountId==='string'?limits.accountId:null};
 }
 async beginChatGptLogin():Promise<{url:string;loginId:string}>{
  const result=await this.rpc.request<LoginAccountResponse>('account/login/start',{type:'chatgpt'});
  if(result.type!=='chatgpt')throw new Error('Codex did not return a ChatGPT browser login URL');
  // Prevent arbitrary/untrusted schemes from being opened via the host.
  const parsed=new URL(result.authUrl);
  if(parsed.protocol!=='https:' && !(parsed.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))){throw new Error('Unexpected login URL scheme');}
  return {url:result.authUrl,loginId:result.loginId};
 }
}
function normalizeAccountWithoutLimits(account:GetAccountResponse):QuotaStatus{
 if(!account?.account)return emptyQuota('signed-out','No Codex account session found');
 return emptyQuota('api-key','An API key or alternate account is configured; ChatGPT quotas are unavailable');
}
