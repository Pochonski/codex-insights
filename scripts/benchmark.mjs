import {build} from 'esbuild';
import {mkdtemp,writeFile,mkdir,readFile,appendFile,rm,stat} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const root=process.cwd();
const compiled=await mkdtemp(path.join(tmpdir(),'codex-insights-benchmark-module-'));
const outfile=path.join(compiled,'benchmark-source.mjs');
await build({stdin:{contents:`export * from ${JSON.stringify(path.join(root,'src/collectors/sessions.ts'))};export * from ${JSON.stringify(path.join(root,'src/storage/session-db.ts'))};export * from ${JSON.stringify(path.join(root,'src/analytics/aggregate.ts'))};export * from ${JSON.stringify(path.join(root,'src/analytics/views.ts'))};`,resolveDir:root,sourcefile:'benchmark-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node22',outfile,logLevel:'silent'});
const {findSessionFiles,parseSession,SessionIndex,SessionDatabase,aggregate,buildAnalyticsView}=await import(pathToFileURL(outfile).href);
const elapsed=async fn=>{const start=performance.now();const value=await fn();return {ms:Number((performance.now()-start).toFixed(2)),value};};
const line=(session,index,total)=>JSON.stringify({timestamp:new Date(Date.UTC(2026,0,1,0,index)).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:total,output_tokens:Math.floor(total/4),cached_input_tokens:Math.floor(total/2),reasoning_output_tokens:Math.floor(total/20)}}},session});

async function scenario(sessionCount,eventsPerSession=100){
 const dir=await mkdtemp(path.join(tmpdir(),`codex-insights-bench-${sessionCount}-`)),sessions=path.join(dir,'sessions'),storage=path.join(dir,'storage');await mkdir(sessions);await mkdir(storage);
 try{
  for(let session=0;session<sessionCount;session++){const rows=[JSON.stringify({type:'session_meta',payload:{id:`demo-session-${session}`,cwd:`/demo/project-${session%20}`}}),JSON.stringify({type:'turn_context',payload:{model:`gpt-demo-${session%4}`}})];for(let event=1;event<=eventsPerSession;event++)rows.push(line(session,event,event*100));await writeFile(path.join(sessions,`session-${session}.jsonl`),rows.join('\n')+'\n');}
  const rssStart=process.memoryUsage().rss;
  const discovery=await elapsed(()=>findSessionFiles(sessions,Math.max(2000,sessionCount+1)));
  const reading=await elapsed(()=>Promise.all(discovery.value.map(file=>readFile(file,'utf8'))));
  const processing=await elapsed(async()=>reading.value.flatMap((content,index)=>parseSession(content,discovery.value[index])));
  const deduplication=await elapsed(async()=>aggregate(processing.value));
  const cache=new Map();for(let index=0;index<discovery.value.length;index++){const file=discovery.value[index],metadata=await stat(file);cache.set(file,{size:metadata.size,mtimeMs:metadata.mtimeMs,events:parseSession(reading.value[index],file)});}
  const database=new SessionDatabase(storage);await database.open();const persistence=await elapsed(async()=>database.sync(cache));database.close();
  const dashboardQuery=await elapsed(async()=>buildAnalyticsView(deduplication.value,{period:'all',session:'',model:'',project:''}));
  const indexStorage=path.join(dir,'index-storage');await mkdir(indexStorage);const index=new SessionIndex(path.join(indexStorage,'session-index.json'));const firstImport=await elapsed(()=>index.scan(sessions));const unchangedUpdate=await elapsed(()=>index.scan(sessions));
  for(let session=0;session<sessionCount;session+=10)await appendFile(path.join(sessions,`session-${session}.jsonl`),line(session,eventsPerSession+1,(eventsPerSession+1)*100)+'\n');
  const changedUpdate=await elapsed(()=>index.scan(sessions));
  for(let session=0;session<sessionCount;session++){const file=path.join(sessions,`session-${session}.jsonl`);await writeFile(file,await readFile(file,'utf8'));}
  const reconcileAll=await elapsed(()=>index.scan(sessions));index.close();
  const rssEnd=process.memoryUsage().rss;
  return {sessions:sessionCount,events:processing.value.length,datasetBytes:(await Promise.all(discovery.value.map(file=>stat(file)))).reduce((sum,item)=>sum+item.size,0),discoveryMs:discovery.ms,readMs:reading.ms,processingMs:processing.ms,deduplicationMs:deduplication.ms,persistenceMs:persistence.ms,firstImportMs:firstImport.ms,firstImportBytesRead:firstImport.value.metrics.bytesRead,unchangedUpdateMs:unchangedUpdate.ms,unchangedBytesRead:unchangedUpdate.value.metrics.bytesRead,changedUpdateMs:changedUpdate.ms,changedBytesRead:changedUpdate.value.metrics.bytesRead,reconcileAllMs:reconcileAll.ms,reconcileAllBytesRead:reconcileAll.value.metrics.bytesRead,reconcileAllEventsNew:reconcileAll.value.metrics.eventsNew,dashboardQueryMs:dashboardQuery.ms,rssDeltaMiB:Number(((rssEnd-rssStart)/1048576).toFixed(2)),rssEndMiB:Number((rssEnd/1048576).toFixed(2))};
 }finally{await rm(dir,{recursive:true,force:true});}
}

try{
  const results=[];for(const count of [10,100,500,1000,2000])results.push(await scenario(count));
 console.log(JSON.stringify({generatedAt:new Date().toISOString(),environment:{node:process.version,platform:`${process.platform} ${process.arch}`,cpu:cpus()[0]?.model||'unknown',logicalCpus:cpus().length,totalMemoryGiB:Number((totalmem()/1073741824).toFixed(1))},methodology:{eventsPerSession:100,syntheticData:true,timing:'single measured run after fixture generation; milliseconds; no CI threshold',memory:'RSS delta and final RSS are approximate'},results},null,2));
}finally{await rm(compiled,{recursive:true,force:true});}
