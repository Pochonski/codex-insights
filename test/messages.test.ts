import {describe,it,expect} from 'vitest';
import {parseWebviewMessage,isDashboardSnapshot} from '../src/core/messages';
describe('Webview message boundary',()=>{
 it('accepts only known commands and normalizes filter values',()=>{expect(parseWebviewMessage({command:'openFile',path:'/tmp/secrets'})).toBeNull();expect(parseWebviewMessage({command:'filters',filters:{period:'nonsense',session:42}})).toEqual({command:'filters',filters:{period:'7d',session:'',model:'',project:''}});});
 it('rejects incomplete snapshots',()=>{expect(isDashboardSnapshot({type:'snapshot',quota:{buckets:[]},analytics:{},histories:[]})).toBe(false);});
});
