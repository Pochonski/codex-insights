import React from 'react';
import {createRoot} from 'react-dom/client';
import {isMiniOutbound} from '../core/mini-messages';
import {compactNumber,resetLabel,updatedLabel} from '../extension/status-summary';

const h=React.createElement;
const vscode=acquireVsCodeApi();
const paths={dashboard:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',refresh:'M20 7v5h-5M4 17v-5h5M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2',copy:'M8 8h12v12H8zM4 16H3V3h13v1'};
function Icon({name}){return h('svg',{viewBox:'0 0 24 24',width:17,height:17,fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]}));}
function QuotaCard({window:quota,stale,now}){
 const used=Math.max(0,Math.min(100,quota.usedPercent));
 const tone=used>=100?'exhausted':used>=95?'critical':used>=80?'warning':'normal';
 const date=quota.resetAt?new Date(quota.resetAt).toLocaleString():undefined;
 return h('article',{className:`quota-card tone-${tone}${stale?' is-stale':''}`,key:quota.id},
  h('div',{className:'quota-top'},h('span',{className:'quota-name'},quota.label),stale?h('span',{className:'quota-flag'},'Last known'):null),
  h('div',{className:'quota-value'},`${Math.round(used)}%`,h('span',null,' used')),
  h('div',{className:'progress',role:'progressbar','aria-label':`${quota.label} used`,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':Math.round(used)},h('span',{className:'progress-fill',style:{width:`${used}%`}})),
  h('div',{className:'quota-detail'},h('span',null,`${Math.round(quota.availablePercent)}% available`),h('span',{className:'reset',title:date},resetLabel(quota.resetAt,now))));
}
function Metric({label,value}){return h('div',{className:'metric'},h('span',{className:'metric-label'},label),h('strong',null,value));}
function App(){
 const [snapshot,setSnapshot]=React.useState(null),[now,setNow]=React.useState(Date.now()),[refreshing,setRefreshing]=React.useState(false),[notice,setNotice]=React.useState('');
 const refreshTimeout=React.useRef(null),noticeTimeout=React.useRef(null);
 React.useEffect(()=>{
  const onMessage=(event)=>{if(!isMiniOutbound(event.data))return;const msg=event.data;if(msg.type==='summary/update')setSnapshot(msg);else if(msg.type==='summary/refreshDone'){setRefreshing(false);clearTimeout(refreshTimeout.current);}else{setNotice(msg.message);clearTimeout(noticeTimeout.current);noticeTimeout.current=setTimeout(()=>setNotice(''),4000);}};
  window.addEventListener('message',onMessage);vscode.postMessage({type:'mini/ready'});
  const timer=setInterval(()=>setNow(Date.now()),15_000);
  return()=>{window.removeEventListener('message',onMessage);clearInterval(timer);clearTimeout(refreshTimeout.current);clearTimeout(noticeTimeout.current);};
 },[]);
 const refresh=()=>{if(refreshing)return;setRefreshing(true);vscode.postMessage({type:'mini/refresh'});refreshTimeout.current=setTimeout(()=>{setRefreshing(false);setNotice('Refresh is taking longer than expected.');},20_000);};
 const level=snapshot?.level||'loading',stale=['stale','offline','error'].includes(level);
 const badgeLabel=({normal:'Connected',warning:'Warning',critical:'Critical',exhausted:'Exhausted',offline:'Offline',stale:'Stale',authentication_required:'Sign in',loading:'Loading',error:'Error'})[level]||'Unavailable';
 const tokens=snapshot?.tokens;
 const plan=snapshot?.plan?`ChatGPT ${/^(plus|pro|free|team|business|enterprise)$/i.test(snapshot.plan)?snapshot.plan[0].toUpperCase()+snapshot.plan.slice(1).toLowerCase():snapshot.plan}`:'ChatGPT plan unavailable';
 const cacheText=!tokens||tokens.cachePercent===null?'No input data':`${compactNumber(tokens.cachedInput)} · ${tokens.cachePercent.toFixed(1)}% of input`;
 return h('main',{className:'quick-shell'},h('section',{className:'quick-card','aria-label':'Codex Insights quick monitor'},
  h('header',{className:'header'},h('div',{className:'identity'},h('div',{className:'product-mark','aria-hidden':true},h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round'},h('rect',{x:3,y:4,width:18,height:16,rx:4}),h('path',{d:'M6.5 14h3l2-4 2 6 2-4h2'}))),h('div',null,h('h1',null,'Codex Insights'),h('div',{className:'overline'},'QUICK MONITOR'))),h('span',{className:`live-badge state-${level}`},h('span',{className:'badge-dot'}),badgeLabel)),
  h('div',{className:'meta'},h('span',null,plan),h('span',null,updatedLabel(snapshot?.fetchedAt||null,now))),
  stale?h('div',{className:'state-notice',role:'status'},snapshot?.stateLabel||'Connection unavailable',' · Quotas below are last known values.'):level==='authentication_required'?h('div',{className:'state-notice',role:'status'},'Sign in with Codex CLI to see ChatGPT quotas.'):level==='loading'?h('div',{className:'state-notice',role:'status'},'Waiting for the first quota sample…'):null,
  h('div',{className:'divider'}),
  snapshot?.windows.length?h('section',{className:'quota-grid','aria-label':'ChatGPT plan quotas'},snapshot.windows.map(window=>h(QuotaCard,{key:window.id,window,stale,now}))):h('div',{className:'empty-quotas',role:'status'},snapshot?'No ChatGPT quota windows are available.':'Loading quota windows…'),
  h('section',{className:'activity','aria-label':'Local token activity'},h('div',{className:'section-title'},h('h2',null,'Local activity'),h('span',null,'All recorded history')),
   h('div',{className:'metric-grid'},h(Metric,{label:'INPUT',value:tokens?compactNumber(tokens.input):'—'}),h(Metric,{label:'OUTPUT',value:tokens?compactNumber(tokens.output):'—'}),h(Metric,{label:'SESSIONS',value:tokens?compactNumber(tokens.sessions):'—'})),
   h('div',{className:'cache-row'},h('span',null,'Cached input'),h('strong',null,tokens?cacheText:'—')),
   tokens?.lastModel?h('div',{className:'model-row'},h('span',null,'Last observed model'),h('strong',{title:tokens.lastModel},tokens.lastModel)):null,
   tokens&&tokens.sessions===0?h('p',{className:'empty-activity'},'No local Codex sessions recorded yet.'):null),
  notice?h('div',{className:'toast',role:'status'},notice):null,
  h('footer',{className:'actions'},
   h('button',{type:'button',title:'Open full dashboard',onClick:()=>vscode.postMessage({type:'mini/openDashboard'})},h(Icon,{name:'dashboard'}),h('span',null,'Dashboard')),
   h('button',{type:'button',title:'Refresh quotas and local sessions',disabled:refreshing,onClick:refresh},h(Icon,{name:'refresh'}),h('span',null,refreshing?'Refreshing…':'Refresh')),
   h('button',{type:'button',title:'Copy a plain-text status summary',onClick:()=>vscode.postMessage({type:'mini/copySummary'})},h(Icon,{name:'copy'}),h('span',null,'Copy')))));
}

createRoot(document.getElementById('root')).render(h(App));
