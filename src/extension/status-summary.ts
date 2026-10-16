import type {DashboardData} from '../core/types';
import type {QuotaStatus,QuotaWindow} from '../providers/quotas';

export const STATUS_COMMANDS = ['codexInsights.openMiniPanel','codexInsights.openDashboard','codexInsights.refresh','codexInsights.copySummary'] as const;
export interface StatusSettings {compact:boolean;showWeeklyQuota:boolean;}
export type StatusLevel = 'normal'|'warning'|'critical'|'exhausted'|'offline'|'stale'|'authentication_required'|'loading'|'error';
export interface StatusPresentation {text:string;markdown:string;plainText:string;level:StatusLevel;stateLabel:string;accessibilityLabel:string;}

const validPercent=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(100,value)):null;
const safeText=(value:string,max=60):string=>value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max);
const mdText=(value:string):string=>safeText(value).replace(/[\\`*_{}\[\]()#+.!|<>-]/g,'\\$&');
const planText=(value:string):string=>{const clean=safeText(value);return /^(plus|pro|free|team|business|enterprise)$/i.test(clean)?clean[0].toUpperCase()+clean.slice(1).toLowerCase():clean;};
const percent=(value:number):string=>`${Math.round(value)}%`;
export const compactNumber=(value:number):string=>!Number.isFinite(value)||value<0?'—':value>=1_000_000?`${+(value/1_000_000).toFixed(1)}M`:value>=1_000?`${+(value/1_000).toFixed(1)}K`:String(Math.round(value));
const dateMs=(value:string|null):number|null=>{const ms=value?Date.parse(value):NaN;return Number.isFinite(ms)?ms:null;};
export function resetLabel(resetAt:string|null,now:number):string{
 const ms=dateMs(resetAt);if(ms===null)return 'Reset time unavailable';if(ms<=now)return 'Reset expected · awaiting confirmation';
 const minutes=Math.ceil((ms-now)/60_000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
 return `Resets in ${days?`${days}d `:''}${hours?`${hours}h `:''}${rest||(!days&&!hours)?`${rest}m`:''}`.trim();
}
export function updatedLabel(fetchedAt:string|null,now:number):string{
 const ms=dateMs(fetchedAt);if(ms===null)return 'No confirmed update';
 const elapsed=Math.max(0,Math.floor((now-ms)/1000));return `Updated ${elapsed<60?`${elapsed}s`:elapsed<3600?`${Math.floor(elapsed/60)}m`:elapsed<86400?`${Math.floor(elapsed/3600)}h`:`${Math.floor(elapsed/86400)}d`} ago`;
}
function windowFor(quota:QuotaStatus,duration:number):QuotaWindow|undefined{return quota.buckets.flatMap(b=>b.windows).find(w=>w.durationMinutes===duration&&validPercent(w.usedPercent)!==null);}
function displayState(quota:QuotaStatus,now:number):{label:string;level:StatusLevel}{
 if(quota.state==='signed-out'||quota.state==='api-key')return {label:quota.state==='signed-out'?'Sign in required':'ChatGPT quotas unavailable',level:'authentication_required'};
 if(quota.state==='loading')return {label:'Connecting',level:'loading'};
 if(quota.state==='stale')return {label:'Last known data · connection unavailable',level:'stale'};
 if(quota.state==='error')return {label:quota.connectionState==='offline'?'Offline':'Connection error',level:quota.connectionState==='offline'?'offline':'error'};
 const updated=dateMs(quota.fetchedAt);
 if(updated===null||now-updated>10*60_000)return {label:'Last known data · update overdue',level:'stale'};
 const primary=windowFor(quota,300),weekly=windowFor(quota,10080);const values=[primary,weekly].map(w=>w?validPercent(w.usedPercent):null).filter((n):n is number=>n!==null);
 if(!values.length)return {label:'Connected · quotas unavailable',level:'normal'};
 const used=Math.max(...values);
 if(used>=100)return {label:'Quota exhausted',level:'exhausted'};
 if(used>=95)return {label:'Quota critical',level:'critical'};
 if(used>=80)return {label:'Quota warning',level:'warning'};
 return {label:'Connected',level:'normal'};
}
function lastModel(data:DashboardData):string|null{
 let best:{model:string;time:number}|null=null;
 for(const event of data.events){if(!event.model)continue;const time=Date.parse(event.timestamp);if(Number.isFinite(time)&&(!best||time>best.time))best={model:event.model,time};}
 return best?.model??null;
}
export function formatStatus(quota:QuotaStatus,data:DashboardData,settings:StatusSettings,now=Date.now()):StatusPresentation{
 const current=displayState(quota,now);const first=windowFor(quota,300),week=settings.showWeeklyQuota?windowFor(quota,10080):undefined;
 const isCurrent=quota.state==='connected'&&current.level!=='stale';
 const primaryValue=first?validPercent(first.usedPercent):null,weeklyValue=week?validPercent(week.usedPercent):null;
 const icon=current.level==='exhausted'||current.level==='critical'||current.level==='warning'?'$(warning)':current.level==='offline'||current.level==='stale'||current.level==='error'?'$(debug-disconnect)':current.level==='loading'?'$(sync~spin)':'$(pulse)';
 const statusParts=[`${icon} Codex`];
 if(isCurrent&&primaryValue!==null)statusParts.push(settings.compact?percent(primaryValue):`5h ${percent(primaryValue)}`);
 if(isCurrent&&weeklyValue!==null)statusParts.push(settings.compact&&primaryValue!==null?percent(weeklyValue):`7d ${percent(weeklyValue)}`);
 if(!isCurrent)statusParts.push(current.level==='stale'?'Stale':current.level==='authentication_required'?'Sign in':current.level==='loading'?'Loading':current.level==='error'?'Error':'Offline');
 const text=statusParts.join(' · ');
 const lines=[`### $(pulse) Codex Insights`,`**${current.label}**${quota.plan?` · ChatGPT ${mdText(planText(quota.plan))}`:''}  \n${updatedLabel(quota.fetchedAt,now)}`];
 const plain=[`Codex Insights — ${current.label}${quota.plan?` · ChatGPT ${planText(quota.plan)}`:''}`,updatedLabel(quota.fetchedAt,now)];
 if(first||week)plain.push('');
 for(const [label,window] of [['5-hour limit',first],['7-day limit',week]] as const){
  if(!window)continue;const used=validPercent(window.usedPercent);if(used===null)continue;
  const detail=`${percent(used)} used · ${percent(100-used)} available`;
  lines.push(`**${label.toUpperCase()} · ${percent(used)} used**${isCurrent?'':' · last known'}  \n${percent(100-used)} available · ${resetLabel(window.resetAt,now)}`);
  plain.push(`${label}${isCurrent?'':' (last known)'}: ${detail}; ${resetLabel(window.resetAt,now)}`);
 }
 plain.push('','Local tokens — all recorded history');
 const t=data.total;const tokenLine=`Input ${compactNumber(t.inputTokens)} · Output ${compactNumber(t.outputTokens)}`;
 const detailLine=`${data.sessions.length} ${data.sessions.length===1?'session':'sessions'} · Cached input ${compactNumber(t.cachedInputTokens)}`;
 lines.push(`**Local activity** · ${data.sessions.length} ${data.sessions.length===1?'session':'sessions'}  \n${tokenLine}`);plain.push(tokenLine,detailLine);
 const model=lastModel(data);if(model)plain.push(`Last observed model: ${safeText(model)}`);
 lines.push('[Mini Panel](command:codexInsights.openMiniPanel) · [Dashboard](command:codexInsights.openDashboard) · [Refresh](command:codexInsights.refresh)');
 plain.push(`Generated: ${new Date(now).toISOString()}`);
 return {text,markdown:lines.join('\n\n'),plainText:plain.join('\n'),level:current.level,stateLabel:current.label,accessibilityLabel:`Codex Insights. ${current.label}. ${primaryValue!==null&&isCurrent?`Five hour quota ${percent(primaryValue)} used.`:''} Open mini panel.`};
}
