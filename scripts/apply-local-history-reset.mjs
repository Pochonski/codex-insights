#!/usr/bin/env node
// Explicit maintenance command. It is never invoked by extension activation,
// Refresh, package scripts, or CI.
import {build} from 'esbuild';
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const argv=process.argv.slice(2),requested=argv[0],mode=['prepare','restore'].includes(requested)?argv.shift():'execute',value=(name)=>{const at=argv.indexOf(name);if(at<0)return undefined;if(!argv[at+1]||argv[at+1].startsWith('--'))throw new Error('Missing value for '+name);return argv[at+1];};
if(argv.includes('--help')){console.log('Prepare: npm run reset:history:execute -- prepare --storage-dir <globalStorage> --state-file <sessions-index.json> --sources <sessions> --backup-dir <new persistent directory> --plan-output <private plan> --storage <sqlite|json>');console.log('Execute: npm run reset:history:execute -- --plan <private plan> --storage-dir <globalStorage> --state-file <sessions-index.json> --sources <sessions> --backup-dir <verified backup> --confirm "RESET LOCAL TOKEN HISTORY" --confirm-plan <full plan ID>');console.log('Restore: npm run reset:history:execute -- restore --storage-dir <globalStorage> --state-file <sessions-index.json> --backup-dir <verified backup> --confirm "RESTORE CODEX INSIGHTS BACKUP AND DISCARD NEWER LOCAL STATISTICS"');console.log('Close every VS Code/Codium window and Codex process first.');process.exit(0);}
const allowed=new Set(['--plan','--plan-output','--storage','--storage-dir','--state-file','--sources','--backup-dir','--confirm','--confirm-plan']);for(let i=0;i<argv.length;i+=2)if(!allowed.has(argv[i])||!argv[i+1])throw new Error('Unsupported argument. Use --help.');
const planFile=value('--plan'),planOutput=value('--plan-output'),storageMode=value('--storage'),storage=value('--storage-dir'),stateFile=value('--state-file'),sources=value('--sources'),backup=value('--backup-dir'),confirmation=value('--confirm'),confirmedPlanId=value('--confirm-plan');
if(!storage||!stateFile||!backup||(mode==='prepare'&&(!sources||!planOutput||!['sqlite','json'].includes(storageMode)))||(mode==='execute'&&(!planFile||!sources||!confirmedPlanId||!confirmation))||(mode==='restore'&&!confirmation))throw new Error('All operation arguments are required. Use --help.');
const repositoryRoot=await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const insideRepository=(candidate)=>{const relative=path.relative(repositoryRoot,candidate);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
async function refuseRepositoryArtifact(file){
 const absolute=path.resolve(file),parent=await realpath(path.dirname(absolute));
 if(insideRepository(path.join(parent,path.basename(file))))throw new Error('Private reset backups and plans must be outside the repository.');
 try{if(insideRepository(await realpath(absolute)))throw new Error('Private reset backups and plans must be outside the repository.');}catch(error){if(error?.code!=='ENOENT')throw error;}
}
await refuseRepositoryArtifact(backup);
if(planOutput)await refuseRepositoryArtifact(planOutput);
if(planFile)await refuseRepositoryArtifact(planFile);
const privateFile=async(file)=>{const resolved=await realpath(file),mode=(await stat(resolved)).mode&0o777;if(mode&0o077)throw new Error('The private reset plan must not be group/world accessible.');return resolved;};
async function relevantWriters(){
 if(process.platform!=='linux')throw new Error('Writer-process verification is currently supported only on Linux; reset refused.');
 const {readdir}=await import('node:fs/promises'),writers=[];for(const entry of await readdir('/proc')){if(!/^\d+$/.test(entry)||Number(entry)===process.pid)continue;try{const cmd=(await readFile(`/proc/${entry}/cmdline`)).toString('utf8').split('\0').filter(Boolean),exe=path.basename(cmd[0]??'').toLowerCase(),joined=cmd.join(' ').toLowerCase();const vscode=['code','code-insiders','codium','vscodium'].includes(exe)||joined.includes('--type=extensionhost');const nodeCodex=exe==='node'&&cmd.slice(1).some(item=>['codex','codex.js'].includes(path.basename(item).toLowerCase()));const codex=exe==='codex'||nodeCodex||joined.includes('codex app-server');if(vscode||codex)writers.push(Number(entry));}catch{}
 }return writers;
}
async function assertWritersStopped(){const writers=await relevantWriters();if(writers.length)throw new Error(`Reset refused: ${writers.length} VS Code/Codex writer process(es) still appear active.`);}
const temporary=await mkdtemp(path.join(tmpdir(),'codex-insights-reset-command-'));
try{
 const outfile=path.join(temporary,'execute.mjs');await build({stdin:{contents:`export * from ${JSON.stringify(path.resolve('src/reset/local-history-executor.ts'))};`,resolveDir:process.cwd(),sourcefile:'reset-executor-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node20',outfile,logLevel:'silent'});const api=await import(pathToFileURL(outfile).href);
 const result=mode==='prepare'?await api.prepareLocalHistoryReset({storageDirectory:path.resolve(storage),stateFile:path.resolve(stateFile),sources:path.resolve(sources),backupDirectory:path.resolve(backup),planFile:path.resolve(planOutput),storage:storageMode,assertWritersStopped}):mode==='restore'?await api.executeLocalHistoryRestore({storageDirectory:path.resolve(storage),stateFile:path.resolve(stateFile),backupDirectory:path.resolve(backup),confirmation,assertWritersStopped}):await (async()=>{const plan=JSON.parse(await readFile(await privateFile(planFile),'utf8'));return api.executeLocalHistoryReset({plan,storageDirectory:path.resolve(storage),stateFile:path.resolve(stateFile),sources:path.resolve(sources),backupDirectory:path.resolve(backup),confirmation,confirmedPlanId,assertWritersStopped});})();
 console.log(JSON.stringify(result,null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
