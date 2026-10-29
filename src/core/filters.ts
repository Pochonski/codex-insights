export interface Filters {period:'24h'|'7d'|'30d'|'all'|'custom';session:string;model:string;project:string;startDate:string;endDate:string}
export const INITIAL_FILTERS:Filters={period:'7d',session:'',model:'',project:'',startDate:'',endDate:''};
export function validCalendarDate(value:string):boolean{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
 if(year<100||month<1||month>12||day<1)return false;
 const daysInMonth=new Date(Date.UTC(year,month,0)).getUTCDate();
 return day<=daysInMonth;
}
export function normalizeFilters(value:unknown):Filters {
 const f=value && typeof value==='object' ? value as Record<string,unknown> : {};
 const period=['24h','7d','30d','all','custom'].includes(String(f.period))?f.period as Filters['period']:'7d';
 const norm=(v:unknown)=>typeof v==='string'?v.slice(0,500):'';
 const date=(v:unknown)=>typeof v==='string'&&validCalendarDate(v)?v:'';
 return {period,session:norm(f.session),model:norm(f.model),project:norm(f.project),startDate:date(f.startDate),endDate:date(f.endDate)};
}
