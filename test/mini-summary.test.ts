import {describe,it,expect} from 'vitest';
import {aggregate} from '../src/analytics/aggregate';
import {buildMiniSummary} from '../src/extension/mini-summary';
import {parseMiniMessage,isMiniOutbound} from '../src/core/mini-messages';
import type {QuotaStatus} from '../src/providers/quotas';

const now=Date.parse('2026-10-16T12:00:00Z');
const data=aggregate([{id:'event',sessionId:'demo',timestamp:'2026-10-16T11:00:00Z',model:'gpt-demo',inputTokens:100,outputTokens:20,cachedInputTokens:80,reasoningOutputTokens:5,sourceFile:'synthetic.jsonl'}]);
const quota:QuotaStatus={state:'connected',plan:'PLUS',fetchedAt:'2026-10-16T11:59:50Z',message:null,ordinaryUsageAllowed:true,buckets:[{id:'codex',name:'Codex',model:null,windows:[{kind:'primary',durationMinutes:300,usedPercent:44,resetAt:'2026-10-16T16:00:00Z'},{kind:'secondary',durationMinutes:10080,usedPercent:41,resetAt:'2026-10-21T12:00:00Z'}]}]};

describe('Mini Panel snapshot and protocol',()=>{
 it('uses the same official quota and local token aggregate as the native hover',()=>{
  const summary=buildMiniSummary(quota,data,now);
  expect(summary.level).toBe('normal');expect(summary.windows.map(w=>w.label)).toEqual(['5-hour quota','Weekly quota']);
  expect(summary.windows[0]).toMatchObject({usedPercent:44,availablePercent:56});
  expect(summary.tokens).toEqual({input:100,output:20,cachedInput:80,cachePercent:80,sessions:1,lastModel:'gpt-demo'});
  expect(JSON.stringify(summary)).not.toContain('synthetic.jsonl');
  expect(isMiniOutbound(summary)).toBe(true);
 });
 it('handles extra windows, missing windows and out-of-range values',()=>{
  const multi:QuotaStatus={...quota,buckets:[...quota.buckets,{id:'extra',name:'Other',model:null,windows:[{kind:'primary',durationMinutes:60,usedPercent:130,resetAt:'invalid'}]}]};
  const summary=buildMiniSummary(multi,data,now);
  expect(summary.windows).toHaveLength(3);
  expect(summary.windows[2]).toMatchObject({usedPercent:100,availablePercent:0,resetAt:null});
  expect(summary.windows[2].label).toContain('1-hour quota');
  expect(buildMiniSummary({...quota,buckets:[]},aggregate([]),now).tokens.cachePercent).toBeNull();
 });
 it('preserves stale meaning for the same sample without inventing new quotas',()=>{
  const summary=buildMiniSummary({...quota,state:'stale'},data,now);
  expect(summary.level).toBe('stale');expect(summary.windows[0].usedPercent).toBe(44);
 });
 it('accepts only exact action messages and validates outgoing snapshots',()=>{
  expect(parseMiniMessage({type:'mini/ready'})).toEqual({type:'mini/ready'});
  expect(parseMiniMessage({type:'mini/refresh',command:'workbench.action.files.openFile'})).toBeNull();
  expect(parseMiniMessage({type:'workbench.action.files.openFile'})).toBeNull();
  expect(parseMiniMessage({type:'mini/openDashboard'})).toEqual({type:'mini/openDashboard'});
  expect(isMiniOutbound({...buildMiniSummary(quota,data,now),windows:[{usedPercent:Number.NaN}]})).toBe(false);
  expect(isMiniOutbound({type:'summary/error',message:'temporary'})).toBe(true);
 });
});
