import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

// this file was used to get the file system, but it's not used for anything anymore

///////////////////
// AI Code
export interface FileNode {
  name: string;
  relativePath: string;
  isFile: boolean;
  children?: FileNode[];
}

async function readDirRecursive(
  rootPath: string,
  currentDir: string
): Promise<FileNode[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootPath, fullPath);

    const node: FileNode = {
      name: entry.name,
      relativePath,
      isFile: entry.isFile(),
    };

    if (entry.isDirectory()) {
      try {
        node.children = await readDirRecursive(rootPath, fullPath);
      } catch (err) {
        console.warn(`Skipping ${fullPath}: ${(err as Error).message}`);
      }
    }

    nodes.push(node);
  }

  return nodes;
}

export async function getWorkspaceTree(): Promise<
  Record<string, FileNode[]>
> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("No workspace is open.");
    return {};
  }

  const result: Record<string, FileNode[]> = {};

  for (const folder of workspaceFolders) {
    const rootPath = folder.uri.fsPath;
    const tree = await readDirRecursive(rootPath, rootPath);
    result[folder.name] = tree;
  }

  return result;
}
///////////////////