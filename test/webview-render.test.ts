import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {buildSync} from 'esbuild';
const bundle=buildSync({entryPoints:['src/webview/dashboard.js'],bundle:true,platform:'browser',format:'iife',target:'es2020',write:false}).outputFiles[0].text;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
describe('compiled React dashboard',()=>{
 it('boots, receives a snapshot, and renders actual quota windows and navigation',async()=>{
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://example.invalid',runScripts:'outside-only',pretendToBeVisual:true});
  const messages:unknown[]=[];(dom.window as unknown as {acquireVsCodeApi:()=>unknown}).acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:(value:unknown)=>messages.push(value)});
  try{dom.window.eval(bundle);await wait(50);expect(messages).toContainEqual(expect.objectContaining({command:'ready'}));
   const analytics={options:{sessions:[],models:[],projects:[]},total:{inputTokens:100,outputTokens:20,cachedInputTokens:50,reasoningOutputTokens:5},eventCount:1,sessionCount:1,timeSeries:[],models:[],projects:[],sessionRows:[],scannedAt:'2026-10-15T12:00:00Z',filesScanned:1,warnings:[]};
   const quota={state:'connected',plan:'plus',fetchedAt:'2026-10-15T12:00:00Z',ordinaryUsageAllowed:true,buckets:[{id:'codex',name:'Codex',model:null,windows:[{kind:'primary',durationMinutes:300,usedPercent:5,resetAt:'2026-10-15T14:00:00Z'},{kind:'secondary',durationMinutes:10080,usedPercent:16,resetAt:'2026-10-20T12:00:00Z'}]}]};
   dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'snapshot',analytics,quota,histories:[],storageMode:'sqlite'}}));await wait(80);
   const text=dom.window.document.body.textContent||'';expect(text).toContain('5-hour limit');expect(text).toContain('7-day limit');expect(text).toContain('Tokens');expect(text).toContain('Projects');expect(text).toContain('100');
  }finally{dom.window.close();}
 },5000);
});
