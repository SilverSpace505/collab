
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {

	console.log("collab now activating")


  context.subscriptions.push(vscode.commands.registerCommand('collab.buffer', () => {
    vscode.window.showInformationMessage('working! :)')
    ws.send("testing buffers...")
    ws.send(new Uint8Array([10, 20, 30]))
  }))
}

export function deactivate() {}

import * as Y from "yjs";
import WebSocket from "ws";

const doc = new Y.Doc();
const ws = new WebSocket("wss://colab.silverspace.io");

ws.on("open", () => {
  console.log("hello")
  ws.send(JSON.stringify({ type: "joinRoom", room: "my-room" }));
});

ws.on("message", (data: WebSocket.RawData) => {
  let update: Uint8Array;

  if (typeof data === "string") {
    const msg = JSON.parse(data);
    console.log("Control message:", msg);
    return;
  } else if (data instanceof Buffer) {
    update = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    update = new Uint8Array(data);
  } else if (Array.isArray(data)) {
    const length = data.reduce((sum, buf) => sum + buf.byteLength, 0);
    const temp = new Uint8Array(length);
    let offset = 0;
    for (const buf of data) {
      temp.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), offset);
      offset += buf.byteLength;
    }
    update = temp;
  } else {
    return;
  }

  Y.applyUpdate(doc, update);
});

doc.on("update", (update: Uint8Array) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(update);
  }
});

// Shared text
const yText = doc.getText("sharedText");

yText.observe(() => {
  console.log("Shared text:", yText.toString());
});
