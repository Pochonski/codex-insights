import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';

export const LOCAL_HISTORY_RESET_LOCK='.codex-insights-local-reset.lock';
export const maintenanceLockPath=(directory:string):string=>path.join(directory,LOCAL_HISTORY_RESET_LOCK);

export function assertStorageUnlocked(directory:string,token?:string):void{
  const file=maintenanceLockPath(directory);if(!existsSync(file))return;
  let active='';try{active=readFileSync(file,'utf8').trim();}catch{}
  if(!token||active!==token)throw new Error('Codex Insights storage is locked for an explicit maintenance operation.');
}
