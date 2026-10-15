import type {QuotaStatus} from '../providers/quotas';
import type {QuotaPoint} from '../storage/quota-history';
import {normalizeFilters,type Filters} from './filters';
export type WebviewMessage={command:'ready'|'filters';filters:Filters}|{command:'login'|'refresh'};
export type DashboardSnapshot={type:'snapshot';quota:QuotaStatus;analytics:ReturnType<typeof import('../analytics/views').buildAnalyticsView>;histories:{limitId:string;durationMinutes:number;points:QuotaPoint[]}[];storageMode:string;storageWarning?:string|null};
export function parseWebviewMessage(value:unknown):WebviewMessage|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(v.command==='ready'||v.command==='filters')return {command:v.command,filters:normalizeFilters(v.filters)};
 if(v.command==='login'||v.command==='refresh')return {command:v.command};
 return null;
}
export function isDashboardSnapshot(value:unknown):value is DashboardSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(v.type!=='snapshot'||!v.quota||typeof v.quota!=='object'||!v.analytics||typeof v.analytics!=='object'||!Array.isArray(v.histories))return false;
 const a=v.analytics as Record<string,unknown>;const q=v.quota as Record<string,unknown>;
 return Array.isArray(q.buckets)&&Array.isArray(a.sessionRows)&&Array.isArray(a.timeSeries)&&!!a.options&&typeof a.options==='object';
}
