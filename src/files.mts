
import * as vscode from 'vscode';

import {type Socket} from 'socket.io-client';

export const FILE_SYSTEM_SCHEME = 'collab-fs'

export class FileProvider implements vscode.FileSystemProvider {
  socket: Socket;
  root: string;

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  constructor(socket: Socket) {
    this.root = '';
    this.socket = socket;
  }

  async waitForConnection(): Promise<void> {
    if (this.socket.connected) {
      return;
    }

    return new Promise((resolve) => {
      this.socket.on('connect', () => {
        resolve();
      });
    });
  }

 getPath(uri: vscode.Uri): string {
  // uri.path will be like "/roomname/src/file.ts" or "/roomname" or "/roomname/"
  let path = uri.path;
  
  // Remove the first segment (room name)
  // "/roomname/src/file.ts" -> "/src/file.ts"
  // "/roomname/" -> "/"
  // "/roomname" -> ""
  path = path.replace(/^\/[^/]+/, '');
  
  // Now handle the cleaned path
  if (path === '' || path === '/') {
    return '';
  }
  
  // Remove leading slash for socket requests
  if (path.startsWith('/')) {
    path = path.substring(1);
  }
  
  return path;
}


  requestStat(path: string): Promise<vscode.FileStat> {
    return new Promise((resolve, reject) => {
      // const tid = setTimeout(reject, 5000);
      this.socket.emit('statFile', path, (stat?: vscode.FileStat) => {
        // clearTimeout(tid);
        if (!stat) return reject('server error');
        resolve(stat);
      }) 
      
    })
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    // if (uri.path == `/${this.root}`) return {
    //   type: vscode.FileType.Directory,
    //   ctime: Date.now(),
    //   mtime: Date.now(),
    //   size: 0
    // };
    try {
      const fileStat = await this.requestStat(this.getPath(uri));
      return fileStat;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }


  requestDirectory(path: string): Promise<[string, vscode.FileType][]> {
    return new Promise((resolve, reject) => {
      // const tid = setTimeout(reject, 5000);
      this.socket.emit('readDirectory', path, (files?: [string, vscode.FileType][]) => {
        // clearTimeout(tid);
        if (!files) return reject('server error');
        resolve(files);
      }) 
      
    })
  }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const path = this.getPath(uri);
    
    try {
      const files = await this.requestDirectory(path);
      // console.log('readDirectory got files:', files);
      return files;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }


  watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
    return { dispose: () => {} } // change later
  }


  requestFile(path: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      // const tid = setTimeout(reject, 5000);
      this.socket.emit('readFile', path, (file?: Uint8Array) => {
        // clearTimeout(tid);
        if (!file) return reject('server error');
        resolve(file);
      })
      
    })
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const file = await this.requestFile(this.getPath(uri));
      return file;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri); // change later
    }
  }

  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): void | Thenable<void> {
    
  }

  delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): void | Thenable<void> {
    
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
    
  }
}