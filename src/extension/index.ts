import * as vscode from 'vscode';
import path from 'node:path';
import {SessionIndex,defaultSessionsPath} from '../collectors/sessions';
import {aggregate} from '../analytics/aggregate';
import {buildAnalyticsView,INITIAL_FILTERS,type Filters} from '../analytics/views';
import type {DashboardData} from '../core/types';
import {renderDashboard} from '../webview/html';
import {CodexAppServerClient} from '../providers/app-server-client';
import {CodexQuotaProvider,emptyQuota,type QuotaStatus} from '../providers/quotas';
import {QuotaHistoryStore,type QuotaPoint} from '../storage/quota-history';
import {parseWebviewMessage,type DashboardSnapshot} from '../core/messages';
let sessionsTimer:NodeJS.Timeout|undefined;let quotasTimer:NodeJS.Timeout|undefined;let cleanup:()=>void=()=>{};
export function activate(context:vscode.ExtensionContext){
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,50);status.command='codexInsights.openDashboard';status.text='$(pulse) Codex: scanning';status.tooltip='Open Codex Insights';status.show();context.subscriptions.push(status);
 let panel:vscode.WebviewPanel|undefined;let panelReady=false;let filters:Filters={...INITIAL_FILTERS};let latest:DashboardData=aggregate([]);let quota:QuotaStatus=emptyQuota('loading');let accountId:string|null=null;let histories:{limitId:string;durationMinutes:number;points:QuotaPoint[]}[]=[];
 const history=new QuotaHistoryStore(context.globalStorageUri.fsPath);const sessions=new SessionIndex(path.join(context.globalStorageUri.fsPath,'sessions-index.json'));
 let sessionsBusy=false,quotasBusy=false,disposed=false;
 let rpc=new CodexAppServerClient({executable:vscode.workspace.getConfiguration('codexInsights').get<string>('codexExecutable','codex')});let quotas=new CodexQuotaProvider(rpc);
 const updateStatus=()=>{const w=quota.buckets.flatMap(b=>b.windows).find(w=>w.durationMinutes===300);status.text=(w?`$(pulse) Codex 5h ${Math.round(w.usedPercent)}%`:'$(pulse) Codex')+` · ${(latest.total.inputTokens+latest.total.outputTokens).toLocaleString()} tokens`;};
 const snapshot=():DashboardSnapshot=>({type:'snapshot',quota,analytics:buildAnalyticsView(latest,filters),histories,storageMode:history.mode});
 const redraw=()=>{if(disposed)return;updateStatus();if(panel&&panelReady)void panel.webview.postMessage(snapshot());};
 const refreshSessions=async()=>{if(sessionsBusy||disposed)return;sessionsBusy=true;try{const cfg=vscode.workspace.getConfiguration('codexInsights');const root=cfg.get<string>('sessionsPath')?.trim()||defaultSessionsPath();const data=await sessions.scan(root);if(!disposed)latest=aggregate(data.events,data.filesScanned,data.warnings);}catch{status.text='$(warning) Codex Insights: scan error';}finally{sessionsBusy=false;redraw();}};
 const refreshHistory=()=>{histories=[];if(!accountId||quota.state!=='connected')return;const tracked=new Set<string>();for(const bucket of quota.buckets)for(const w of bucket.windows){if(!w.durationMinutes)continue;const key=`${bucket.id}|${w.durationMinutes}`;if(tracked.has(key))continue;tracked.add(key);histories.push({limitId:bucket.id,durationMinutes:w.durationMinutes,points:history.read(accountId,bucket.id,w.durationMinutes,30*24)});}};
 const refreshQuotas=async()=>{if(quotasBusy||disposed)return;quotasBusy=true;try{const result=await quotas.fetch();if(disposed)return;quota=result.status;accountId=result.accountId;if(await history.open()){history.save(accountId,quota);refreshHistory();}}catch{if(!disposed)quota=emptyQuota('error','Unable to read quota data; verify Codex CLI and retry');}finally{quotasBusy=false;redraw();}};
 const refreshAll=async()=>{await Promise.all([refreshSessions(),refreshQuotas()]);};
 const connectAccount=async()=>{try{const {url}=await quotas.beginChatGptLogin();const opened=await vscode.env.openExternal(vscode.Uri.parse(url));if(!opened)vscode.window.showWarningMessage('Could not open the ChatGPT login page.');}catch{vscode.window.showErrorMessage('Unable to begin ChatGPT login via Codex App Server.');}};
 const onNotification=(method:string)=>{if(['account/login/completed','account/updated','account/rateLimits/updated'].includes(method))void refreshQuotas();};rpc.on('notification',onNotification);
 const reinitializeRpc=()=>{rpc.dispose();rpc=new CodexAppServerClient({executable:vscode.workspace.getConfiguration('codexInsights').get<string>('codexExecutable','codex')});rpc.on('notification',onNotification);quotas=new CodexQuotaProvider(rpc);quota=emptyQuota('loading');redraw();};
 context.subscriptions.push(vscode.commands.registerCommand('codexInsights.openDashboard',()=>{
  if(panel){panel.reveal();return;}panel=vscode.window.createWebviewPanel('codexInsights','Codex Insights',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});panelReady=false;filters={...INITIAL_FILTERS};
  panel.webview.onDidReceiveMessage((value:unknown)=>{const m=parseWebviewMessage(value);if(!m)return;if(m.command==='ready'){panelReady=true;filters=m.filters;redraw();}else if(m.command==='filters'){filters=m.filters;redraw();}else if(m.command==='login')void connectAccount();else if(m.command==='refresh')void refreshAll();},undefined,context.subscriptions);
  panel.onDidDispose(()=>{panel=undefined;panelReady=false;},null,context.subscriptions);panel.webview.html=renderDashboard(panel.webview,context.extensionUri);void refreshAll();
 }));
 context.subscriptions.push(vscode.commands.registerCommand('codexInsights.refresh',refreshAll));context.subscriptions.push(vscode.commands.registerCommand('codexInsights.signIn',connectAccount));
 const configureTimers=()=>{if(sessionsTimer)clearInterval(sessionsTimer);if(quotasTimer)clearInterval(quotasTimer);const cfg=vscode.workspace.getConfiguration('codexInsights');sessionsTimer=setInterval(()=>void refreshSessions(),Math.max(15,cfg.get<number>('refreshSeconds',60))*1000);quotasTimer=setInterval(()=>void refreshQuotas(),Math.max(60,cfg.get<number>('quotaRefreshSeconds',180))*1000);};configureTimers();
 context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('codexInsights.codexExecutable')){reinitializeRpc();void refreshQuotas();}if(e.affectsConfiguration('codexInsights')){configureTimers();void refreshSessions();}}));
 cleanup=()=>{if(disposed)return;disposed=true;if(sessionsTimer)clearInterval(sessionsTimer);if(quotasTimer)clearInterval(quotasTimer);panel?.dispose();rpc.dispose();history.close();sessions.close();status.dispose();};
 context.subscriptions.push({dispose:cleanup});
 void history.open().then(()=>refreshQuotas());void refreshSessions();
}
export function deactivate(){cleanup();cleanup=()=>{};}
