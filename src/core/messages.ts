import type {QuotaStatus} from '../providers/quotas';
import type {QuotaPoint} from '../storage/quota-history';
import {normalizeFilters,type Filters} from './filters';
import type {HistoricalIntegritySummary} from '../reconciliation/dashboard-summary';
export type WebviewMessage={command:'ready'|'filters';filters:Filters}|{command:'login'|'refresh'|'auditHistory'}|{command:'integrityRendered';eventsAnalyzed:number;supportedByEvidence:number;ambiguousObservations:number;unverifiableLegacy:number;confirmedAdjustments:number};
export type DashboardSnapshot={type:'snapshot';quota:QuotaStatus;analytics:ReturnType<typeof import('../analytics/views').buildAnalyticsView>;histories:{limitId:string;durationMinutes:number;points:QuotaPoint[]}[];storageMode:string;storageWarning?:string|null;historicalIntegrity:HistoricalIntegritySummary};
export function parseWebviewMessage(value:unknown):WebviewMessage|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(v.command==='ready'||v.command==='filters')return {command:v.command,filters:normalizeFilters(v.filters)};
 if(v.command==='login'||v.command==='refresh'||v.command==='auditHistory')return {command:v.command};
 if(v.command==='integrityRendered'){
  const fields=['eventsAnalyzed','supportedByEvidence','ambiguousObservations','unverifiableLegacy','confirmedAdjustments'] as const;
  if(fields.every(key=>Number.isSafeInteger(v[key])&&(v[key] as number)>=0))return {command:v.command,...Object.fromEntries(fields.map(key=>[key,v[key]]))} as WebviewMessage;
 }
 return null;
}
export function isDashboardSnapshot(value:unknown):value is DashboardSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(v.type!=='snapshot'||!v.quota||typeof v.quota!=='object'||!v.analytics||typeof v.analytics!=='object'||!Array.isArray(v.histories)||!v.historicalIntegrity||typeof v.historicalIntegrity!=='object')return false;
 const a=v.analytics as Record<string,unknown>;const q=v.quota as Record<string,unknown>;const integrity=v.historicalIntegrity as Record<string,unknown>;
 return Array.isArray(q.buckets)&&Array.isArray(a.sessionRows)&&Array.isArray(a.timeSeries)&&!!a.options&&typeof a.options==='object'&&['unavailable','loading','complete','partial','failed','stale'].includes(String(integrity.status))&&integrity.changesApplied===false;
}
