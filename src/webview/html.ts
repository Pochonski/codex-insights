import type * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
export function renderDashboard(webview:vscode.Webview,extensionUri:vscode.Uri):string{
 const nonce=randomBytes(16).toString('base64');
 const resource=(name:string)=>webview.asWebviewUri(extensionUri.with({path:extensionUri.path.replace(/\/$/,'')+'/media/'+name})).toString();
 const css=resource('dashboard.css'),app=resource('dashboard.js');
 const csp=`default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';`;
 return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Codex Insights</title><link rel="stylesheet" href="${css}"></head><body><div id="root"><div class="boot">Loading Codex Insights…</div></div><script nonce="${nonce}" src="${app}"></script></body></html>`;
}
