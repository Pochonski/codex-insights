import type {DashboardData} from '../core/types';
import type {MiniSummary} from '../core/mini-messages';
import type {QuotaStatus} from '../providers/quotas';
import {formatStatus} from './status-summary';

function title(duration:number|null):string{
 if(duration===300)return '5-hour quota';if(duration===10080)return 'Weekly quota';
 if(duration===null||duration<=0)return 'Additional quota';
 if(duration%1440===0)return `${duration/1440}-day quota`;
 if(duration%60===0)return `${duration/60}-hour quota`;
 return `${duration}-minute quota`;
}
export function buildMiniSummary(quota:QuotaStatus,data:DashboardData,now=Date.now()):MiniSummary{
 const presentation=formatStatus(quota,data,{compact:false,showWeeklyQuota:true},now);
 const multiple=quota.buckets.length>1;
 const windows=quota.buckets.flatMap(bucket=>bucket.windows.map((window,index)=>({bucket,window,index}))).flatMap(({bucket,window,index})=>{
  if(!Number.isFinite(window.usedPercent))return [];
  const usedPercent=Math.max(0,Math.min(100,window.usedPercent));
  const resetMs=window.resetAt?Date.parse(window.resetAt):NaN;
  return [{id:`${bucket.id}:${window.kind}:${index}`,label:(multiple?`${bucket.name.slice(0,40)} · `:'')+title(window.durationMinutes),durationMinutes:window.durationMinutes,usedPercent,availablePercent:100-usedPercent,resetAt:Number.isFinite(resetMs)?window.resetAt:null}];
 });
 let lastModel:string|null=null,lastTime=-Infinity;
 for(const event of data.events){const time=Date.parse(event.timestamp);if(event.model&&Number.isFinite(time)&&time>lastTime){lastModel=event.model.slice(0,80);lastTime=time;}}
 const input=Math.max(0,data.total.inputTokens),cached=Math.max(0,Math.min(input,data.total.cachedInputTokens));
 return {type:'summary/update',level:presentation.level,stateLabel:presentation.stateLabel,plan:quota.plan?quota.plan.slice(0,60):null,fetchedAt:quota.fetchedAt,windows,tokens:{input,output:Math.max(0,data.total.outputTokens),cachedInput:cached,cachePercent:input>0?cached/input*100:null,sessions:data.sessions.length,lastModel}};
}
