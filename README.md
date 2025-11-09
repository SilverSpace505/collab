**Collab - Realtime Collaboration in VSCode!**

This is an extension for vscode that uses yjs-websocket in combination with a socket.io server to enable realtime collaboration in vscode.

**Features**
- Create and join rooms
- See host's files
- See changes in realtime
- See other's cursors

**Todo**
- Saving and file watching from client side
- Always available server hosted rooms
- Friends system for quick room management
- Maybe class managment system for teachers

 **Known bugs**
 - Document sometimes duplicates when multple users are typing.
 - When the host closes the room, other users don't disconnect properly.
 - Cursors fall out of sync when typing
 - Typing in the document moves other's cursors
 - Typing causes other's documents to flash white
