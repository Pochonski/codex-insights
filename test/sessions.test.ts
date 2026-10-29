import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {parseSession,parseSessionDetailed} from '../src/collectors/sessions';
import {aggregate} from '../src/analytics/aggregate';
describe('Codex token collector',()=>{
 it('keeps usage with session_meta when tool outputs and messages have their own IDs',()=>{
  const usage=(n:number)=>JSON.stringify({timestamp:'2026-10-15T00:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:n/5,cached_input_tokens:n/2,reasoning_output_tokens:n/10}}}});
  const content=[
   JSON.stringify({type:'session_meta',payload:{id:'conversation-1',session_id:'conversation-1',thread_source:'user'}}),
   JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',id:'ctco_synthetic',output:[]}}),usage(100),
   JSON.stringify({type:'response_item',payload:{type:'function_call_output',id:'fco_synthetic'}}),usage(150),
   JSON.stringify({type:'response_item',payload:{type:'message',id:'msg_synthetic'}}),usage(200),
  ].join('\n');
  const events=parseSession(content,'synthetic.jsonl');
  expect(events.map(event=>event.sessionId)).toEqual(['conversation-1','conversation-1','conversation-1']);
  expect(aggregate(events).total).toEqual({inputTokens:200,outputTokens:40,cachedInputTokens:100,reasoningOutputTokens:20});
  expect(events[0].fingerprint).toBe(createHash('sha256').update('ctco_synthetic').update(':').update(usage(100)).digest('hex'));
 });
 it('does not treat an item ID as a session when metadata is absent',()=>{
  const content=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',id:'ctco_synthetic'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10}}}});
  const events=parseSession(content,'unidentified.jsonl');
  expect(events).toHaveLength(1);
  expect(events[0].sessionId).not.toBe('ctco_synthetic');
 });
 it('accepts an explicit session_id on a usage record without session_meta',()=>{
  const content=JSON.stringify({type:'event_msg',session_id:'explicit-session',payload:{type:'token_count',info:{total_token_usage:{input_tokens:12}}}});
  expect(parseSession(content,'explicit.jsonl')[0].sessionId).toBe('explicit-session');
 });
 it('calculates cumulative deltas without double counting',()=>{
  const record=(n:number)=>JSON.stringify({timestamp:'2026-10-15T00:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:n/2,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const events=parseSession([record(100),record(150),record(150)].join('\n'),'/tmp/test.jsonl');
  expect(events).toHaveLength(2);expect(aggregate(events).total.inputTokens).toBe(150);expect(aggregate(events).total.outputTokens).toBe(75);
 });
 it('ignores malformed and unrelated records',()=>{expect(parseSession('invalid\n{"type":"other"}','test.jsonl')).toEqual([]);});
 it('does not treat a turn-completed usage payload as another token_count observation',()=>{const content=JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100}}}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:100}});expect(aggregate(parseSession(content,'typed.jsonl')).total.inputTokens).toBe(100);});
 it('uses the typed token_count total instead of a conflicting generic usage map',()=>{const content=JSON.stringify({type:'event_msg',usage:{input_tokens:999},payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:5,cached_input_tokens:80,reasoning_output_tokens:2},last_token_usage:{input_tokens:100,output_tokens:5,cached_input_tokens:80,reasoning_output_tokens:2}}}});const total=aggregate(parseSession(content,'typed.jsonl')).total;expect(total.inputTokens).toBe(100);expect(total.cachedInputTokens).toBe(80);expect(total.outputTokens).toBe(5);expect(total.reasoningOutputTokens).toBe(2);});
 it('accepts a chronological counter reset without negative increments',()=>{
  const record=(at:string,n:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const events=parseSession([record('2026-10-15T10:00:00Z',100),record('2026-10-15T10:01:00Z',140),record('2026-10-15T10:02:00Z',20)].join('\n'),'reset.jsonl');
  expect(events.map(event=>event.inputTokens)).toEqual([100,40,20]);
 });
 it('skips ambiguous out-of-order decreases and reports malformed input',()=>{
  const record=(at:string,n:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const parsed=parseSessionDetailed([record('2026-10-15T10:00:00Z',100),'{"broken"',record('2026-10-15T09:59:00Z',10),record('2026-10-15T10:01:00Z',130)].join('\n'),'ordered.jsonl');
  expect(parsed.events.map(event=>event.inputTokens)).toEqual([100,30]);expect(parsed.warnings.join(' ')).toContain('invalid');expect(parsed.warnings.join(' ')).toContain('out-of-order');
 });
 it('retains a growing cumulative observation even when its timestamp moves backward',()=>{
  const record=(at:string,n:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const parsed=parseSessionDetailed([record('2026-10-15T10:00:00Z',100),record('2026-10-15T09:59:00Z',150),record('2026-10-15T10:01:00Z',170)].join('\n'),'ordered.jsonl');
  expect(parsed.events.map(event=>event.inputTokens)).toEqual([100,50,20]);
 });
 it('does not count fractional, unsafe, or internally impossible usage totals',()=>{
  const record=(input:number,cached=0)=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:0,cached_input_tokens:cached,reasoning_output_tokens:0}}}});
  const parsed=parseSessionDetailed([record(0.5),record(1e20),record(10,11),record(12,4)].join('\n'),'invalid.jsonl');
  expect(parsed.events.map(event=>event.inputTokens)).toEqual([12]);
  expect(parsed.warnings.join(' ')).toContain('invalid usage');
 });
 it('does not count a contradictory last usage when cumulative counters reset',()=>{
  const record=(at:string,total:number,last:number)=>JSON.stringify({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:total,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0},last_token_usage:{input_tokens:last,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const parsed=parseSessionDetailed([record('2026-10-15T10:00:00Z',100,100),record('2026-10-15T10:01:00Z',20,100)].join('\n'),'reset.jsonl');
  expect(parsed.events.map(event=>event.inputTokens)).toEqual([100]);
  expect(parsed.warnings.join(' ')).toContain('Invalid last-usage');
 });
});
