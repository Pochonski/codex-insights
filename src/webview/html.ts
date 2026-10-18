import type * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
function renderWebview(webview:vscode.Webview,extensionUri:vscode.Uri,stylesheet:string,bundle:string,title:string):string{
 const nonce=randomBytes(16).toString('base64');
 const resource=(name:string)=>webview.asWebviewUri(extensionUri.with({path:extensionUri.path.replace(/\/$/,'')+'/media/'+name})).toString();
 const css=resource(stylesheet),app=resource(bundle);
 const csp=`default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';`;
 return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${title}</title><link rel="stylesheet" href="${css}"></head><body><div id="root"><div class="boot">Loading Codex Insights…</div></div><script nonce="${nonce}" src="${app}"></script></body></html>`;
}
export const renderDashboard=(webview:vscode.Webview,extensionUri:vscode.Uri):string=>renderWebview(webview,extensionUri,'dashboard.css','dashboard.js','Codex Insights');
export const renderMiniPanel=(webview:vscode.Webview,extensionUri:vscode.Uri):string=>renderWebview(webview,extensionUri,'mini-panel.css','mini-panel.js','Codex Insights Quick Monitor');
