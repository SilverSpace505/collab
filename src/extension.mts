
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

// these are going to store the synced state of the text in the document and other's users
let doc: Y.Doc | undefined;
let ytext: Y.Text | undefined;
let cursors: Y.Map<{
  start: number;
  end: number;
  colour: string;
}> | undefined;

let uid = '';
let room = '';
let isHost = false;

let clientColour: string | undefined;

let provider: WebsocketProvider | undefined;
let suppressEditorChange: boolean | undefined;

let fileProvider: FileProvider | undefined;
let fileSystemProviderDisposable: vscode.Disposable | undefined;

// connect to socket.io server
const socket = io('https://collab.silverspace.io', {
  path: '/socket.io'
})

// triggers when connected to server
socket.on('connect', () => {
  // vscode.window.showInformationMessage('Connected with id: ' + socket.id)

  if (socket.id) uid = socket.id;

  // when loading into a new window, the connection state needs to be recovered
  recoverState()

  if (loadStatus) {
    loadStatus.text = `$(check-all) Server connected`;
    loadStatus.tooltip = 'Connected to socket.io server';
    loadStatus.backgroundColor = undefined;
  }
})

// triggers when user leaves room
socket.on('userLeft', (uid: string) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  // remove the user's cursors from the editor
  if (!cursors) return;
  cursors.delete(uid);

  // vscode.window.showInformationMessage(`deleting user cursor: ${uid}`)

  const deco = decorationTypes.get(uid);
  if (deco) {
    editor.setDecorations(deco, []);
  }
  decorationTypes.delete(uid);
});

// triggers when the host of the room leaves, so this client needs to disconnect
socket.on('roomDeleted', () => {
  vscode.window.showInformationMessage('Host closed room :(');

  // reset state
  room = '';
  isHost = false;

  // reset syncing state
  ytext = undefined;
  doc = undefined;
  cursors = undefined;
  clientColour = undefined;

  if (loadStatus) {
    loadStatus.text = `$(check-all) Server connected`;
    loadStatus.tooltip = 'Connected to socket.io server';
    loadStatus.backgroundColor = undefined;
  }

  // disconnect from yjs syncing server
  if (provider) provider.disconnect();

  // close virtual workspace of the collaboration environment
  vscode.commands.executeCommand('workbench.action.closeFolder');
});

// triggers when the user disocnnects from the socket.io server
socket.on('disconnect', () => {
  // vscode.window.showInformationMessage('Disconnected from server')

  if (workspaceWatcher) workspaceWatcher.dispose()

  const hasRoom = !!room && !isHost;

  // reset state
  uid = '';
  room = '';
  isHost = false;

  // reset sync state
  ytext = undefined;
  doc = undefined;
  cursors = undefined;
  clientColour = undefined;

  // disconnect from yjs syncing server
  if (provider) provider.disconnect();

  if (loadStatus) {
    loadStatus.text = `$(sync~spin) Server connecting`;
    loadStatus.tooltip = 'Connecting to socket.io server';
    loadStatus.backgroundColor = undefined;
  }

  // if the user is currently in a room, then close the virtual workspace
  if (hasRoom) vscode.commands.executeCommand('workbench.action.closeFolder');
})

// these series of callbacks take in requests from other users to read and write data to the host's system.
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

// creates a new room using the users's currently opened workspace
async function createRoom(context: vscode.ExtensionContext) {
  // first, ask for the name of the room and password
  const roomName = await vscode.window.showInputBox({placeHolder: 'Room Name'})
  const pass = await vscode.window.showInputBox({placeHolder: 'Password (leave blank for no password)'})
  
  // if they actually did type in a room name
  if (roomName) {
    // send a request to the server to create a room using the info
    socket.emit('createRoom', roomName, pass, async (response: string) => { // callback from server
      vscode.window.showInformationMessage(response);
      // if the room already exists, then try again.
      if (response == 'Room already exists') {
        createRoom(context)
        return;
      }
      // if the room was created successfully, update the state
      if (response == 'Created room') {
        room = roomName;
        isHost = true;
        socket.emit('workspaceTree', await getWorkspaceTree())

        // start the filesystem watcher that will update clients of this user with file changes 
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

        // if a file is currently open, connect to the corresponding syncing server
        connectToFile(file, editor)
      }
    })
  }
}

// join a room given a list of the availabale rooms
async function joinRoom(rooms: Record<string, RoomData>, troom: string, context: vscode.ExtensionContext) {
  // if the room has a password, then ask for one
  let pass;
  if (rooms[troom].hasPass) {
    pass = await vscode.window.showInputBox({placeHolder: 'Password'})
  }

  // send a request to the server to join a room
  socket.emit('joinRoom', troom, pass, (response: string) => { // callback from server
    vscode.window.showInformationMessage(response);
    // if the password was incorrect, then try again
    if (response == 'Wrong password') {
      joinRoom(rooms, troom, context)
      return;
    }
    // if the user successfully joins the room, then set the state
    if (response == 'Joined room') {
      room = troom;
      isHost = false;

      // store the user id and their room in the global state
      // required to maintain the connection and authentication accross the switching of workspaces
      // (when a new workspace is opened, the client disconnects from the server, and the state is normally lost)
      // a random number is generated to act as a temporary password to prevent other users from stealing the state
      const state = {uid, pass: Math.floor(Math.random() * 100000) + '', room}
      context.globalState.update('state', state);

      // the connection state of the user is then uploaded to the server
      socket.emit('saveState', state.pass, () => {
        if (fileProvider) fileProvider.root = room;

        // then the workspace is switched the collab workspace, so the host's files can be loaded in the new window
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

// given a relative path to the file, connect and manage the syncing on the content in the file
function connectToFile(file: string, editor: vscode.TextEditor) {
  if (loadStatus) {
    loadStatus.text = `$(sync~spin) Collab connecting`;
    loadStatus.tooltip = 'Connecting to yjs sync server';
    loadStatus.backgroundColor = undefined;
  }
  // if already connected to another syncing server, disconnect and remove any cursors
  if (provider) {
    if (cursors) {
      cursors.delete(uid)
    }
    provider.disconnect();
  }

  // generate a new random colour for the user's cursor to appear on other's editors
  clientColour = "#" + Math.floor(Math.random() * 0xffffff).toString(16);

  // create a syncing context
  doc = new Y.Doc();

  // get content of the file
  ytext = doc.getText('content');

  // get the cursors
  cursors = doc.getMap<{start: number; end: number; colour: string;}>('cursors');

  // connect to the syncing server, passing in the uid of the user to authenticate
  provider = new WebsocketProvider('wss://sync.silverspace.io', file, doc, {params: {uid}})

  // triggers once the user connects / disconnects
  provider.on('status', (event) => {
    if (event.status === "connected") {
      // vscode.window.showInformationMessage(`Connected to file: ${file}`)

      if (loadStatus) {
        loadStatus.text = `$(check-all) Collab connected`;
        loadStatus.tooltip = 'Connected to yjs sync server';
        loadStatus.backgroundColor = undefined;
      }
      
      // upload current cursor to synced state
      if (!cursors || !clientColour) return;
      cursors.set(uid, {
        start: editor.document.offsetAt(editor.selection.start),
        end: editor.document.offsetAt(editor.selection.end),
        colour: clientColour,
      });
    } else {
      // if (loadStatus) {
      //   loadStatus.text = `$(circle-slash) Collab disconnected`;
      //   loadStatus.tooltip = 'Failed to connect to yjs sync server';
      //   loadStatus.backgroundColor = undefined;
      // }
      // vscode.window.showInformationMessage(`Disconnected from file: ${file}`)
    }
  })

  suppressEditorChange = false;

  // triggers whenever a change in made from other users
  ytext.observe((event, transaction) => {
    if (transaction.origin === "local") return;

      if (suppressEditorChange || !ytext) return;

      const text = ytext.toString();
      const current = editor.document.getText();
      if (current === text) return;

      suppressEditorChange = true;
      // replace all the content in the file with the new version of the text
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

  // triggers whenenver the another user's cursor moves
  cursors.observe(() => {
    // for each cursor make a new text decoration to show the cursor
    const decorations: vscode.DecorationOptions[] = [];
    if (!cursors) return;
      for (const [id, cursorData] of cursors.entries()) {
        if (id === uid) continue;

        const data = cursorData as { start: number; end: number; colour: string };
        const start = editor.document.positionAt(data.start);
        const end = editor.document.positionAt(data.end);

        let deco = decorationTypes.get(id);
        if (!deco) {
          deco = createCursorDecoration(data.colour);
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

// the connection state of the user, used when joining rooms and mainting connection
let state: {uid: string, pass: string, room: string} | undefined;

// this signals to the server that the client wants to transfer the state of the old connection to the new one
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

  // if in a collab workspace, but there's no active connection trying to be made, close the workspace
  if (isCollabWorkspace) {
    if (!state) {
      vscode.window.showErrorMessage('Room closed.');
      vscode.commands.executeCommand('workbench.action.closeFolder');
      return;
    }
  }

  // if joining a room and connected, then recover the connection state
  if (socket.connected) {
    recoverState()
  }

  // remove the connection state
  context.globalState.update('state', undefined);

  // adds a Create Room command to the command palette
  context.subscriptions.push(vscode.commands.registerCommand('collab.createRoom', () => {createRoom(context)}))

  // adds a Join Room command to the command palette
  context.subscriptions.push(vscode.commands.registerCommand('collab.joinRoom', async () => {
    // first, get the list of rooms, then let the user choose which one to join
    socket.emit('getRooms', async (rooms: Record<string, RoomData>) => {
      const roomName = await vscode.window.showQuickPick(Object.keys(rooms), {placeHolder: 'Room to join'})
      if (roomName) {
        joinRoom(rooms, roomName, context)
      }
    })
  }))

  // adds a Leave Room command to the command palette
  context.subscriptions.push(vscode.commands.registerCommand('collab.leaveRoom', () => {
    // disconnect from the yjs syncing server
    if (provider) provider.disconnect();

    // first, let the server remove the user from it's state, then continue
    socket.emit('leaveRoom', () => {
      vscode.window.showInformationMessage('Left room');
      const wasHost = isHost;
      room = '';
      isHost = false;

      if (workspaceWatcher) workspaceWatcher.dispose()

      // clear syncing state
      ytext = undefined;
      doc = undefined;
      cursors = undefined;
      clientColour = undefined;

      if (loadStatus) {
        loadStatus.text = `$(check-all) Server connected`;
        loadStatus.tooltip = 'Connected to socket.io server';
        loadStatus.backgroundColor = undefined;
      }

      // if not the host, then close the workspace
      if (!wasHost) vscode.commands.executeCommand('workbench.action.closeFolder');
    })
  }))

  // used for debugging at some point
  context.subscriptions.push(vscode.commands.registerCommand('collab.debugTest', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    socket.emit('statFile', getRelativePath(editor.document.uri), (stat: vscode.FileStat) => {
      console.log(stat);
    }) 
  }))

  // triggers whenever the user switches the file they have open
  vscode.window.onDidChangeActiveTextEditor((event) => {
    if (!event) return;
    // if the user is in a room, get the current file and connect to the syncing server for that file
    const file = getRelativePath(event.document.uri);
    if (!file || !room) return;
    connectToFile(file, event)
  })

  // triggers whenever the user makes a change to the text document
  vscode.workspace.onDidChangeTextDocument((event) => {
    const cytext = ytext;
    if (!cytext) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;

    if (suppressEditorChange) return;

    // update synced yjs text with new document contents
    if (cytext.doc) cytext.doc.transact(() => {
      cytext.delete(0, cytext.length);
      cytext.insert(0, editor.document.getText());
    }, "local");
  });

  // triggers whenever the user changes or moves their cursor selection on the document
  vscode.window.onDidChangeTextEditorSelection((event) => {
    const editor = event.textEditor;
    if (!editor) return;

    // update synced cursor state with new cursor position
    if (!cursors || !clientColour) return;
    cursors.set(uid, {
      start: editor.document.offsetAt(editor.selection.start),
      end: editor.document.offsetAt(editor.selection.end),
      colour: clientColour,
    });
  })

  // triggers only one time once the user connects to the main socket.io server
  socket.once('connect', async () => {
    // sets up the file provider for the room so that the client user can read the host's files
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