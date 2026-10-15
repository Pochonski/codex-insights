import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd(),temporary=await mkdtemp(path.join(tmpdir(),'codex-insights-app-server-')),outfile=path.join(temporary,'smoke.mjs');
try{
 await build({stdin:{contents:`export * from ${JSON.stringify(path.join(root,'src/providers/app-server-client.ts'))};export * from ${JSON.stringify(path.join(root,'src/providers/quotas.ts'))};`,resolveDir:root,sourcefile:'app-server-smoke.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node22',outfile,logLevel:'silent'});
 const {CodexAppServerClient,CodexQuotaProvider}=await import(pathToFileURL(outfile).href);const client=new CodexAppServerClient({requestTimeoutMs:15000,maxRetries:1});
 try{const result=await new CodexQuotaProvider(client).fetch();console.log(JSON.stringify({state:result.status.state,plan:result.status.plan,windowDurations:result.status.buckets.flatMap(bucket=>bucket.windows.map(window=>window.durationMinutes)),fetchedAt:result.status.fetchedAt,connectionState:client.state},null,2));if(result.status.state==='error')process.exitCode=1;}finally{client.dispose();}
}finally{await rm(temporary,{recursive:true,force:true});}
