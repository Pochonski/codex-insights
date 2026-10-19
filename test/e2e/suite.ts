import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface E2eState {
  panelCreated: boolean;
  webviewReady: boolean;
  panelDisposed: boolean;
  snapshots: number;
  quotaUpdates: number;
  auditRuns: number;
  quotaState: string;
  eventCount: number;
  primaryUsedPercent: number | null;
  statusText: string;
  statusTooltip: string;
  statusCommand: string;
  statusTrustedCommands: {enabledCommands: readonly string[]};
  mini: {created:boolean;ready:boolean;updates:number;opens:number;html:string};
  historicalIntegrity: {status:string;eventsAnalyzed?:number;supportedByEvidence?:number;ambiguousObservations?:number;unverifiableLegacy?:number;confirmedAdjustments?:number;changesApplied:false};
  integrityRendered: null|{eventsAnalyzed:number;supportedByEvidence:number;ambiguousObservations:number;unverifiableLegacy:number;confirmedAdjustments:number};
}

async function waitFor(predicate: () => Promise<boolean>, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function state(): Promise<E2eState> {
  return vscode.commands.executeCommand<E2eState>('codexInsights.e2e.getState');
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('codex-insights-local.codex-insights');
  assert.ok(extension, 'Codex Insights extension was not discovered');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codexInsights.openDashboard'), 'Dashboard command was not registered');
  assert.ok(commands.includes('codexInsights.e2e.getState'), 'E2E-only probe was not registered in Test mode');
  assert.ok(commands.includes('codexInsights.copySummary'), 'Copy Summary command was not registered');
  assert.ok(commands.includes('codexInsights.openMiniPanel'), 'Mini Panel command was not registered');
  assert.ok(commands.includes('codexInsights.e2e.auditHistory'), 'E2E historical audit probe was not registered');

  await waitFor(async () => (await state()).statusText.includes('5h 25%'), 'synthetic status bar quota');
  const initial = await state();
  assert.equal(initial.statusCommand, 'codexInsights.openDashboard');
  assert.deepEqual([...initial.statusTrustedCommands.enabledCommands], ['codexInsights.openDashboard', 'codexInsights.refresh', 'codexInsights.copySummary']);
  assert.match(initial.statusTooltip, /5-HOUR LIMIT/);
  assert.equal((initial.statusTooltip.match(/data:image\/svg\+xml;base64,/g)||[]).length,2,'native hover should include two generated quota bars');
  assert.match(initial.statusTooltip, /Local activity/);
  assert.match(initial.statusTooltip, /Recorded usage groups 1/);

  await vscode.commands.executeCommand('codexInsights.openMiniPanel');
  await waitFor(async () => {const mini=(await state()).mini;return mini.created&&mini.ready&&mini.updates>0;}, 'Mini Panel React ready handshake');
  let mini=(await state()).mini;
  assert.match(mini.html, /mini-panel\.js/);
  assert.match(mini.html, /mini-panel\.css/);
  assert.match(mini.html, /default-src 'none'/);
  await vscode.commands.executeCommand('codexInsights.openMiniPanel');
  assert.equal((await state()).mini.opens,1,'repeat open should reveal the same Mini Panel');

  await vscode.commands.executeCommand('codexInsights.openDashboard');
  await waitFor(async () => {
    const current = await state();
    return current.panelCreated && current.webviewReady && current.snapshots > 0;
  }, 'the React Webview ready handshake');

  let current = await state();
  assert.equal(current.quotaState, 'connected', 'synthetic provider should expose a connection state');
  assert.equal(current.eventCount, 1, 'synthetic session data should reach the Extension Host');
  assert.equal(current.primaryUsedPercent, 25, 'initial synthetic quota should reach the snapshot');

  await Promise.all([vscode.commands.executeCommand('codexInsights.e2e.auditHistory'),vscode.commands.executeCommand('codexInsights.e2e.auditHistory')]);
  await waitFor(async () => (await state()).integrityRendered?.eventsAnalyzed === 3, 'React historical integrity category render');
  current = await state();
  assert.deepEqual(current.integrityRendered,{eventsAnalyzed:3,supportedByEvidence:1,ambiguousObservations:1,unverifiableLegacy:1,confirmedAdjustments:0});
  assert.equal(current.historicalIntegrity.status,'partial');
  assert.equal(current.historicalIntegrity.changesApplied,false,'E2E audit must remain read-only');
  assert.equal(current.auditRuns,1,'concurrent audit requests should share one run');

  await vscode.commands.executeCommand('codexInsights.e2e.bumpQuota');
  await waitFor(async () => (await state()).primaryUsedPercent === 30, 'a synthetic quota update');
  current = await state();
  assert.ok(current.snapshots >= 2, 'the Webview should receive an updated snapshot');
  assert.ok(current.mini.updates >= 2, 'Mini Panel should receive the updated quota snapshot');
  assert.match(current.statusText, /5h 30%/, 'status bar should update with synthetic quota');
  const image=(markdown:string)=>markdown.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/)?.[0];
  assert.notEqual(image(current.statusTooltip),image(initial.statusTooltip),'hover progress image should change with quota data');

  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand('codexInsights.copySummary');
    assert.match(await vscode.env.clipboard.readText(), /5-hour limit: 30% used/);
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
  await vscode.commands.executeCommand('codexInsights.refresh');
  assert.equal((await state()).quotaState, 'connected');

  const clickConfig=vscode.workspace.getConfiguration('codexInsights.statusBar');
  await clickConfig.update('clickAction','miniPanel',vscode.ConfigurationTarget.Global);
  await waitFor(async () => (await state()).statusCommand==='codexInsights.openMiniPanel','optional Mini Panel click');
  await clickConfig.update('clickAction',undefined,vscode.ConfigurationTarget.Global);
  await waitFor(async () => (await state()).statusCommand==='codexInsights.openDashboard','dashboard default click');

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(async () => (await state()).panelDisposed, 'dashboard disposal');

  await vscode.commands.executeCommand('codexInsights.openDashboard');
  await waitFor(async () => {
    const reopened = await state();
    return reopened.panelCreated && reopened.webviewReady && !reopened.panelDisposed;
  }, 'dashboard reopen');

  await vscode.commands.executeCommand('codexInsights.openMiniPanel');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(async () => !(await state()).mini.created,'Mini Panel disposal');
  await vscode.commands.executeCommand('codexInsights.openMiniPanel');
  await waitFor(async () => {mini=(await state()).mini;return mini.created&&mini.ready&&mini.opens===2;},'Mini Panel reopen');
}
