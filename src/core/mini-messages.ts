import type {StatusLevel} from '../extension/status-summary';

export interface MiniQuotaWindow {
 id:string;label:string;durationMinutes:number|null;usedPercent:number;availablePercent:number;resetAt:string|null;
}
export interface MiniSummary {
 type:'summary/update';level:StatusLevel;stateLabel:string;plan:string|null;fetchedAt:string|null;
 windows:MiniQuotaWindow[];
 tokens:{input:number;output:number;cachedInput:number;cachePercent:number|null;sessions:number;lastModel:string|null};
}
export type MiniInbound={type:'mini/ready'|'mini/refresh'|'mini/openDashboard'|'mini/copySummary'};
export type MiniOutbound=MiniSummary|{type:'summary/refreshDone'}|{type:'summary/notice';message:string}|{type:'summary/error';message:string};

const inbound=new Set<MiniInbound['type']>(['mini/ready','mini/refresh','mini/openDashboard','mini/copySummary']);
export function parseMiniMessage(value:unknown):MiniInbound|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const keys=Object.keys(value);if(keys.length!==1||keys[0]!=='type')return null;
 const type=(value as {type?:unknown}).type;
 return typeof type==='string'&&inbound.has(type as MiniInbound['type'])?{type:type as MiniInbound['type']}:null;
}
export function isMiniOutbound(value:unknown):value is MiniOutbound{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(v.type==='summary/notice'||v.type==='summary/error')return typeof v.message==='string'&&v.message.length<=240;
 if(v.type==='summary/refreshDone')return true;
 if(v.type!=='summary/update'||!Array.isArray(v.windows)||!v.tokens||typeof v.tokens!=='object')return false;
 if(!['normal','warning','critical','exhausted','offline','stale','authentication_required','loading','error'].includes(String(v.level)))return false;
 if(typeof v.stateLabel!=='string'||v.stateLabel.length>120||!(v.plan===null||typeof v.plan==='string')||!(v.fetchedAt===null||typeof v.fetchedAt==='string'))return false;
 const t=v.tokens as Record<string,unknown>;
 if(!['input','output','cachedInput','sessions'].every(k=>typeof t[k]==='number'&&Number.isFinite(t[k])&&t[k]>=0))return false;
 if(!(t.cachePercent===null||typeof t.cachePercent==='number'&&Number.isFinite(t.cachePercent)&&t.cachePercent>=0&&t.cachePercent<=100)||!(t.lastModel===null||typeof t.lastModel==='string'))return false;
 return v.windows.every(w=>w&&typeof w==='object'&&typeof w.id==='string'&&typeof w.label==='string'&&Number.isFinite(w.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100&&Number.isFinite(w.availablePercent)&&w.availablePercent>=0&&w.availablePercent<=100&&(w.resetAt===null||typeof w.resetAt==='string'));
}
