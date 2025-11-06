
import * as vscode from 'vscode';

import {io} from 'socket.io-client';

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

(global as any).WebSocket = WebSocket;

interface RoomData {
  hasPass: boolean;
  users: number;
}

const doc = new Y.Doc();

let uid = '';

const socket = io('https://collab.silverspace.io', {
  path: '/socket.io'
})

socket.on('connect', () => {
  vscode.window.showInformationMessage('connected to socket.io server with id: ' + socket.id)

  if (socket.id) uid = socket.id;
})

async function createRoom() {
  const roomName = await vscode.window.showInputBox({placeHolder: 'Room Name'})
  const pass = await vscode.window.showInputBox({placeHolder: 'Password (leave blank for no password)'})
  if (roomName) {
    socket.emit('getRooms', (rooms: Record<string, RoomData>) => {
      const roomList = Object.keys(rooms);
      vscode.window.showInformationMessage(roomList.join(', '));
      console.log(rooms)
      if (roomList.includes(roomName)) {
        vscode.window.showWarningMessage('Room already exists.')
        createRoom()
        return;
      }

      const provider = new WebsocketProvider('wss://sync.silverspace.io', roomName, doc, {params: pass ? {uid, pass} : {uid}})

      provider.on('status', (event) => {
        if (event.status === "connected") {
          vscode.window.showInformationMessage('Connected to y-websocket server!')
        } else {
          vscode.window.showInformationMessage('oooop')
        }
      })
    })
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('collab.createRoom', createRoom))

  context.subscriptions.push(vscode.commands.registerCommand('collab.joinRoom', async () => {
    socket.emit('getRooms', async (rooms: Record<string, RoomData>) => {
      const roomName = await vscode.window.showQuickPick(Object.keys(rooms), {placeHolder: 'Room to join'})
      if (roomName) {
        let pass;
        if (rooms[roomName].hasPass) {
          pass = await vscode.window.showInputBox({placeHolder: 'Password'})
        }
        const provider = new WebsocketProvider('wss://sync.silverspace.io', roomName, doc, {params: pass ? {uid, pass} : {uid}})

        provider.on('status', (event) => {
          if (event.status === "connected") {
            vscode.window.showInformationMessage('Connected to y-websocket server!')
          } else {
            vscode.window.showInformationMessage('oooop')
          }
        })
      }
    })
  }))
}

export function deactivate() {}