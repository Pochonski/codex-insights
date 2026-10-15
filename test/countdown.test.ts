import {describe,it,expect} from 'vitest';
import {countdown} from '../src/webview/countdown';
describe('quota countdown',()=>{
 it('uses absolute timestamps and clamps expired resets',()=>{const now=Date.parse('2026-10-15T12:00:00Z');expect(countdown('2026-10-15T13:01:02Z',now)).toBe('01:01:02');expect(countdown('2026-10-15T11:59:00Z',now)).toContain('pending');});
 it('handles days and absent reset timestamps',()=>{const now=Date.parse('2026-10-15T12:00:00Z');expect(countdown('2026-10-17T12:00:00Z',now)).toContain('2d');expect(countdown(null,now)).toBe('Reset unavailable');});
});
