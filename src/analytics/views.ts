import path from 'node:path';
import type {DashboardData, UsageEvent, SessionSummary} from '../core/types';

import {normalizeFilters,type Filters} from '../core/filters';
export {normalizeFilters,INITIAL_FILTERS} from '../core/filters';
export type {Filters} from '../core/filters';
type Totals={inputTokens:number;outputTokens:number;cachedInputTokens:number;reasoningOutputTokens:number};
const empty=():Totals=>({inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0});
const keys=Object.keys(empty()) as (keyof Totals)[];
function add(target:Totals,event:UsageEvent){for(const k of keys)target[k]+=event[k];}
function validTime(value:string):number|null{const t=Date.parse(value);return Number.isFinite(t)?t:null;}
function shortProject(name:string){return name?path.basename(name.replace(/[\\/]+$/,''))||name:'Unknown project';}
function breakdown(events:UsageEvent[],key:(e:UsageEvent)=>string){
 const map=new Map<string,{name:string;tokens:number;inputTokens:number;outputTokens:number;events:number}>();
 for(const e of events){const name=key(e);let row=map.get(name);if(!row){row={name,tokens:0,inputTokens:0,outputTokens:0,events:0};map.set(name,row);}row.events++;row.inputTokens+=e.inputTokens;row.outputTokens+=e.outputTokens;row.tokens+=e.inputTokens+e.outputTokens;}
 return [...map.values()].sort((a,b)=>b.tokens-a.tokens).slice(0,12);
}
function bucketTime(t:number,unit:'hour'|'day'|'week'){if(unit==='hour')return Math.floor(t/3600000)*3600000;if(unit==='day')return Math.floor(t/86400000)*86400000;return Math.floor((Math.floor(t/86400000)+3)/7)*7*86400000-3*86400000;}
export function buildAnalyticsView(d:DashboardData,request:unknown,now=Date.now()){
 const f=normalizeFilters(request);
 const allLastSeen=new Map<string,number>();
 for(const event of d.events){const time=validTime(event.timestamp);if(time!==null&&time>(allLastSeen.get(event.sessionId)??-Infinity))allLastSeen.set(event.sessionId,time);}
 const byRecent=(lastSeen:Map<string,number>)=>(a:SessionSummary,b:SessionSummary)=>(lastSeen.get(b.id)??-Infinity)-(lastSeen.get(a.id)??-Infinity)||(b.inputTokens+b.outputTokens)-(a.inputTokens+a.outputTokens)||a.id.localeCompare(b.id);
 const sessionSet=new Set(d.sessions.map(s=>s.id));
 const modelSet=new Set(d.events.map(e=>e.model||'Unknown model'));
 const projectSet=new Set(d.events.map(e=>e.project||'Unknown project'));
 // Keep unmatched selections so a stale filter cannot silently show another session's data.
 const oldest=d.events.reduce((n,e)=>Math.min(n,validTime(e.timestamp)??n),now);
 // Calendar dates are UTC in both the Webview and Extension Host, including remote hosts.
 const customStart=f.startDate?Date.parse(f.startDate+'T00:00:00.000Z'):-Infinity;
 const customEndExclusive=f.endDate?Date.parse(f.endDate+'T00:00:00.000Z')+86400000:Infinity;
 const customRangeValid=f.period!=='custom'||(!!f.startDate&&!!f.endDate&&Number.isFinite(customStart)&&Number.isFinite(customEndExclusive)&&customStart<customEndExclusive);
 const unit:'hour'|'day'|'week'=f.period==='24h'?'hour':(f.period==='all'||f.period==='custom')&&now-oldest>120*86400000?'week':'day';
 const since=f.period==='24h'?now-86400000:f.period==='7d'?now-7*86400000:f.period==='30d'?now-30*86400000:f.period==='custom'?customStart:-Infinity;
 const until=f.period==='custom'?customEndExclusive:now+300000;
 const events=d.events.filter(e=>{const t=validTime(e.timestamp);return customRangeValid&&(f.period==='all'||t!==null&&t>=since&&(f.period==='custom'?t<until:t<=until))&&(!f.session||e.sessionId===f.session)&&(!f.model||(e.model||'Unknown model')===f.model)&&(!f.project||(e.project||'Unknown project')===f.project);});
 const total=empty();const sessions=new Map<string,SessionSummary>();const filteredLastSeen=new Map<string,number>();const timeline=new Map<number,{at:string;events:number}&Totals>();
 for(const e of events){add(total,e);let s=sessions.get(e.sessionId);if(!s){s={id:e.sessionId,project:e.project,startedAt:e.timestamp,model:e.model,events:0,...empty()};sessions.set(e.sessionId,s);}if(e.model)s.model=e.model;if(e.project)s.project=e.project;s.events++;add(s,e);
 const t=validTime(e.timestamp);if(t!==null){if(t>(filteredLastSeen.get(e.sessionId)??-Infinity))filteredLastSeen.set(e.sessionId,t);const key=bucketTime(t,unit);let point=timeline.get(key);if(!point){point={at:new Date(key).toISOString(),events:0,...empty()};timeline.set(key,point);}point.events++;add(point,e);}}
 return {filters:f,options:{sessions:[...d.sessions].sort(byRecent(allLastSeen)).slice(0,1000).map(s=>({id:s.id,label:`${s.id.slice(0,13)} · ${shortProject(s.project||'')} · ${s.model||'Unknown model'}`})),models:[...modelSet].sort(),projects:[...projectSet].sort()},total,sessionCount:sessions.size,eventCount:events.length,timeSeries:[...timeline.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-500),sessionRows:[...sessions.values()].sort(byRecent(filteredLastSeen)).slice(0,250),models:breakdown(events,e=>e.model||'Unknown model'),projects:breakdown(events,e=>shortProject(e.project||'')),chartBucket:unit,scannedAt:d.scannedAt,filesScanned:d.filesScanned,warnings:d.warnings,scanNotice:d.scanNotice??null,customRangeValid,selectedFilterValid:customRangeValid&&(!f.session||sessionSet.has(f.session))&&(!f.model||modelSet.has(f.model))&&(!f.project||projectSet.has(f.project))};
}
