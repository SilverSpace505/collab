
import * as vscode from 'vscode';

import {type Socket} from 'socket.io-client';

export const FILE_SYSTEM_SCHEME = 'collab'

export class FileProvider implements vscode.FileSystemProvider {
  socket: Socket;
  root: string;

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

  //////////////
  // AI code
  getPath(uri: vscode.Uri): string {
    let path = uri.path;

    path = path.replace(/^\/[^/]+/, '');
    
    if (path === '' || path === '/') {
      return '';
    }
    
    if (path.startsWith('/')) {
      path = path.substring(1);
    }
    
    return path;
  }
  //////////////

  requestStat(path: string): Promise<vscode.FileStat> {
    return new Promise((resolve, reject) => {
      this.socket.emit('statFile', path, (stat?: vscode.FileStat) => {
        if (!stat) return reject('server error');
        resolve(stat);
      }) 
      
    })
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const fileStat = await this.requestStat(this.getPath(uri));
      return fileStat;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }


  requestDirectory(path: string): Promise<[string, vscode.FileType][]> {
    return new Promise((resolve, reject) => {
      this.socket.emit('readDirectory', path, (files?: [string, vscode.FileType][]) => {
        if (!files) return reject('server error');
        resolve(files);
      }) 
      
    })
  }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const path = this.getPath(uri);
    try {
      const files = await this.requestDirectory(path);
      return files;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }


  //////////////
  // AI code
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
    const path = this.getPath(uri);
    
    // Register this path as being watched
    this.socket.emit('watchFile', path, options);
    
    // Listen for file change events from the host
    const listener = (events: Array<{ uri: string; type: vscode.FileChangeType }>) => {
      // Convert received events to proper FileChangeEvent objects
      const fileChangeEvents: vscode.FileChangeEvent[] = events.map(event => ({
        type: event.type,
        uri: vscode.Uri.parse(event.uri)
      }));
      
      this._emitter.fire(fileChangeEvents);
    };
  
    this.socket.on('fileChanged', listener);
    
    // Return disposable to clean up when VS Code stops watching
    return new vscode.Disposable(() => {
      this.socket.emit('unwatchFile', path);
      this.socket.off('fileChanged', listener);
    });
  }
  //////////////

  requestFile(path: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.socket.emit('readFile', path, (file?: Uint8Array) => {
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
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }


  requestCDirectory(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('createDirectory', path, () => {
        resolve();
      })
    })
  }
  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.requestCDirectory(this.getPath(uri));
    return;
  }


  requestWFile(path: string, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('writeFile', path, content, options, () => {
        resolve();
      })
    })
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
    await this.requestWFile(this.getPath(uri), content, options);
    return;
  }


  requestDFile(path: string, options: { readonly recursive: boolean; }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('deleteFile', path, options, () => {
        resolve();
      })
    })
  }
  async delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): Promise<void> {
    await this.requestDFile(this.getPath(uri), options);
    return;
  }


  requestRFile(path: string, newPath: string, options: { readonly overwrite: boolean; }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('renameFile', path, newPath, options, () => {
        resolve();
      })
    })
  }
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): Promise<void> {
    await this.requestRFile(this.getPath(oldUri), this.getPath(newUri), options);
    return;
  }
}