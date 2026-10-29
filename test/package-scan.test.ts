import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const scanner=path.resolve('scripts/check-sensitive-files.mjs');
describe('VSIX privacy scan',()=>{
 it('rejects private plans and local paths even when they are only inside an untracked VSIX',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codex-package-scan-'));
  try{
   writeFileSync(path.join(dir,'README.md'),'Synthetic package scan fixture');
   expect(spawnSync('git',['init','-q'],{cwd:dir}).status).toBe(0);
   expect(spawnSync('git',['add','README.md'],{cwd:dir}).status).toBe(0);
   mkdirSync(path.join(dir,'extension','dist'),{recursive:true});
   writeFileSync(path.join(dir,'extension','reset.plan.json'),'{}');
   writeFileSync(path.join(dir,'extension','dist','extension.js'),'const localPath = "/home/private-user/.codex/sessions";');
   expect(spawnSync('zip',['-q','-r','codex-insights-fixture.vsix','extension'],{cwd:dir}).status).toBe(0);
   const result=spawnSync(process.execPath,[scanner],{cwd:dir,encoding:'utf8'});
   expect(result.status).toBe(1);
   expect(result.stderr).toContain('reset.plan.json');
   expect(result.stderr).toContain('extension/dist/extension.js');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
