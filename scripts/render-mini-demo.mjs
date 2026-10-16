import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd(),temporary=await mkdtemp(path.join(tmpdir(),'codex-mini-demo-'));
const asset=path.join(root,'docs/assets');
const css=pathToFileURL(path.join(root,'media/mini-panel.css')).href,bundle=pathToFileURL(path.join(root,'media/mini-panel.js')).href;
const scenarios=[
 {name:'dark-normal',theme:'vscode-dark',level:'normal',stateLabel:'Connected',five:44,week:41},
 {name:'light-normal',theme:'vscode-light',level:'normal',stateLabel:'Connected',five:44,week:41},
 {name:'dark-critical',theme:'vscode-dark',level:'critical',stateLabel:'Quota critical',five:97,week:41},
 {name:'dark-stale',theme:'vscode-dark',level:'stale',stateLabel:'Last known data · connection unavailable',five:44,week:41},
];
try{
 await mkdir(asset,{recursive:true});
 for(const scenario of scenarios){
  const now=Date.now(),snapshot={type:'summary/update',level:scenario.level,stateLabel:scenario.stateLabel,plan:'PLUS',fetchedAt:new Date(now-(scenario.level==='stale'?22*60_000:12_000)).toISOString(),windows:[
   {id:'demo:primary:0',label:'5-hour quota',durationMinutes:300,usedPercent:scenario.five,availablePercent:100-scenario.five,resetAt:new Date(now+4*3600_000+19*60_000).toISOString()},
   {id:'demo:secondary:1',label:'Weekly quota',durationMinutes:10080,usedPercent:scenario.week,availablePercent:100-scenario.week,resetAt:new Date(now+5*86400_000+19*3600_000).toISOString()},
  ],tokens:{input:146_600_000,output:716_300,cachedInput:142_800_000,cachePercent:142_800_000/146_600_000*100,sessions:149,lastModel:'gpt-demo'}};
  const html=`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><style>body:after{content:'SYNTHETIC DEMO DATA';position:fixed;right:12px;bottom:10px;color:var(--quick-muted);font:700 10px system-ui;letter-spacing:.8px}</style></head><body class="${scenario.theme}"><div id="root"></div><script>window.acquireVsCodeApi=()=>({postMessage:()=>{}});</script><script src="${bundle}"></script><script>setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(snapshot)}})),80);</script></body></html>`;
  const page=path.join(temporary,`${scenario.name}.html`),output=path.join(asset,`mini-${scenario.name}.png`);
  await writeFile(page,html);
  const result=spawnSync(process.env.CHROMIUM_PATH||'chromium',['--headless','--no-sandbox','--disable-gpu','--hide-scrollbars','--virtual-time-budget=1500','--window-size=760,700',`--screenshot=${output}`,pathToFileURL(page).href],{encoding:'utf8',timeout:30000});
  if(result.status!==0)throw new Error(`Chromium screenshot failed: ${(result.stderr||result.stdout).trim()}`);
  console.log(output);
 }
}finally{await rm(temporary,{recursive:true,force:true});}
