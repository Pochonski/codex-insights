import {describe,it,expect} from 'vitest';
import {parseSession,parseSessionDetailed} from '../src/collectors/sessions';
import {aggregate} from '../src/analytics/aggregate';
describe('Codex token collector',()=>{
 it('calculates cumulative deltas without double counting',()=>{
  const record=(n:number)=>JSON.stringify({timestamp:'2026-10-15T00:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:n/2,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const events=parseSession([record(100),record(150),record(150)].join('\n'),'/tmp/test.jsonl');
  expect(events).toHaveLength(2);expect(aggregate(events).total.inputTokens).toBe(150);expect(aggregate(events).total.outputTokens).toBe(75);
 });
 it('ignores malformed and unrelated records',()=>{expect(parseSession('invalid\n{"type":"other"}','test.jsonl')).toEqual([]);});
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
});
