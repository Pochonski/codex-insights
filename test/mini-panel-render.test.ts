import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {buildSync} from 'esbuild';

const bundle=buildSync({entryPoints:['src/webview/mini-panel.js'],bundle:true,platform:'browser',format:'iife',target:'es2020',write:false}).outputFiles[0].text;
async function waitFor(predicate:()=>boolean,description:string):Promise<void>{
 const deadline=Date.now()+2000;
 while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw new Error(`Timed out waiting for ${description}`);
}

describe('compiled React mini panel',()=>{
 it('mounts, renders real quota progress, and sends only fixed action messages',async()=>{
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://example.invalid',runScripts:'outside-only',pretendToBeVisual:true});
  const messages:unknown[]=[];
  (dom.window as unknown as {acquireVsCodeApi:()=>unknown}).acquireVsCodeApi=()=>({postMessage:(value:unknown)=>messages.push(value)});
  try{
   dom.window.eval(bundle);await waitFor(()=>messages.some(message=>(message as {type?:string}).type==='mini/ready'),'React ready message');
   expect(messages).toContainEqual({type:'mini/ready'});
   const summary={type:'summary/update',level:'normal',stateLabel:'Connected',plan:'Plus',fetchedAt:'2026-10-15T12:00:00Z',windows:[{id:'5h',label:'5-hour quota',durationMinutes:300,usedPercent:44,availablePercent:56,resetAt:'2026-10-15T16:19:00Z'},{id:'7d',label:'Weekly quota',durationMinutes:10080,usedPercent:41,availablePercent:59,resetAt:'2026-10-20T12:00:00Z'}],tokens:{input:146_600_000,output:716_000,cachedInput:142_800_000,cachePercent:97.4,sessions:149,lastModel:'gpt-6-sol'}};
   dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:summary}));await waitFor(()=>!!dom.window.document.body.textContent?.includes('5-hour quota'),'quota render');
   const body=dom.window.document.body;
   expect(body.textContent).toContain('5-hour quota');
   expect(body.textContent).toContain('Weekly quota');
   expect(body.textContent).toContain('44%');
   expect(body.textContent).toContain('146.6M');
   expect(body.textContent).toContain('RECORDED GROUPS');
   expect(body.textContent).not.toContain('SESSIONS');
   expect(body.textContent).toContain('97.4% of input');
   expect(body.textContent).toContain('gpt-6-sol');
   const bars=body.querySelectorAll('[role="progressbar"]');
   expect(bars).toHaveLength(2);
   expect(bars[0].getAttribute('aria-valuenow')).toBe('44');
   expect(bars[1].getAttribute('aria-valuenow')).toBe('41');
   const buttons=[...body.querySelectorAll('button')];
   expect(buttons.map(button=>button.textContent)).toEqual(['Dashboard','Refresh','Copy']);
   buttons.forEach(button=>button.click());await waitFor(()=>messages.some(message=>(message as {type?:string}).type==='mini/copySummary'),'action messages');
   expect(messages).toContainEqual({type:'mini/openDashboard'});
   expect(messages).toContainEqual({type:'mini/refresh'});
   expect(messages).toContainEqual({type:'mini/copySummary'});
   expect(buttons[1].disabled).toBe(true);
   dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'summary/refreshDone'}}));await waitFor(()=>!buttons[1].disabled,'refresh completion');
   expect(buttons[1].disabled).toBe(false);
   dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{...summary,level:'stale',stateLabel:'Quota data is stale'}}));await waitFor(()=>!!body.textContent?.includes('last known values'),'stale notice');
   expect(body.textContent).toContain('last known values');
  }finally{dom.window.close();}
 },5000);
});
