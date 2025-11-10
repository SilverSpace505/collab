
import * as vscode from 'vscode';

import {io} from 'socket.io-client';

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { createCursorDecoration, decorationTypes, getRelativePath, getRelativePathUri } from './utils.mjs';
import { FileNode, getWorkspaceTree } from './scan.mjs';
import { createDirectory, deleteFile, getAbsoluteUri, getFileStats, readDirectory, readFile, renameFile, writeFile } from './host.mjs';

import { FILE_SYSTEM_SCHEME, FileProvider } from './files.mjs';

(global as any).WebSocket = WebSocket;

interface RoomData {
  hasPass: boolean;
  users: number;
}

let workspaceWatcher: vscode.FileSystemWatcher | undefined;

let loadStatus: vscode.StatusBarItem | undefined;

let doc: Y.Doc | undefined;
let ytext: Y.Text | undefined;
let cursors: Y.Map<{
  start: number;
  end: number;
  color: string;
}> | undefined;

let uid = '';
let room = '';
let isHost = false;

let clientColor: string | undefined;

let provider: WebsocketProvider | undefined;
let suppressEditorChange: boolean | undefined;

let fileProvider: FileProvider | undefined;
let fileSystemProviderDisposable: vscode.Disposable | undefined;

const socket = io('https://collab.silverspace.io', {
  path: '/socket.io'
})

socket.on('connect', () => {
  // vscode.window.showInformationMessage('Connected with id: ' + socket.id)

  if (socket.id) uid = socket.id;

  recoverState()

  if (loadStatus) {
    loadStatus.text = `$(check-all) Server connected`;
    loadStatus.tooltip = 'Connected to socket.io server';
    loadStatus.backgroundColor = undefined;
  }
})

socket.on('userLeft', (uid: string) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (!cursors) return;
  cursors.delete(uid);

  // vscode.window.showInformationMessage(`deleting user cursor: ${uid}`)

  const deco = decorationTypes.get(uid);
  if (deco) {
    editor.setDecorations(deco, []);
  }
  decorationTypes.delete(uid);
});

socket.on('roomDeleted', () => {
  vscode.window.showInformationMessage('Host closed room :(');

  room = '';
  isHost = false;

  ytext = undefined;
  doc = undefined;
  cursors = undefined;
  clientColor = undefined;

  if (loadStatus) {
    loadStatus.text = `$(check-all) Server connected`;
    loadStatus.tooltip = 'Connected to socket.io server';
    loadStatus.backgroundColor = undefined;
  }

  if (provider) provider.disconnect();

  vscode.commands.executeCommand('workbench.action.closeFolder');
});

socket.on('disconnect', () => {
  // vscode.window.showInformationMessage('Disconnected from server')

  if (workspaceWatcher) workspaceWatcher.dispose()

  const hasRoom = !!room && !isHost;

  // reset state
  uid = '';
  room = '';
  isHost = false;

  ytext = undefined;
  doc = undefined;
  cursors = undefined;
  clientColor = undefined;

  if (provider) provider.disconnect();

  if (loadStatus) {
    loadStatus.text = `$(sync~spin) Server connecting`;
    loadStatus.tooltip = 'Connecting to socket.io server';
    loadStatus.backgroundColor = undefined;
  }

  if (hasRoom) vscode.commands.executeCommand('workbench.action.closeFolder');
})


socket.on('statFile', async (uri: string, callback) => {
  callback(await getFileStats(uri));
});
socket.on('readDirectory', async (uri: string, callback) => {
  callback(await readDirectory(uri));
});
socket.on('readFile', async (uri: string, callback) => {
  callback(await readFile(uri));
});

socket.on('createDirectory', async (uri: string, callback) => {
  callback(await createDirectory(uri))
});
socket.on('writeFile', async (uri: string, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }, callback) => {
  await writeFile(uri, content, options)

  ///////////
  // AI code
  // If the host has this file open, save it to clear the dirty indicator
  const absoluteUri = getAbsoluteUri(uri);
  if (absoluteUri) {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === absoluteUri.toString());
    if (doc && doc.isDirty) {
      await doc.save();
    }
  }
  ///////////

  callback()
});
socket.on('deleteFile', async (uri: string, options: { readonly recursive: boolean; }, callback) => {
  callback(await deleteFile(uri, options))
});
socket.on('renameFile', async (uri: string, newuri: string, options: { readonly overwrite: boolean; }, callback) => {
  callback(await renameFile(uri, newuri, options))
});

///////////////
// AI code
// Add handler for when files change (host saves or external changes)
socket.on('fileChanged', async (changes: Array<{uri: string, type: vscode.FileChangeType}>) => {
  for (const change of changes) {
    // Find if we have this file open
    const doc = vscode.workspace.textDocuments.find(d => getRelativePathUri(d.uri) === change.uri);
    if (doc && doc.isDirty) {
      // Host saved their file, so save ours too to clear the dot
      await doc.save();
    }
    // if (change.type === vscode.FileChangeType.d) {
      
    // }
  }
});
///////////////

async function createRoom(context: vscode.ExtensionContext) {
  const roomName = await vscode.window.showInputBox({placeHolder: 'Room Name'})
  const pass = await vscode.window.showInputBox({placeHolder: 'Password (leave blank for no password)'})
  if (roomName) {
    socket.emit('createRoom', roomName, pass, async (response: string) => {
      vscode.window.showInformationMessage(response);
      if (response == 'Room already exists') {
        createRoom(context)
        return;
      }
      if (response == 'Created room') {
        room = roomName;
        isHost = true;
        socket.emit('workspaceTree', await getWorkspaceTree())

        // Create the watcher
        workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');

        workspaceWatcher.onDidCreate(uri => {
          socket.emit('fileChanged', [{ uri: getRelativePathUri(uri), type: vscode.FileChangeType.Created }]);
        });

        workspaceWatcher.onDidChange(uri => {
          socket.emit('fileChanged', [{ uri: getRelativePathUri(uri), type: vscode.FileChangeType.Changed }]);
        });

        workspaceWatcher.onDidDelete(uri => {
          socket.emit('fileChanged', [{ uri: getRelativePathUri(uri), type: vscode.FileChangeType.Deleted }]);
        });

        context.subscriptions.push(workspaceWatcher);

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const file = getRelativePath(editor.document.uri);
        if (!file || !room) return;
        connectToFile(file, editor)
      }
    })
  }
}

async function joinRoom(rooms: Record<string, RoomData>, troom: string, context: vscode.ExtensionContext) {
  let pass;
  if (rooms[troom].hasPass) {
    pass = await vscode.window.showInputBox({placeHolder: 'Password'})
  }

  socket.emit('joinRoom', troom, pass, (response: string) => {
    vscode.window.showInformationMessage(response);
    if (response == 'Wrong password') {
      joinRoom(rooms, troom, context)
      return;
    }
    if (response == 'Joined room') {
      room = troom;
      isHost = false;

      const state = {uid, pass: Math.floor(Math.random() * 100000) + '', room}
      context.globalState.update('state', state);
      socket.emit('saveState', state.pass, () => {
        if (fileProvider) fileProvider.root = room;

        const workspaceUri = vscode.Uri.parse(`${FILE_SYSTEM_SCHEME}://collab/${room}/`);
        vscode.commands.executeCommand('vscode.openFolder', workspaceUri, { forceNewWindow: false });

        // const editor = vscode.window.activeTextEditor;
        // if (!editor) return;
        // const file = getRelativePath(editor.document.uri);
        // if (!file || !room) return;
        // connectToFile(file, editor)
      })
    }
  })
}

function connectToFile(file: string, editor: vscode.TextEditor) {
  if (loadStatus) {
    loadStatus.text = `$(sync~spin) Collab connecting`;
    loadStatus.tooltip = 'Connecting to yjs sync server';
    loadStatus.backgroundColor = undefined;
  }
  if (provider) {
    if (cursors) {
      cursors.delete(uid)
    }
    provider.disconnect();
  }

  clientColor = "#" + Math.floor(Math.random() * 0xffffff).toString(16);

  doc = new Y.Doc();

  ytext = doc.getText('content');

  cursors = doc.getMap<{start: number; end: number; color: string;}>('cursors');

  provider = new WebsocketProvider('wss://sync.silverspace.io', file, doc, {params: {uid}})

  provider.on('status', (event) => {
    if (event.status === "connected") {
      // vscode.window.showInformationMessage(`Connected to file: ${file}`)

      if (loadStatus) {
        loadStatus.text = `$(check-all) Collab connected`;
        loadStatus.tooltip = 'Connected to yjs sync server';
        loadStatus.backgroundColor = undefined;
      }
    
      if (!cursors || !clientColor) return;
      cursors.set(uid, {
        start: editor.document.offsetAt(editor.selection.start),
        end: editor.document.offsetAt(editor.selection.end),
        color: clientColor,
      });
    } else {
      if (loadStatus) {
        loadStatus.text = `$(circle-slash) Collab disconnected`;
        loadStatus.tooltip = 'Failed to connect to yjs sync server';
        loadStatus.backgroundColor = undefined;
      }
      // vscode.window.showInformationMessage(`Disconnected from file: ${file}`)
    }
  })

  suppressEditorChange = false;

  ytext.observe((event, transaction) => {
    if (transaction.origin === "local") return;

      if (suppressEditorChange || !ytext) return;

      const text = ytext.toString();
      const current = editor.document.getText();
      if (current === text) return;

      suppressEditorChange = true;
      editor.edit((editBuilder) => {
        editBuilder.replace(
          new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(current.length)
          ),
          text
        );
      }).then(() => suppressEditorChange = false);
  })

  cursors.observe(() => {
    const decorations: vscode.DecorationOptions[] = [];
    if (!cursors) return;
      for (const [id, cursorData] of cursors.entries()) {
        if (id === uid) continue;

        const data = cursorData as { start: number; end: number; color: string };
        const start = editor.document.positionAt(data.start);
        const end = editor.document.positionAt(data.end);

        let deco = decorationTypes.get(id);
        if (!deco) {
          deco = createCursorDecoration(data.color);
          decorationTypes.set(id, deco);
        }

        decorations.push({ range: new vscode.Range(start, end) });
        editor.setDecorations(deco, decorations);
      }
      const keys = Array.from(cursors.keys());
      const decoKeys = decorationTypes.keys();
      for (const deco of decoKeys) {
        if (!keys.includes(deco)) {
          const deco2 = decorationTypes.get(deco)
          if (!deco2) continue;
          editor.setDecorations(deco2, [])
          decorationTypes.delete(deco)
        }
      }
  })
}

let state: {uid: string, pass: string, room: string} | undefined;

function recoverState() {
  if (!state) return;
  socket.emit('recoverState', state.uid, state.pass)
  room = state.room;
}

export async function activate(context: vscode.ExtensionContext) {

  state = context.globalState.get('state');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const isCollabWorkspace = workspaceFolders?.some(
    folder => folder.uri.scheme === FILE_SYSTEM_SCHEME
  );

  if (isCollabWorkspace) {
    if (!state) {
      vscode.window.showErrorMessage('Room closed.');
      vscode.commands.executeCommand('workbench.action.closeFolder');
      return;
    }
  }

  if (socket.connected) {
    recoverState()
  }
  context.globalState.update('state', undefined);

  context.subscriptions.push(vscode.commands.registerCommand('collab.createRoom', () => {createRoom(context)}))

  context.subscriptions.push(vscode.commands.registerCommand('collab.joinRoom', async () => {
    socket.emit('getRooms', async (rooms: Record<string, RoomData>) => {
      const roomName = await vscode.window.showQuickPick(Object.keys(rooms), {placeHolder: 'Room to join'})
      if (roomName) {
        joinRoom(rooms, roomName, context)
      }
    })
  }))

  context.subscriptions.push(vscode.commands.registerCommand('collab.leaveRoom', () => {
    if (provider) provider.disconnect();
    socket.emit('leaveRoom', () => {
      vscode.window.showInformationMessage('Left room');
      const wasHost = isHost;
      room = '';
      isHost = false;

      if (workspaceWatcher) workspaceWatcher.dispose()

      ytext = undefined;
      doc = undefined;
      cursors = undefined;
      clientColor = undefined;

      if (loadStatus) {
        loadStatus.text = `$(check-all) Server connected`;
        loadStatus.tooltip = 'Connected to socket.io server';
        loadStatus.backgroundColor = undefined;
      }

      if (!wasHost) vscode.commands.executeCommand('workbench.action.closeFolder');
    })
  }))

  context.subscriptions.push(vscode.commands.registerCommand('collab.debugTest', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    socket.emit('statFile', getRelativePath(editor.document.uri), (stat: vscode.FileStat) => {
      console.log(stat);
    }) 
  }))

  vscode.window.onDidChangeActiveTextEditor((event) => {
    if (!event) return;
    const file = getRelativePath(event.document.uri);
    if (!file || !room) return;
    connectToFile(file, event)
  })

  vscode.workspace.onDidChangeTextDocument((event) => {
    const cytext = ytext;
    if (!cytext) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;

    if (suppressEditorChange) return;

    if (cytext.doc) cytext.doc.transact(() => {
      cytext.delete(0, cytext.length);
      cytext.insert(0, editor.document.getText());
    }, "local");
  });

  vscode.window.onDidChangeTextEditorSelection((event) => {
    const editor = event.textEditor;
    if (!editor) return;

    if (!cursors || !clientColor) return;
    cursors.set(uid, {
      start: editor.document.offsetAt(editor.selection.start),
      end: editor.document.offsetAt(editor.selection.end),
      color: clientColor,
    });
  })

  socket.once('connect', async () => {
    fileProvider = new FileProvider(socket);
    await fileProvider.waitForConnection();
    fileProvider.root = room;
    console.log(room, fileProvider.root)
    console.log("connected to server")
    fileSystemProviderDisposable = vscode.workspace.registerFileSystemProvider(
      FILE_SYSTEM_SCHEME,
      fileProvider,
      { isCaseSensitive: true }
    );
    context.subscriptions.push(fileSystemProviderDisposable);
  })

  loadStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  loadStatus.show()
  loadStatus.text = `$(sync~spin) Server connecting`;
  loadStatus.tooltip = 'Connecting to socket.io server';
  loadStatus.backgroundColor = undefined;
  
  context.subscriptions.push(loadStatus);
}

export function deactivate() {
  if (fileSystemProviderDisposable) {
    fileSystemProviderDisposable.dispose();
  }
}