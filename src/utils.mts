
import * as vscode from 'vscode';
import * as path from 'path';

export function getRelativePath(uri: vscode.Uri): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return undefined; 
  }

  return path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
}

export const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

export function createCursorDecoration(color: string) {
  const transparentColor = `${color}80`
  return vscode.window.createTextEditorDecorationType({
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color,
    backgroundColor: transparentColor,
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: false,
  });
}