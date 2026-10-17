import * as vscode from 'vscode';
import type {MiniSummary,MiniOutbound} from '../core/mini-messages';
import {parseMiniMessage} from '../core/mini-messages';
import {renderMiniPanel} from '../webview/html';

export interface MiniPanelActions {refresh:()=>Promise<unknown>;openDashboard:()=>Promise<unknown>|unknown;copySummary:()=>Promise<unknown>;}
export class MiniPanelController implements vscode.Disposable {
 private panel:vscode.WebviewPanel|undefined;
 private messages:vscode.Disposable|undefined;
 private panelDisposal:vscode.Disposable|undefined;
 private ready=false;
 private closed=false;
 private updates=0;
 private opens=0;
 constructor(private readonly extensionUri:vscode.Uri,private readonly getSummary:()=>MiniSummary,private readonly actions:MiniPanelActions){}
 get testState(){return {created:!!this.panel,ready:this.ready,updates:this.updates,opens:this.opens,html:this.panel?.webview.html??''};}
 open():void{
  if(this.closed)return;
  if(this.panel){this.panel.reveal();return;}
  const panel=vscode.window.createWebviewPanel('codexInsightsMini','Codex Insights · Quick Monitor',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(this.extensionUri,'media')]});
  this.panel=panel;this.ready=false;this.opens++;
  this.messages=panel.webview.onDidReceiveMessage((value:unknown)=>this.receive(value));
  this.panelDisposal=panel.onDidDispose(()=>{this.messages?.dispose();this.panelDisposal?.dispose();this.messages=undefined;this.panelDisposal=undefined;this.panel=undefined;this.ready=false;});
  panel.webview.html=renderMiniPanel(panel.webview,this.extensionUri);
 }
 publish():void{if(!this.panel||!this.ready||this.closed)return;this.updates++;this.send(this.getSummary());}
 private send(value:MiniOutbound):void{if(this.panel&&!this.closed)void this.panel.webview.postMessage(value).then(undefined,()=>{});}
 private receive(value:unknown):void{
  const message=parseMiniMessage(value);if(!message||this.closed)return;
  if(message.type==='mini/ready'){this.ready=true;this.publish();return;}
  if(message.type==='mini/openDashboard'){void Promise.resolve(this.actions.openDashboard()).catch(()=>this.send({type:'summary/error',message:'Dashboard could not be opened.'}));return;}
  if(message.type==='mini/copySummary'){void this.actions.copySummary().then(()=>this.send({type:'summary/notice',message:'Summary copied to clipboard.'}),()=>this.send({type:'summary/error',message:'Could not copy the summary.'}));return;}
  void this.actions.refresh().then(()=>{this.publish();this.send({type:'summary/refreshDone'});},()=>{this.send({type:'summary/error',message:'Refresh failed. Last known data is still available.'});this.send({type:'summary/refreshDone'});});
 }
 dispose():void{if(this.closed)return;this.closed=true;this.messages?.dispose();this.panelDisposal?.dispose();this.panel?.dispose();this.messages=undefined;this.panelDisposal=undefined;this.panel=undefined;this.ready=false;}
}
