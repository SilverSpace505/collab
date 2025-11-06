
import * as vscode from 'vscode';

import {io} from 'socket.io-client';

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

(global as any).WebSocket = WebSocket;

const doc = new Y.Doc();

let uid = '';

const socket = io('https://collab.silverspace.io', {
  path: '/socket.io'
})

socket.on('connect', () => {
  vscode.window.showInformationMessage('connected to socket.io server with id: ' + socket.id)

  if (socket.id) uid = socket.id;
})

export function activate(context: vscode.ExtensionContext) {

	console.log("collab now activating")


  context.subscriptions.push(vscode.commands.registerCommand('collab.buffer', () => {
    vscode.window.showInformationMessage('testing buffers...')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('collab.joinRoom', async () => {
    const roomName = await vscode.window.showInputBox({prompt: 'Room name to join:', placeHolder: 'Room Name'})
    if (roomName) {
      vscode.window.showInformationMessage(`Joining room: ${roomName}`)
      const provider = new WebsocketProvider('wss://sync.silverspace.io', roomName, doc, {params: {uid, pass: 'silly'}})

      provider.on('status', (event) => {
        vscode.window.showInformationMessage(event.toString())
        if (event.status === "connected") {
          vscode.window.showInformationMessage('Connected to y-websocket server!')
        } else {
          vscode.window.showInformationMessage('oooop')
        }
      })
    } else {
      vscode.window.showWarningMessage('Invalid room name')
    }
  }))
}

export function deactivate() {}