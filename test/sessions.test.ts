import {describe,it,expect} from 'vitest';
import {parseSession} from '../src/collectors/sessions';
import {aggregate} from '../src/analytics/aggregate';
describe('Codex token collector',()=>{
 it('calculates cumulative deltas without double counting',()=>{
  const record=(n:number)=>JSON.stringify({timestamp:'2026-10-15T00:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:n/2,cached_input_tokens:0,reasoning_output_tokens:0}}}});
  const events=parseSession([record(100),record(150),record(150)].join('\n'),'/tmp/test.jsonl');
  expect(events).toHaveLength(2);expect(aggregate(events).total.inputTokens).toBe(150);expect(aggregate(events).total.outputTokens).toBe(75);
 });
 it('ignores malformed and unrelated records',()=>{expect(parseSession('invalid\n{"type":"other"}','test.jsonl')).toEqual([]);});
});
