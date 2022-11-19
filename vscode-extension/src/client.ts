/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This is the client side of the language server. It runs inside of
// VSCode directly, but doesn't do much work other than just communicating
// to our language server, which does all the heavy lifting.

import * as vscode from 'vscode';
import * as languageclient from 'vscode-languageclient/node';

let client: languageclient.LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('wireit');
  const run: languageclient.NodeModule = {
    module: context.asAbsolutePath('server.js'),
    transport: languageclient.TransportKind.ipc,
  };
  const debug: languageclient.NodeModule = {
    ...run,
    options: {execArgv: ['--nolazy', '--inspect=6009']},
  };

  client = new languageclient.LanguageClient(
    'wireit',
    'wireit server',
    {run, debug},
    {
      documentSelector: [
        // The server will only ever be notified about package.json files.
        {
          scheme: 'file',
          language: 'json',
          pattern: '**/package.json',
        },
      ],
      traceOutputChannel: outputChannel,
    }
  );
  context.subscriptions.push(
    client.onNotification(
      'window/logMessage',
      ({message}: {message: string}) => {
        // Log both to the output channel (when running in the IDE), and to
        // the console (when running as part of a test).
        outputChannel.appendLine(`languageServer: ${message}`);
        console.error(`languageServer: ${message}`);
      }
    )
  );

  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
