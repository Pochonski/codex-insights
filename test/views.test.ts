import {describe,it,expect} from 'vitest';
import {aggregate} from '../src/analytics/aggregate';
import {buildAnalyticsView} from '../src/analytics/views';
import type {UsageEvent} from '../src/core/types';
const now=Date.parse('2026-10-15T12:00:00Z');
const event=(id:string,sessionId:string,model:string,project:string,timestamp:string,inputTokens:number):UsageEvent=>({id,sessionId,model,project,timestamp,inputTokens,outputTokens:10,cachedInputTokens:Math.floor(inputTokens/2),reasoningOutputTokens:2,sourceFile:id});
const data=aggregate([event('1','a','m1','/p/a','2026-10-15T11:00:00Z',100),event('2','b','m2','/p/b','2026-10-15T10:00:00Z',200),event('3','a','m2','/p/a','2026-10-01T10:00:00Z',300)]);
describe('combined analytics filters',()=>{
 it('combines period, session, model, and project without changing source totals',()=>{const view=buildAnalyticsView(data,{period:'24h',session:'a',model:'m1',project:'/p/a'},now);expect(view.total.inputTokens).toBe(100);expect(view.eventCount).toBe(1);expect(data.total.inputTokens).toBe(600);});
 it('never shows a different session for a stale selection',()=>{const view=buildAnalyticsView(data,{period:'all',session:'missing'},now);expect(view.eventCount).toBe(0);expect(view.selectedFilterValid).toBe(false);});
 it('keeps cache and reasoning as subsets',()=>{const view=buildAnalyticsView(data,{period:'all'},now);expect(view.total).toMatchObject({inputTokens:600,outputTokens:30,cachedInputTokens:300,reasoningOutputTokens:6});});
 it('applies an inclusive custom calendar range with the other filters',()=>{const view=buildAnalyticsView(data,{period:'custom',startDate:'2026-10-15',endDate:'2026-10-15',session:'a',model:'m1',project:'/p/a'},now);expect(view.eventCount).toBe(1);expect(view.total.inputTokens).toBe(100);});
 it('returns an empty view for an inverted custom range',()=>{const view=buildAnalyticsView(data,{period:'custom',startDate:'2026-10-16',endDate:'2026-10-15'},now);expect(view.eventCount).toBe(0);expect(view.selectedFilterValid).toBe(false);});
 it('keeps a recently active low-token usage group visible beyond the 250-row limit',()=>{
  const older=Array.from({length:260},(_,i)=>event(`old-${i}`,`old-${i}`,'m1','/p/a','2026-10-15T09:00:00Z',100000));
  const recent=event('recent','canonical-recent','m1','/p/a','2026-10-15T11:30:00Z',10);
  const view=buildAnalyticsView(aggregate([...older,recent]),{period:'all'},now);
  expect(view.sessionCount).toBe(261);
  expect(view.total.inputTokens).toBe(26000010);
  expect(view.sessionRows).toHaveLength(250);
  expect(view.sessionRows[0].id).toBe('canonical-recent');
  expect(view.options.sessions[0].id).toBe('canonical-recent');
 });
});
