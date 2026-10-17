import {describe,it,expect} from 'vitest';
import {aggregate} from '../src/analytics/aggregate';
import {emptyQuota,staleQuota,type QuotaStatus} from '../src/providers/quotas';
import {compactNumber,formatStatus,progressImage,resetLabel,STATUS_COMMANDS} from '../src/extension/status-summary';

const now=Date.parse('2026-10-16T12:00:00.000Z');
const data=aggregate([{id:'one',sessionId:'s1',timestamp:'2026-10-16T11:00:00.000Z',model:'gpt-6-sol',inputTokens:1_200_000,outputTokens:24_500,cachedInputTokens:1_100_000,reasoningOutputTokens:5_000,sourceFile:'fixture.jsonl'}]);
const settings={compact:false,showWeeklyQuota:true};
const connected=(five=68,week=16):QuotaStatus=>({state:'connected',plan:'PLUS',buckets:[{id:'codex',name:'Codex',model:null,windows:[{kind:'primary',durationMinutes:300,usedPercent:five,resetAt:'2026-10-16T13:24:00.000Z'},{kind:'secondary',durationMinutes:10080,usedPercent:week,resetAt:'2026-10-23T07:00:00.000Z'}]}],ordinaryUsageAllowed:true,fetchedAt:'2026-10-16T11:59:48.000Z',message:null,connectionState:'connected'});

describe('native status summary',()=>{
 it('renders real quota semantics, reset times and historical tokens',()=>{
  const p=formatStatus(connected(),data,settings,now);
  expect(p.text).toBe('$(pulse) Codex · 5h 68% · 7d 16%');
  expect(p.markdown).toContain('5-HOUR LIMIT · 68% used');
  expect(p.markdown).toContain('32% available');
  expect(p.markdown).toContain('Resets in 1h 24m');
  expect(p.markdown.match(/data:image\/svg\+xml;base64,/g)).toHaveLength(2);
  expect(p.markdown).toContain('Local activity');
  expect(p.markdown).toContain('Input 1.2M · Output 24.5K');
  expect(p.plainText).toContain('Recorded usage groups 1 · Cached input 1.1M');
  expect(p.markdown).not.toContain('1 conversation');
  expect(p.plainText).toContain('Last observed model: gpt-6-sol');
  expect(p.plainText).toContain('Generated: 2026-10-16T12:00:00.000Z');
  expect(p.plainText).not.toContain('1.1M · Input');
 });
 it('labels a legacy tool-item ID as a recorded usage group, not a conversation',()=>{
  const legacy=aggregate([{id:'legacy',sessionId:'ctco_synthetic',timestamp:'2026-10-16T11:00:00.000Z',inputTokens:120,outputTokens:12,cachedInputTokens:100,reasoningOutputTokens:2,sourceFile:'fixture.jsonl'}]);
  const summary=formatStatus(connected(),legacy,settings,now);
  expect(summary.markdown).toContain('Recorded usage groups 1');
  expect(summary.plainText).toContain('Recorded usage groups 1');
  expect(summary.markdown).not.toContain('conversation');
  expect(summary.plainText).toContain('Input 120 · Output 12');
 });
 it('supports compact and weekly visibility settings',()=>{
  expect(formatStatus(connected(),data,{compact:true,showWeeklyQuota:true},now).text).toBe('$(pulse) Codex · 68% · 16%');
  const hidden=formatStatus(connected(),data,{compact:false,showWeeklyQuota:false},now);
  expect(hidden.text).not.toContain('7d');expect(hidden.markdown).not.toContain('7-day limit');
 });
 it('classifies warning, critical and exhausted without color dependence',()=>{
  expect(formatStatus(connected(80),data,settings,now).level).toBe('warning');
  expect(formatStatus(connected(80),data,settings,now).text).toContain('$(warning)');
  expect(formatStatus(connected(95),data,settings,now).level).toBe('critical');
  expect(formatStatus(connected(100),data,settings,now).level).toBe('exhausted');
  expect(formatStatus(connected(10,100),data,settings,now).level).toBe('exhausted');
 });
 it('labels stale and offline data without presenting it as current',()=>{
  const stale=formatStatus(staleQuota(connected(),'offline'),data,settings,now);
  expect(stale.level).toBe('stale');expect(stale.text).toContain('Stale');expect(stale.markdown).toContain('last known');
  expect(stale.plainText).toContain('last known');
  const overdue=formatStatus({...connected(),fetchedAt:'2026-10-16T11:00:00.000Z'},data,settings,now);
  expect(overdue.level).toBe('stale');
  expect(formatStatus({...emptyQuota('error'),connectionState:'offline'},data,settings,now).level).toBe('offline');
  expect(formatStatus(emptyQuota('error'),data,settings,now).text).toContain('Error');
 });
 it('handles loading, authentication and missing quotas',()=>{
  expect(formatStatus(emptyQuota(),data,settings,now).level).toBe('loading');
  expect(formatStatus(emptyQuota('signed-out'),data,settings,now).level).toBe('authentication_required');
  expect(formatStatus(emptyQuota('api-key'),data,settings,now).markdown).toContain('ChatGPT quotas unavailable');
  const missing=formatStatus({...connected(),buckets:[]},data,settings,now);
  expect(missing.text).toBe('$(pulse) Codex');
 });
 it('bounds invalid percentages and timestamps',()=>{
  const high=formatStatus(connected(140,-3),data,settings,now);
  expect(high.markdown).toContain('5-HOUR LIMIT · 100% used');
  expect(high.markdown).toContain('0% available');
  expect(high.markdown).toContain('7-DAY LIMIT · 0% used');
  expect(high.markdown).toContain('100% available');
  const invalid=connected();invalid.buckets[0].windows[0].usedPercent=Number.NaN;
  invalid.buckets[0].windows[1].resetAt='not-a-date';
  const p=formatStatus(invalid,data,settings,now);
  expect(p.markdown).not.toContain('NaN');expect(p.markdown).toContain('Reset time unavailable');
  expect(resetLabel('2026-10-16T11:59:59.000Z',now)).toContain('awaiting confirmation');
  expect(compactNumber(Number.NaN)).toBe('—');
 });
 it('escapes untrusted labels and keeps only fixed command URIs',()=>{
  const q={...connected(),plan:'PLUS [x](command:evil)'};
  const p=formatStatus(q,data,settings,now);
  expect(p.markdown).not.toContain('[x](command:evil)');
  expect(p.markdown).toContain('[Dashboard](command:codexInsights.openDashboard)');
  expect(p.markdown).not.toContain('command:codexInsights.openMiniPanel');
  expect(STATUS_COMMANDS).toEqual(['codexInsights.openDashboard','codexInsights.refresh','codexInsights.copySummary']);
 });
 it('renders bounded, theme-aware SVG progress without embedding account data',()=>{
  const decode=(uri:string)=>Buffer.from(uri.split(',')[1],'base64').toString('utf8');
  const dark=decode(progressImage(44,'dark'));
  const light=decode(progressImage(44,'light'));
  const critical=decode(progressImage(97,'dark'));
  const contrast=decode(progressImage(44,'hcDark'));
  expect(dark).toContain('width="140.8"');
  expect(dark).toContain('#52c69b');
  expect(light).toContain('#087b5b');
  expect(critical).toContain('#d64c59');
  expect(contrast).toContain('stroke="#ffffff"');
  expect(decode(progressImage(140,'dark'))).toContain('width="318"');
  expect(decode(progressImage(Number.NaN,'dark'))).not.toContain('NaN');
 });
});
