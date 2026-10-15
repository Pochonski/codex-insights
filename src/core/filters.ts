export interface Filters {period:'24h'|'7d'|'30d'|'all';session:string;model:string;project:string}
export const INITIAL_FILTERS:Filters={period:'7d',session:'',model:'',project:''};
export function normalizeFilters(value:unknown):Filters {
 const f=value && typeof value==='object' ? value as Record<string,unknown> : {};
 const period=['24h','7d','30d','all'].includes(String(f.period))?f.period as Filters['period']:'7d';
 const norm=(v:unknown)=>typeof v==='string'?v.slice(0,500):'';
 return {period,session:norm(f.session),model:norm(f.model),project:norm(f.project)};
}
