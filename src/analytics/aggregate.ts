import type { DashboardData,SessionSummary,UsageEvent } from '../core/types';
export function aggregate(events:UsageEvent[],filesScanned=0,warnings:string[]=[]):DashboardData {
 const sessions=new Map<string,SessionSummary>();const unique:UsageEvent[]=[];const fingerprints=new Set<string>();const total={inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0};
 for(const e of events){if(e.fingerprint){if(fingerprints.has(e.fingerprint))continue;fingerprints.add(e.fingerprint);}unique.push(e);let s=sessions.get(e.sessionId);if(!s){s={id:e.sessionId,startedAt:e.timestamp,model:e.model,project:e.project,events:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0};sessions.set(e.sessionId,s);}if(e.model)s.model=e.model;if(e.project)s.project=e.project;s.events++;
  for(const k of Object.keys(total) as (keyof typeof total)[]){total[k]+=e[k];s[k]+=e[k];}}
 return {scannedAt:new Date().toISOString(),filesScanned,events:unique,sessions:[...sessions.values()].sort((a,b)=>b.inputTokens+b.outputTokens-a.inputTokens-a.outputTokens),total,warnings};
}
