import {isDashboardSnapshot} from "../core/messages";
import {countdown} from "./countdown";
import React from "react";
import {createRoot} from "react-dom/client";
import {version as extensionVersion} from "../../package.json";
/* Codex Insights React dashboard. Fully local: no fetch, CDN, telemetry or credentials. */
(function () {
 'use strict';
 const h=React.createElement;
 const vscode=acquireVsCodeApi();
 const fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});
 const short=n=>n>=1000000000?(n/1e9).toFixed(2)+'B':n>=1000000?(n/1e6).toFixed(2)+'M':n>=1000?(n/1000).toFixed(1)+'K':fmt(n);
 const date=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toLocaleString():'Unavailable';};
 const hhmm=v=>new Date(v).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
 const percent=n=>Math.min(100,Math.max(0,Number(n)||0));
 const initialFilters={period:'7d',session:'',model:'',project:'',startDate:'',endDate:''};
 const persisted=vscode.getState()||{};
 const colorFor=p=>p>=95?'crit':p>=80?'warn':'good';
 const palette={input:'#5b9cf5',output:'#36c99b',used:'#f2b25c',cached:'#a495f9',reasoning:'#ee83c5'};
 function CountDown(props){return h(CountdownClock,{at:props.at});}
 class CountdownClock extends React.Component{
  constructor(props){super(props);this.state={now:Date.now()};}
  componentDidMount(){this.timer=setInterval(()=>this.setState({now:Date.now()}),1000);}
  componentWillUnmount(){clearInterval(this.timer);}
  render(){if(!this.props.at)return h('span',{className:'muted'},'Reset unavailable');const remaining=Date.parse(this.props.at)-this.state.now;
   if(!Number.isFinite(remaining))return h('span',{className:'muted'},'Reset unavailable');
   if(remaining<=0)return h('span',{className:'countdown'},countdown(this.props.at,this.state.now));
   return h('span',{className:'countdown',title:date(this.props.at)},countdown(this.props.at,this.state.now));
  }
 }
 const icon=(kind)=>({overview:'◫',quotas:'◷',tokens:'◉',sessions:'▤',projects:'▦'}[kind]||'◎');
 function SectionHeading(props){return h('div',{className:'section-heading'},h('h2',null,props.title),props.right?h('span',{className:'section-meta'},props.right):null);}
 function Empty(props){return h('div',{className:'empty-state'},h('div',{className:'empty-icon'},'⌁'),h('div',{className:'empty-title'},props.title),h('div',{className:'empty-detail'},props.description));}
 function QuotaCard({window:w,title,stale}){const p=percent(w.usedPercent);return h('article',{className:'panel quota-card'+(stale?' stale':'')},
  h('div',{className:'quota-top'},h('span',{className:'quota-label'},title),h('strong',{className:'quota-value'},`${Number(p.toFixed(1)).toLocaleString()}%`)),
  h('div',{className:'bar-track',role:'progressbar','aria-label':title,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':p},h('div',{className:`bar-fill ${colorFor(p)}`,style:{width:p+'%'}})),
  h('div',{className:'quota-foot'},h('span',null,`${Number((100-p).toFixed(1))}% remaining · Resets in `,h(CountDown,{at:w.resetAt})),h('span',{title:date(w.resetAt)},w.resetAt?date(w.resetAt):'No reset timestamp')),stale?h('div',{className:'stale-label'},'Last known value · awaiting a successful refresh'):null);
 }
 function Metric({label,value,caption,color}){return h('div',{className:'metric-card'},h('div',{className:'metric-head'},h('span',{className:'metric-label'},label),h('span',{className:'metric-dot',style:{background:color}})),h('div',{className:'metric-value',title:fmt(value)},fmt(value)),h('div',{className:'metric-caption'},caption));}
 function HistoricalIntegrity({summary}){
  const state=summary&&summary.status||'unavailable';
  const run=()=>vscode.postMessage({command:'auditHistory'});
  if(state==='unavailable')return h('section',{className:'integrity-section','aria-labelledby':'historical-integrity-title'},h(SectionHeading,{title:'Historical Data Integrity',right:'Read-only'}),h('div',{className:'panel integrity-empty'},h('div',null,h('div',{id:'historical-integrity-title',className:'chart-title'},'No audit result available'),h('p',{className:'chart-description'},summary&&summary.message||'Run a read-only audit to classify the evidence currently available. Stored token totals are never changed.')),h('button',{className:'button primary',type:'button',onClick:run},'Run read-only audit')));
  if(state==='loading')return h('section',{className:'integrity-section','aria-labelledby':'historical-integrity-title','aria-busy':'true'},h(SectionHeading,{title:'Historical Data Integrity',right:'Audit in progress'}),h('div',{className:'panel integrity-state',role:'status'},h('span',{className:'integrity-spinner','aria-hidden':'true'}),h('div',null,h('div',{id:'historical-integrity-title',className:'chart-title'},'Classifying available evidence'),h('p',{className:'chart-description'},summary.message||'The dashboard remains usable while the isolated snapshot is audited.'))));
  if(state==='failed')return h('section',{className:'integrity-section','aria-labelledby':'historical-integrity-title'},h(SectionHeading,{title:'Historical Data Integrity',right:'Audit failed'}),h('div',{className:'panel integrity-error',role:'alert'},h('div',null,h('div',{id:'historical-integrity-title',className:'chart-title'},'Historical audit could not complete'),h('p',{className:'chart-description'},summary.message||'No stored totals were changed.')),h('button',{className:'button',type:'button',onClick:run},'Retry audit')));
  const supported=Number(summary.supportedByEvidence)||0,ambiguous=Number(summary.ambiguousObservations)||0,legacy=Number(summary.unverifiableLegacy)||0,adjustments=Number(summary.confirmedAdjustments)||0,total=Number(summary.eventsAnalyzed)||0;
  const classified=supported+ambiguous+legacy+adjustments,consistent=classified===total;
  const label=state==='complete'?'Complete':state==='partial'?'Partial':'Out of date';
  return h('section',{className:'integrity-section','aria-labelledby':'historical-integrity-title'},h(SectionHeading,{title:'Historical Data Integrity',right:`${label} · ${summary.generatedAt?date(summary.generatedAt):'time unavailable'}`}),h('div',{className:'panel integrity-panel'},
   h('div',{className:'integrity-head'},h('div',null,h('div',{id:'historical-integrity-title',className:'chart-title'},`${fmt(total)} events analyzed`),h('p',{className:'chart-description'},state==='stale'?'Usage data changed after this audit. The displayed classifications refer to the earlier snapshot.':state==='partial'?'Available evidence covers only part of the stored history.':'All analyzed events were classified using the available snapshot evidence.')),h('span',{className:'tag '+(state==='complete'?'ok':'')},label)),
   h('div',{className:'integrity-grid'},h(Metric,{label:'Supported by available evidence',value:supported,caption:'Supported within surviving evidence; not a certificate of absolute historical uniqueness.',color:palette.output}),h(Metric,{label:'Ambiguous observations',value:ambiguous,caption:'Lineage or overlap cannot be concluded safely.',color:palette.used}),h(Metric,{label:'Unverifiable legacy',value:legacy,caption:'Required historical source evidence is unavailable.',color:palette.cached}),h(Metric,{label:'Confirmed adjustments',value:adjustments,caption:adjustments===0?'No adjustments are currently demonstrated.':'Evidence-backed proposals only; they have not been applied.',color:palette.reasoning})),
   consistent&&total>0?h('div',{className:'integrity-distribution','aria-label':'Distribution of historical integrity classifications'},[['supported',supported,'var(--green)'],['ambiguous',ambiguous,'var(--amber)'],['legacy',legacy,'var(--violet)'],['adjustments',adjustments,'var(--red)']].filter(item=>item[1]>0).map(item=>h('span',{key:item[0],title:`${item[0]}: ${fmt(item[1])}`,style:{width:(item[1]/total*100)+'%',background:item[2]}}))):null,
   !consistent?h('div',{className:'notice alert'},'The category totals do not cover the audited event count. Treat this result as partial and rerun the audit.'):null,
   h('div',{className:'integrity-meta'},h('span',null,summary.missingHistoricalSources?'Historical sources are missing for part of this snapshot.':'No missing historical source was reported for this snapshot.'),h('span',null,`${fmt(summary.overlapCandidates||0)} overlap candidates · candidates are not confirmed adjustments`),summary.snapshotRef?h('span',{className:'monospace'},`Snapshot ${summary.snapshotRef}`):null,Number.isFinite(summary.durationMs)?h('span',null,`Completed in ${Math.round(summary.durationMs)} ms`):null),
   h('div',{className:'integrity-footer'},h('strong',null,'No changes applied'),h('span',null,'Auditing does not alter tokens, observations, fingerprints, checkpoints or quota data.'),h('button',{className:'button',type:'button',onClick:run},state==='stale'?'Run audit again':'Refresh audit'))));
 }
 function Chart({points,type,period}){
  if(!points||points.length<(type==='quota'?2:1))return h(Empty,{title:'Not enough historical samples yet',description:type==='quota'?'Each successful quota refresh adds a real, timestamped sample. A chart appears after at least two distinct samples.':'No timestamped usage events match these filters. Change the period or filters.'});
  const W=650,H=230,L=48,R=16,T=15,B=34,plotW=W-L-R,plotH=H-T-B;
  const ts=p=>type==='quota'?p.observedAt*1000:Date.parse(p.at);
  const first=ts(points[0]),last=ts(points[points.length-1]),span=Math.max(1000,last-first);
  const fields=type==='quota'?['usedPercent']:['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'];
  const max=type==='quota'?100:Math.max(1,...points.flatMap(p=>fields.map(k=>Number(p[k])||0)))*1.12;
  const X=p=>L+(ts(p)-first)/span*plotW,Y=(value)=>T+plotH-(Number(value)||0)/max*plotH;
  const grid=[0,.25,.5,.75,1].map((q,i)=>h('g',{key:'g'+i},h('line',{x1:L,y1:Y(max*q),x2:W-R,y2:Y(max*q),className:'plot-grid'}),h('text',{x:L-7,y:Y(max*q)+4,className:'plot-text',textAnchor:'end'},type==='quota'?`${Math.round(q*100)}%`:short(max*q))));
  const chartLines=fields.map((field,i)=>{
   const segments=[];let segment=[];
   points.forEach((p,index)=>{
    const prior=points[index-1];
    if(type==='quota'&&index>0&&(p.resetAt!==prior.resetAt||p.usedPercent+1<prior.usedPercent)){
     if(segment.length)segments.push(segment);segment=[];
    }
    segment.push(p);
   });if(segment.length)segments.push(segment);
   const color=type==='quota'?palette.used:[palette.input,palette.output,palette.cached,palette.reasoning][i];
   return h('g',{key:field},segments.map((seg,j)=>h('polyline',{key:j,points:seg.map(p=>X(p).toFixed(1)+','+Y(p[field]).toFixed(1)).join(' '),className:'plot-line',stroke:color})),
    points.length<=100?points.map((p,j)=>h('circle',{key:j,cx:X(p),cy:Y(p[field]),r:2.4,fill:color},h('title',null,`${date(new Date(ts(p)).toISOString())}: ${type==='quota'?Number(p[field]).toFixed(1)+'%':fmt(p[field])+' tokens'}`))):null);
  });
  const ticks=[0,.25,.5,.75,1].map((fraction,index)=>{const t=first+span*fraction;return h('text',{key:'x'+index,x:L+fraction*plotW,y:H-9,className:'plot-text',textAnchor:index===0?'start':index===4?'end':'middle'},period==='24h'?hhmm(t):new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'}));});
  return h('div',null,h('svg',{className:'plot',viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':type==='quota'?'Historical quota consumption plotted using recorded samples':'Recorded input and output tokens by time bucket'},grid,chartLines,ticks),
   h('div',{className:'legend'},(type==='quota'?[['Quota used',palette.used]]:[['Input tokens',palette.input],['Output tokens',palette.output],['Cached input',palette.cached],['Reasoning output',palette.reasoning]]).map(x=>h('span',{key:x[0]},h('span',{className:'legend-dot',style:{background:x[1]}}),x[0])),h('span',null,`${fmt(points.length)} real ${type==='quota'?'samples':'active time buckets'}`)));
 }
 function BreakdownPanel({title,items,mode}){const max=Math.max(1,...(items||[]).map(i=>i.tokens));return h('div',{className:'panel'},h('div',{className:'chart-title'},title),h('p',{className:'chart-description'},'Ranked by observed input + output tokens'),!items||!items.length?h(Empty,{title:'No matching data',description:'Adjust your filters to see this breakdown.'}):items.slice(0,7).map((i,index)=>h('div',{className:'breakdown-item',key:i.name},
  h('div',{className:'breakdown-name'},h('span',{title:i.name},i.name),h('span',{className:'muted'},short(i.tokens))),h('div',{className:'thin-track'},h('div',{className:'thin-fill',style:{width:(i.tokens/max*100)+'%',background:mode==='projects'?palette.cached:palette.input}})))));
 }
 function SessionTable({rows,onSelect,selected}){return h('div',{className:'table-shell'},h('table',null,h('thead',null,h('tr',null,['Recorded ID','Project','Last model','Input','Output','Cached','Events'].map(x=>h('th',{key:x},x)))),h('tbody',null,rows&&rows.length?rows.map(s=>h('tr',{key:s.id,onClick:()=>onSelect(s.id),style:{cursor:'pointer',background:selected===s.id?'var(--vscode-list-activeSelectionBackground)':'transparent'}},h('td',{className:'monospace accent',title:s.id},s.id.slice(0,17)+'…'),h('td',null,projectName(s.project)),h('td',null,s.model||'Unknown'),h('td',null,fmt(s.inputTokens)),h('td',null,fmt(s.outputTokens)),h('td',null,fmt(s.cachedInputTokens)),h('td',null,fmt(s.events)))):h('tr',null,h('td',{colSpan:7},'No matching usage groups.')))));
 }
 function projectName(p){if(!p)return 'Unknown';return p.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||p;}
 function selectField(label,value,options,onChange){return h('div',{className:'field'},h('label',null,label),h('select',{value:value||'',onChange:e=>onChange(e.target.value),'aria-label':label},options.map(o=>h('option',{key:o.value,value:o.value},o.label))));}
 function dateField(label,value,onChange){return h('div',{className:'field'},h('label',null,label),h('input',{type:'date',value:value||'',onChange:e=>onChange(e.target.value),'aria-label':label}));}
 function rangeOptions(){return [['24h','Last 24 hours'],['7d','Last 7 days'],['30d','Last 30 days'],['all','All available'],['custom','Custom range']].map(x=>({value:x[0],label:x[1]}));}
 function QuotaHistoryPanel({histories,quota,range,changeRange,windowMinutes,changeWindow}){
  const duration=windowMinutes;
  const set=histories&&histories.find(p=>p.durationMinutes===duration);
  const since=range==='24h'?Date.now()-86400000:range==='7d'?Date.now()-7*86400000:range==='30d'?Date.now()-30*86400000:0;
  const points=set?(set.points||[]).filter(p=>p.observedAt*1000>=since):[];
  return h('div',{className:'panel chart-panel'},h('div',{className:'chart-header'},h('div',{className:'chart-title'},windowMinutes===300?'5-hour quota history':'7-day quota history'),h('div',{className:'seg-tabs'},[['24h','24h'],['7d','7d'],['30d','30d']].map(([v,l])=>h('button',{key:v,type:'button',className:range===v?'selected':'',onClick:()=>changeRange(v)},l)))),
   h('p',{className:'chart-description'},'Real samples collected locally. A break in the line denotes a quota reset.'),h('div',{className:'seg-tabs',style:{marginBottom:12}},[[300,'5-hour window'],[10080,'7-day window']].map(([v,l])=>h('button',{key:v,type:'button',className:windowMinutes===v?'selected':'',onClick:()=>changeWindow(v)},l))),
   h(Chart,{points,type:'quota',period:range}));
 }
 class App extends React.Component{
  constructor(props){super(props);this.state={page:persisted.page||'overview',filters:Object.assign({},initialFilters,persisted.filters||{}),quotaRange:persisted.quotaRange||'24h',quotaWindow:persisted.quotaWindow||300,selectedSession:'',snapshot:null,refreshing:false};this.onMessage=this.onMessage.bind(this);}
  componentDidMount(){window.addEventListener('message',this.onMessage);vscode.postMessage({command:'ready',filters:this.state.filters});}
  componentWillUnmount(){window.removeEventListener('message',this.onMessage);clearTimeout(this.refreshTimer);}
  onMessage(event){const payload=event.data;if(!isDashboardSnapshot(payload))return;clearTimeout(this.refreshTimer);this.setState({snapshot:payload,refreshing:false},()=>{const integrity=payload.historicalIntegrity;if(['complete','partial','stale'].includes(integrity.status))vscode.postMessage({command:'integrityRendered',eventsAnalyzed:integrity.eventsAnalyzed||0,supportedByEvidence:integrity.supportedByEvidence||0,ambiguousObservations:integrity.ambiguousObservations||0,unverifiableLegacy:integrity.unverifiableLegacy||0,confirmedAdjustments:integrity.confirmedAdjustments||0});});}
  remember(next){const update=Object.assign({},this.state,next);vscode.setState({page:update.page,filters:update.filters,quotaRange:update.quotaRange,quotaWindow:update.quotaWindow});this.setState(next);}
  setPage(page){this.remember({page});}
  setFilters(filters){const f=Object.assign({},this.state.filters,filters);this.remember({filters:f});vscode.postMessage({command:'filters',filters:f});}
  refresh(){clearTimeout(this.refreshTimer);this.setState({refreshing:true});vscode.postMessage({command:'refresh'});this.refreshTimer=setTimeout(()=>this.setState({refreshing:false}),20000);}
  render(){const snap=this.state.snapshot;const data=snap&&snap.analytics;const quota=snap&&snap.quota;const f=this.state.filters;
   const state=quota?quota.state:'loading',statusLabel=state==='connected'?'ChatGPT connected':state==='stale'?'Offline · last known data':state==='loading'?'Connecting':state==='signed-out'?'Sign-in required':state==='error'?'Connection error':'Quota unavailable';
   const navbar=[['overview','Overview'],['quotas','Quotas & history'],['tokens','Tokens'],['sessions','Usage groups'],['projects','Projects']];
   const sidebar=h('aside',{className:'sidebar'},h('div',{className:'brand'},h('div',{className:'mark'},'⌁'),h('div',null,h('div',{className:'brand-name'},'Codex Insights'),h('div',{className:'brand-sub'},'ANALYTICS STUDIO'))),
    h('nav',{className:'nav','aria-label':'Dashboard sections'},h('div',{className:'nav-title'},'Workspace'),navbar.map(([id,title])=>h('button',{key:id,type:'button',className:'nav-item'+(this.state.page===id?' active':''),onClick:()=>this.setPage(id)},h('span',{className:'nav-symbol'},icon(id)),title))),
    h('div',{className:'side-bottom'},h('div',null,h('span',{className:'status-indicator '+(state==='connected'?'':state==='loading'?'loading':'error')}),statusLabel),h('div',{className:'muted small'},'Codex App Server'),h('div',{className:'tiny muted',style:{marginTop:9}},`v${extensionVersion} · Local-first`)));
   const header=h('div',{className:'page-top'},h('div',null,h('div',{className:'eyebrow'},'Developer observability'),h('h1',{className:'page-title'},this.state.page==='overview'?'Analytics overview':this.state.page==='quotas'?'Quota intelligence':this.state.page==='tokens'?'Token analytics':this.state.page==='projects'?'Project analytics':'Usage group explorer'),h('p',{className:'page-description'},'ChatGPT plan limits and local Codex usage, kept separate and accurately sourced.')),
    h('div',{className:'top-actions'},h('span',{className:'tag '+(state==='connected'?'ok':'')},(quota&&quota.plan?quota.plan.toUpperCase()+' · ':'')+statusLabel),h('button',{className:'button primary',type:'button',onClick:()=>this.refresh(),disabled:this.state.refreshing},this.state.refreshing?'Refreshing…':'↻ Refresh')));
   const filters=data?h('div',{className:'filters'},selectField('Period',f.period,rangeOptions(),v=>this.setFilters({period:v})),
    selectField('Recorded ID',f.session,[{value:'',label:'All usage groups'}].concat((data.options.sessions||[]).map(x=>({value:x.id,label:x.label}))),v=>this.setFilters({session:v})),
    selectField('Model',f.model,[{value:'',label:'All models'}].concat(data.options.models.map(x=>({value:x,label:x}))),v=>this.setFilters({model:v})),
    selectField('Project',f.project,[{value:'',label:'All projects'}].concat(data.options.projects.map(x=>({value:x,label:projectName(x)}))),v=>this.setFilters({project:v})),
    f.period==='custom'?dateField('From',f.startDate,v=>this.setFilters({startDate:v})):null,
    f.period==='custom'?dateField('To',f.endDate,v=>this.setFilters({endDate:v})):null,
    h('div',{className:'filters-end'},h('button',{type:'button',className:'button',onClick:()=>this.setFilters(initialFilters)},'Clear filters'))):null;
   const totals=data&&data.total;
   const metrics=totals&&h('div',{className:'metric-grid'},h(Metric,{label:'Usage groups',value:data.sessionCount,caption:'Distinct recorded IDs; not conversation count',color:palette.used}),h(Metric,{label:'Input tokens',value:totals.inputTokens,caption:'Includes cached input',color:palette.input}),h(Metric,{label:'Output tokens',value:totals.outputTokens,caption:'Total generated',color:palette.output}),h(Metric,{label:'Cached input',value:totals.cachedInputTokens,caption:totals.inputTokens?`${(totals.cachedInputTokens/totals.inputTokens*100).toFixed(1)}% of input`: 'No input data',color:palette.cached}),h(Metric,{label:'Uncached input',value:Math.max(0,totals.inputTokens-totals.cachedInputTokens),caption:'Derived from observed counters',color:palette.input}),h(Metric,{label:'Reasoning output',value:totals.reasoningOutputTokens,caption:'Included in output when reported',color:palette.used}));
   const buckets=quota&&quota.buckets||[];const mainBucket=buckets.find(b=>b.windows.some(w=>w.durationMinutes===300))||buckets[0];
   const quotaCards=mainBucket?h('div',{className:'quota-grid'},mainBucket.windows.map(w=>h(QuotaCard,{key:w.kind,title:w.durationMinutes===300?'5-hour limit':w.durationMinutes===10080?'7-day limit':`${w.durationMinutes||'?'}-minute ${w.kind} limit`,window:w,stale:state==='stale'}))):h(Empty,{title:'Quota data not available',description:state==='signed-out'?'Sign in with ChatGPT using the button below.':(quota&&quota.message)||'Refresh or check your Codex CLI connection.'});
   const additional=buckets.filter(b=>b!==mainBucket);
   const additionalCards=additional.map(bucket=>h('div',{key:bucket.id},
    h(SectionHeading,{title:bucket.name+(bucket.model?' · '+bucket.model:'')}),
    h('div',{className:'quota-grid'},bucket.windows.map(w=>h(QuotaCard,{key:w.kind,window:w,stale:state==='stale',title:w.durationMinutes===300?'5-hour limit':w.durationMinutes===10080?'7-day limit':`${w.durationMinutes||'?'}-minute limit`})))));
   const quotaContent=h('section',null,
    h(SectionHeading,{title:'ChatGPT plan quotas',right:quota&&quota.fetchedAt?'Updated '+date(quota.fetchedAt):'Waiting for quota data'}),
    quotaCards,additionalCards,state==='stale'?h('div',{className:'notice alert'},quota.message||'Quota data is stale. The displayed values are the last successful sample.'):null,
    state==='signed-out'?h('button',{className:'button primary',onClick:()=>vscode.postMessage({command:'login'}),type:'button'},'Continue with ChatGPT'):null,
    quota&&quota.ordinaryUsageAllowed===false?h('div',{className:'notice alert'},'Your current Codex rate limit reports that ordinary usage is blocked. Watch the reset countdown.'):null);
   const tokenContent=data&&h('section',null,h(SectionHeading,{title:'Local token analytics',right:`${fmt(data.eventCount)} usage events · ${fmt(data.sessionCount)} recorded IDs`}),h(HistoricalIntegrity,{summary:snap.historicalIntegrity}),metrics,
    h('div',{className:'notice'},'Token totals come from local Codex session JSONL events. Cached input tokens are included in input tokens. Neither these values nor API billing determine ChatGPT plan quota percentages.'),
    h(SectionHeading,{title:'Observed activity over time',right:'UTC time buckets · real session events'}),h('div',{className:'chart-layout'},
     h('div',{className:'panel chart-panel'},h('div',{className:'chart-title'},'Token counters over time'),h('p',{className:'chart-description'},'Only time buckets with recorded events are plotted; missing periods are not estimated.'),h(Chart,{points:data.timeSeries,type:'tokens',period:f.period})),
     h(BreakdownPanel,{title:'Top models',items:data.models,mode:'models'})));
   const history=h('section',null,h(SectionHeading,{title:'Quota history',right:`${snap?snap.storageMode:'—'} storage · last 30 days retained in view`}),
    h('div',{className:'chart-layout'},h(QuotaHistoryPanel,{histories:snap&&snap.histories||[],quota,range:this.state.quotaRange,changeRange:r=>this.remember({quotaRange:r}),windowMinutes:this.state.quotaWindow,changeWindow:w=>this.remember({quotaWindow:w})}),
     h(BreakdownPanel,{title:'Top projects',items:data&&data.projects||[],mode:'projects'})),
    h('p',{className:'muted small'},'Quota samples are captured during successful refreshes only. No historical quota data is reconstructed from local tokens.'));
   const selected=data&&data.sessionRows.find(s=>s.id===this.state.selectedSession);
   const sessionContent=data&&h('section',null,h(SectionHeading,{title:'Usage groups',right:`Showing ${fmt(data.sessionRows.length)} of ${fmt(data.sessionCount)} matching recorded IDs · latest activity first`}),h(SessionTable,{rows:data.sessionRows,selected:this.state.selectedSession,onSelect:id=>this.setState({selectedSession:id})}),selected?h('div',{className:'panel',style:{marginTop:16}},h('div',{className:'chart-title'},'Selected recorded ID'),h('p',{className:'monospace'},selected.id),h('p',null,'Project: ',projectName(selected.project),' · Model: ',selected.model||'Unknown',' · Started: ',date(selected.startedAt)),h('p',null,`${fmt(selected.events)} events · ${fmt(selected.inputTokens)} input · ${fmt(selected.outputTokens)} output · ${fmt(selected.cachedInputTokens)} cached · ${fmt(selected.reasoningOutputTokens)} reasoning`)):null);
   const projectsContent=data&&h('section',null,h(SectionHeading,{title:'Projects',right:'From observed cwd metadata'}),h(BreakdownPanel,{title:'Token use by project',items:data.projects,mode:'projects'}));
   const body=this.state.page==='overview'?h('div',null,quotaContent,tokenContent,history,sessionContent):this.state.page==='quotas'?h('div',null,quotaContent,history):this.state.page==='tokens'?tokenContent:this.state.page==='projects'?projectsContent:h('div',null,tokenContent,sessionContent);
   return h('div',{className:'app'},sidebar,h('main',{className:'main'},header,filters,data?body:h(Empty,{title:'Loading local analytics…',description:'Codex Insights is scanning session logs and querying App Server.'}),snap&&snap.storageWarning?h('div',{className:'notice alert'},snap.storageWarning):null,data&&data.scanNotice?h('div',{className:'notice alert'},data.scanNotice):null,data&&data.warnings.length?h('div',{className:'notice alert'},`${fmt(data.warnings.length)} ingestion warning${data.warnings.length===1?'':'s'}. Counts may be incomplete.`):null,h('div',{className:'footer'},`Codex Insights v${extensionVersion} · No custom telemetry · Credentials managed by Codex CLI · Historical quota data is captured from the moment monitoring starts.`,h('div',null,data?`Last local scan: ${date(data.scannedAt)} · ${fmt(data.filesScanned)} files scanned`:''))));
  }
 }
 createRoot(document.getElementById('root')).render(h(App));
})();
