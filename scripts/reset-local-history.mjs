#!/usr/bin/env node
// Dry-run only. This CLI never opens extension storage for writing and exposes
// no apply/repair command.
import {build} from 'esbuild';
import {constants} from 'node:fs';
import {access,chmod,mkdtemp,open,readFile,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const argv=process.argv.slice(2);
if(argv.some(value=>['--apply','--repair','--execute'].includes(value))){console.error('Local history reset application is disabled. No data was modified.');process.exit(2);}
const commands=new Set(['dry-run','plan','inspect','validate']);
const command=commands.has(argv[0])?argv.shift():'dry-run';
const value=(name)=>{const at=argv.indexOf(name);if(at<0)return undefined;if(!argv[at+1]||argv[at+1].startsWith('--'))throw new Error('Missing value for '+name);return argv[at+1];};
const dbFile=value('--snapshot-db'),jsonFile=value('--snapshot-json'),sources=value('--sources'),planFile=value('--plan'),output=value('--output');
if(argv.includes('--help')){console.log('Usage: npm run reset:history -- [dry-run|plan|inspect|validate] --snapshot-db <isolated insights.sqlite> --sources <sessions directory> [--output <private plan.json>]');console.log('Use --snapshot-json for an isolated fallback snapshot. --apply, --repair and --execute are blocked.');process.exit(0);}
const allowed=new Set(['--snapshot-db','--snapshot-json','--sources','--plan','--output']);
for(let i=0;i<argv.length;i+=2)if(!allowed.has(argv[i])||!argv[i+1])throw new Error('Unsupported argument. Use --help.');
if(command==='inspect'&&(!planFile||dbFile||jsonFile||sources||output))throw new Error('inspect accepts only --plan.');
if(command!=='inspect'&&(Number(!!dbFile)+Number(!!jsonFile)!==1))throw new Error('Exactly one isolated storage snapshot is required.');
if((command==='dry-run'||command==='plan'||command==='validate')&&!sources)throw new Error('--sources is required to establish the cutover baseline.');
if(command==='plan'&&!output)throw new Error('plan requires --output.');
if(command==='validate'&&!planFile)throw new Error('validate requires --plan.');

async function isolated(file){const resolved=await realpath(file);const parts=resolved.split(path.sep).map(item=>item.toLowerCase());if(parts.includes('globalstorage')||parts.includes('.codex'))throw new Error('Use an isolated storage snapshot; live extension storage is refused.');if(!(await stat(resolved)).isFile())throw new Error('Snapshot is not a regular file.');return resolved;}
async function sourceDirectory(directory){const resolved=await realpath(directory);if(!(await stat(resolved)).isDirectory())throw new Error('Sources path is not a directory.');await access(resolved,constants.R_OK);return resolved;}
const temporary=await mkdtemp(path.join(tmpdir(),'codex-insights-reset-dry-run-'));
try{
 const outfile=path.join(temporary,'reset.mjs');
 await build({stdin:{contents:`export * from ${JSON.stringify(path.resolve('src/reset/local-history-reset.ts'))}; export * from ${JSON.stringify(path.resolve('src/reconciliation/snapshot.ts'))}; export * from ${JSON.stringify(path.resolve('src/collectors/sessions.ts'))}; export * from ${JSON.stringify(path.resolve('src/storage/session-db.ts'))};`,resolveDir:process.cwd(),sourcefile:'reset-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node20',outfile,logLevel:'silent'});
 const api=await import(pathToFileURL(outfile).href);
 if(command==='inspect'){
  const plan=JSON.parse(await readFile(await isolated(planFile),'utf8'));
  if(plan?.kind!=='complete-local-token-reset'||plan?.applicationEnabled!==false)throw new Error('Invalid private reset plan.');
  console.log(JSON.stringify(api.publicLocalHistoryResetSummary(plan),null,2));
  process.exit(0);
 }
 const snapshotFile=await isolated(dbFile??jsonFile);
 const root=await sourceDirectory(sources);
 const snapshot=dbFile?await api.readSqliteSnapshot(snapshotFile):api.readJsonSnapshot(snapshotFile);
 const source=new api.DefaultSessionSource(root,path.join(temporary,'baseline.json'),100000);
 const index=new api.SessionIndex(source);
 let scan,baseline;
 try{scan=await index.scan();baseline=index.resetBaseline();}finally{index.close();}
 const discovered=await source.findSessionFiles();
 for(const file of discovered)if(!baseline.has(file)){const cutover=await api.buildCutoverEntry(file);baseline.set(file,cutover.entry);scan.metrics.bytesRead+=cutover.bytesRead;scan.warnings.push(...cutover.warnings);}
 const unsafe=scan.warnings.filter(message=>/^(Session file scan limit|Skipped an oversized JSONL line|Could not index session file|Codex session folder is unavailable)/i.test(message));
 if(unsafe.length){const reasons=unsafe.map(message=>message.startsWith('Session file scan limit')?'scan-limit':message.startsWith('Skipped oversized')?'oversized-file':message.startsWith('Could not index')?'index-error':'source-unavailable');throw new Error('A complete baseline could not be established: '+[...new Set(reasons)].join(', ')+'.');}
 const plan=api.buildLocalHistoryResetPlan(snapshot,baseline);
 if(command==='plan'){
  const handle=await open(path.resolve(output),'wx',0o600);try{await handle.writeFile(JSON.stringify(plan,null,2));}finally{await handle.close();}await chmod(path.resolve(output),0o600);
 }
 if(command==='validate'){
  const stored=JSON.parse(await readFile(await isolated(planFile),'utf8'));
  const result=api.validateLocalHistoryResetPlan(stored,snapshot,baseline);console.log(JSON.stringify(result,null,2));if(!result.valid)process.exitCode=1;
 }else console.log(JSON.stringify({...api.publicLocalHistoryResetSummary(plan),sourceFilesInspected:scan.metrics.filesInspected,sourceBytesRead:scan.metrics.bytesRead,sourceParseErrors:scan.metrics.parseErrors,sourceWarnings:scan.warnings.length,privatePlanWritten:command==='plan'},null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
