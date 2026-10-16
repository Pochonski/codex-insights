import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
// The development terminal can inherit Extension Host variables. They would
// make the downloaded Electron binary run as Node instead of VS Code.
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) {
    delete process.env[key];
  }
}
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'codex-insights-e2e-'));
const userData = path.join(temporaryRoot, 'user-data');
const extensions = path.join(temporaryRoot, 'extensions');
const workspace = path.join(temporaryRoot, 'workspace');

try {
  await Promise.all([mkdir(userData), mkdir(extensions), mkdir(workspace)]);
  const code = await runTests({
    version: '1.90.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'e2e', 'suite.js'),
    extensionTestsEnv: { CODEX_INSIGHTS_E2E: '1' },
    launchArgs: [
      '--folder-uri=' + pathToFileURL(workspace).toString(),
      '--user-data-dir=' + userData,
      '--extensions-dir=' + extensions,
      '--disable-extensions',
      '--disable-gpu',
    ],
  });
  if (code !== 0) {
    throw new Error('VS Code E2E process exited with code ' + code);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
