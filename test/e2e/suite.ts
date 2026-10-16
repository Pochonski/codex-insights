import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface E2eState {
  panelCreated: boolean;
  webviewReady: boolean;
  panelDisposed: boolean;
  snapshots: number;
  quotaUpdates: number;
  quotaState: string;
  eventCount: number;
  primaryUsedPercent: number | null;
  statusText: string;
  statusTooltip: string;
  statusCommand: string;
  statusTrustedCommands: {enabledCommands: readonly string[]};
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

  await waitFor(async () => (await state()).statusText.includes('5h 25%'), 'synthetic status bar quota');
  const initial = await state();
  assert.equal(initial.statusCommand, 'codexInsights.openDashboard');
  assert.deepEqual([...initial.statusTrustedCommands.enabledCommands], ['codexInsights.openDashboard', 'codexInsights.refresh', 'codexInsights.copySummary']);
  assert.match(initial.statusTooltip, /5-hour limit/);
  assert.match(initial.statusTooltip, /Local tokens/);

  await vscode.commands.executeCommand('codexInsights.openDashboard');
  await waitFor(async () => {
    const current = await state();
    return current.panelCreated && current.webviewReady && current.snapshots > 0;
  }, 'the React Webview ready handshake');

  let current = await state();
  assert.equal(current.quotaState, 'connected', 'synthetic provider should expose a connection state');
  assert.equal(current.eventCount, 1, 'synthetic session data should reach the Extension Host');
  assert.equal(current.primaryUsedPercent, 25, 'initial synthetic quota should reach the snapshot');

  await vscode.commands.executeCommand('codexInsights.e2e.bumpQuota');
  await waitFor(async () => (await state()).primaryUsedPercent === 30, 'a synthetic quota update');
  current = await state();
  assert.ok(current.snapshots >= 2, 'the Webview should receive an updated snapshot');
  assert.match(current.statusText, /5h 30%/, 'status bar should update with synthetic quota');

  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand('codexInsights.copySummary');
    assert.match(await vscode.env.clipboard.readText(), /5-hour limit: 30% used/);
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
  await vscode.commands.executeCommand('codexInsights.refresh');
  assert.equal((await state()).quotaState, 'connected');

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(async () => (await state()).panelDisposed, 'dashboard disposal');

  await vscode.commands.executeCommand('codexInsights.openDashboard');
  await waitFor(async () => {
    const reopened = await state();
    return reopened.panelCreated && reopened.webviewReady && !reopened.panelDisposed;
  }, 'dashboard reopen');
}
