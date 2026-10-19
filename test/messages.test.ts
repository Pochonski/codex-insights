import {describe,it,expect} from 'vitest';
import {parseWebviewMessage,isDashboardSnapshot} from '../src/core/messages';
describe('Webview message boundary',()=>{
 it('accepts only known commands and normalizes filter values',()=>{expect(parseWebviewMessage({command:'openFile',path:'/tmp/secrets'})).toBeNull();expect(parseWebviewMessage({command:'filters',filters:{period:'nonsense',session:42}})).toEqual({command:'filters',filters:{period:'7d',session:'',model:'',project:'',startDate:'',endDate:''}});});
 it('accepts the fixed audit action and validates the React render signal',()=>{expect(parseWebviewMessage({command:'auditHistory'})).toEqual({command:'auditHistory'});expect(parseWebviewMessage({command:'integrityRendered',eventsAnalyzed:3,supportedByEvidence:1,ambiguousObservations:1,unverifiableLegacy:1,confirmedAdjustments:0})).toEqual({command:'integrityRendered',eventsAnalyzed:3,supportedByEvidence:1,ambiguousObservations:1,unverifiableLegacy:1,confirmedAdjustments:0});expect(parseWebviewMessage({command:'integrityRendered',eventsAnalyzed:-1})).toBeNull();});
 it('rejects incomplete snapshots',()=>{expect(isDashboardSnapshot({type:'snapshot',quota:{buckets:[]},analytics:{},histories:[]})).toBe(false);});
});
