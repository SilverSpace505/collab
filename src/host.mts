import * as vscode from 'vscode';

export async function getFileStats(relativePath: string): Promise<vscode.FileStat | undefined> {
    const absoluteUri = getAbsoluteUri(relativePath);

    if (!absoluteUri) {
        vscode.window.showErrorMessage('No workspace folder open to resolve the relative path.');
        return undefined;
    }

    try {
        // Use the File System API to get the FileStat object
        const stat: vscode.FileStat = await vscode.workspace.fs.stat(absoluteUri);
        return stat;
    } catch (error) {
        // Handle file not found (or other FS errors)
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            vscode.window.showWarningMessage(`File not found at: ${absoluteUri.path}`);
        } else {
            vscode.window.showErrorMessage(`Error getting file stats: ${error}`);
        }
        return undefined;
    }
}

export async function readDirectory(relativePath: string): Promise<[string, vscode.FileType][]> {
  const absoluteUri = getAbsoluteUri(relativePath);

  if (!absoluteUri) {
      vscode.window.showErrorMessage('No workspace folder open to resolve the relative path.');
      return [];
  }

  try {
    const entries: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(absoluteUri);

    // for (const [name, type] of entries) {
    //   console.log(`${name}: ${type === vscode.FileType.Directory ? 'Directory' : 'File'}`);
    // }

    return entries;

  } catch (error) {
    vscode.window.showErrorMessage(`Error reading directory: ${error}`);
    return [];
  }
}

export async function readFile(relativePath: string): Promise<Uint8Array | undefined> {
  const absoluteUri = getAbsoluteUri(relativePath);

  // console.log('reading file', absoluteUri?.path);

  if (!absoluteUri) {
      vscode.window.showErrorMessage('No workspace folder open to resolve the relative path.');
      return undefined;
  }

  try {
    // 3. Read the file using the workspace FileSystem API
    // This directly returns a Uint8Array.
    const fileData: Uint8Array = await vscode.workspace.fs.readFile(absoluteUri);
    return fileData;

  } catch (error) {
    // Handle errors, such as "File not found"
    console.error(`Error reading file ${absoluteUri.toString()}:`, error);
    vscode.window.showErrorMessage(`Could not read file: ${relativePath}`);
    return undefined;
  }
}

function getAbsoluteUri(relativePath: string): vscode.Uri | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }

    const rootUri = workspaceFolders[0].uri;

    // If relativePath is empty or just "/", return the root directly
    if (!relativePath || relativePath === '/' || relativePath === '') {
        return rootUri;
    }

    // Remove leading slash if present
    const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;

    return vscode.Uri.joinPath(rootUri, cleanPath);
}