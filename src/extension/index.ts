import * as vscode from 'vscode';
import path from 'node:path';
import {SessionIndex,defaultSessionsPath} from '../collectors/sessions';
import {aggregate} from '../analytics/aggregate';
import {buildAnalyticsView,INITIAL_FILTERS,type Filters} from '../analytics/views';
import type {DashboardData} from '../core/types';
import {renderDashboard} from '../webview/html';
import {CodexAppServerClient} from '../providers/app-server-client';
import {CodexQuotaProvider,emptyQuota,staleQuota,type QuotaStatus} from '../providers/quotas';
import {QuotaHistoryStore,type QuotaPoint} from '../storage/quota-history';
import {parseWebviewMessage,type DashboardSnapshot} from '../core/messages';
let sessionsTimer:NodeJS.Timeout|undefined;let quotasTimer:NodeJS.Timeout|undefined;let cleanup:()=>Promise<void>=async()=>{};
export function activate(context:vscode.ExtensionContext){
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,50);status.command='codexInsights.openDashboard';status.text='$(pulse) Codex: scanning';status.tooltip='Open Codex Insights';status.show();context.subscriptions.push(status);
 const diagnostics=typeof vscode.window.createOutputChannel==='function'?vscode.window.createOutputChannel('Codex Insights'):{appendLine:(_value:string)=>{},dispose:()=>{}};context.subscriptions.push(diagnostics);
 let panel:vscode.WebviewPanel|undefined;let panelReady=false;let filters:Filters={...INITIAL_FILTERS};let latest:DashboardData=aggregate([]);let quota:QuotaStatus=emptyQuota('loading');let accountId:string|null=null;let histories:{limitId:string;durationMinutes:number;points:QuotaPoint[]}[]=[];let storageWarning:string|null=null;
 const history=new QuotaHistoryStore(context.globalStorageUri.fsPath);const sessions=new SessionIndex(path.join(context.globalStorageUri.fsPath,'sessions-index.json'));
 let sessionsBusy=false,quotasBusy=false,disposed=false,historyReady=false,rpcGeneration=0;const activeTasks=new Set<Promise<unknown>>();let panelMessages:vscode.Disposable|undefined;let shutdown:Promise<void>|undefined;
 const track=<T>(task:Promise<T>):Promise<T>=>{activeTasks.add(task);void task.then(()=>activeTasks.delete(task),()=>activeTasks.delete(task));return task;};
 let rpc=new CodexAppServerClient({executable:vscode.workspace.getConfiguration('codexInsights').get<string>('codexExecutable','codex')});let quotas=new CodexQuotaProvider(rpc);
 const updateStatus=()=>{const w=quota.buckets.flatMap(b=>b.windows).find(w=>w.durationMinutes===300);status.text=(w?`$(pulse) Codex 5h ${Math.round(w.usedPercent)}%`:'$(pulse) Codex')+` · ${(latest.total.inputTokens+latest.total.outputTokens).toLocaleString()} tokens`;};
 const snapshot=():DashboardSnapshot=>({type:'snapshot',quota,analytics:buildAnalyticsView(latest,filters),histories,storageMode:history.mode,storageWarning});
 const redraw=()=>{if(disposed)return;updateStatus();if(panel&&panelReady)void panel.webview.postMessage(snapshot()).then(undefined,()=>{});};
 const refreshSessions=async()=>{if(sessionsBusy||disposed)return;sessionsBusy=true;try{const cfg=vscode.workspace.getConfiguration('codexInsights');const root=cfg.get<string>('sessionsPath')?.trim()||defaultSessionsPath();const data=await sessions.scan(root);if(!disposed){latest=aggregate(data.events,data.filesScanned,data.warnings);if(cfg.get<boolean>('diagnostics',false)){const m=data.metrics;diagnostics.appendLine(new Date().toISOString()+' import: '+m.filesInspected+' files, '+m.filesModified+' changed, '+m.bytesRead+' bytes, '+m.eventsNew+' events, '+m.eventsDeduplicated+' deduplicated, '+m.parseErrors+' parse errors, '+m.durationMs.toFixed(1)+' ms');}}}catch{status.text='$(warning) Codex Insights: scan error';}finally{sessionsBusy=false;redraw();}};
 const refreshHistory=()=>{histories=[];if(!accountId||quota.state!=='connected')return;const tracked=new Set<string>();for(const bucket of quota.buckets)for(const w of bucket.windows){if(!w.durationMinutes)continue;const key=`${bucket.id}|${w.durationMinutes}`;if(tracked.has(key))continue;tracked.add(key);histories.push({limitId:bucket.id,durationMinutes:w.durationMinutes,points:history.read(accountId,bucket.id,w.durationMinutes,30*24)});}};
 const refreshQuotas=async()=>{if(quotasBusy||disposed){redraw();return;}quotasBusy=true;const generation=rpcGeneration;const provider=quotas;try{const result=await provider.fetch();if(disposed||generation!==rpcGeneration)return;quota=result.status;accountId=result.accountId;if(historyReady){try{history.save(accountId,quota);refreshHistory();}catch{historyReady=false;storageWarning='Quota storage failed; the original data was preserved and live quotas remain available.';}}}catch{if(!disposed&&generation===rpcGeneration)quota=staleQuota(quota,'Unable to refresh quota data; showing the last successful sample',rpc.state);}finally{if(generation===rpcGeneration)quotasBusy=false;redraw();}};
 const refreshAll=async()=>{await Promise.all([refreshSessions(),refreshQuotas()]);};
 const connectAccount=async()=>{try{const {url}=await quotas.beginChatGptLogin();const opened=await vscode.env.openExternal(vscode.Uri.parse(url));if(!opened)vscode.window.showWarningMessage('Could not open the ChatGPT login page.');}catch{vscode.window.showErrorMessage('Unable to begin ChatGPT login via Codex App Server.');}};
 const onNotification=(method:string)=>{if(['account/login/completed','account/updated','account/rateLimits/updated'].includes(method))void track(refreshQuotas());};
 const onRpcState=(state:string)=>{if(state==='offline'&&quota.fetchedAt)quota=staleQuota(quota,'Codex App Server disconnected; showing the last successful sample','offline');redraw();};
 const attachRpc=()=>{rpc.on('notification',onNotification);rpc.on('state',onRpcState);};attachRpc();
 const reinitializeRpc=()=>{rpcGeneration++;quotasBusy=false;rpc.dispose();rpc=new CodexAppServerClient({executable:vscode.workspace.getConfiguration('codexInsights').get<string>('codexExecutable','codex')});attachRpc();quotas=new CodexQuotaProvider(rpc);quota=quota.fetchedAt?staleQuota(quota,'Codex executable changed; refreshing the last successful sample','reconnecting'):emptyQuota('loading');redraw();};
 context.subscriptions.push(vscode.commands.registerCommand('codexInsights.openDashboard',()=>{
  if(panel){panel.reveal();return;}panel=vscode.window.createWebviewPanel('codexInsights','Codex Insights',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});panelReady=false;filters={...INITIAL_FILTERS};
  panelMessages=panel.webview.onDidReceiveMessage((value:unknown)=>{const m=parseWebviewMessage(value);if(!m)return;if(m.command==='ready'){panelReady=true;filters=m.filters;redraw();}else if(m.command==='filters'){filters=m.filters;redraw();}else if(m.command==='login')void track(connectAccount());else if(m.command==='refresh')void track(refreshAll()).finally(redraw);});
  panel.onDidDispose(()=>{panelMessages?.dispose();panelMessages=undefined;panel=undefined;panelReady=false;},null,context.subscriptions);panel.webview.html=renderDashboard(panel.webview,context.extensionUri);void refreshAll();
 }));
 context.subscriptions.push(vscode.commands.registerCommand('codexInsights.refresh',()=>track(refreshAll())));context.subscriptions.push(vscode.commands.registerCommand('codexInsights.signIn',()=>track(connectAccount())));
 const configureTimers=()=>{if(sessionsTimer)clearInterval(sessionsTimer);if(quotasTimer)clearInterval(quotasTimer);const cfg=vscode.workspace.getConfiguration('codexInsights');sessionsTimer=setInterval(()=>void track(refreshSessions()),Math.max(15,cfg.get<number>('refreshSeconds',60))*1000);quotasTimer=setInterval(()=>void track(refreshQuotas()),Math.max(60,cfg.get<number>('quotaRefreshSeconds',180))*1000);};configureTimers();
 context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('codexInsights.codexExecutable')){reinitializeRpc();void track(refreshQuotas());}if(e.affectsConfiguration('codexInsights')){configureTimers();void track(refreshSessions());}}));
 cleanup=()=>{if(shutdown)return shutdown;shutdown=(async()=>{disposed=true;if(sessionsTimer)clearInterval(sessionsTimer);if(quotasTimer)clearInterval(quotasTimer);panelMessages?.dispose();panel?.dispose();rpc.dispose();status.dispose();await Promise.allSettled([...activeTasks]);history.close();sessions.close();})();return shutdown;};
 context.subscriptions.push({dispose:()=>{void cleanup();}});
 void track(history.open().then(ok=>{historyReady=ok;storageWarning=null;return refreshQuotas();}).catch(()=>{historyReady=false;storageWarning='Quota storage could not be opened; the original data was preserved.';return refreshQuotas();}));
 void track(refreshSessions());
}
export async function deactivate(){await cleanup();cleanup=async()=>{};}
