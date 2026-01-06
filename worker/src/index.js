// src/index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const id = env.ROOM.idFromName("lobby");
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/") return new Response("OK");
    return new Response("Not found", { status: 404 });
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.sessions = new Map(); // sessionId -> session object
    this.clients = new Map(); // ws -> client info
    this.observers = new Set(); // clients just observing (not in any session yet)
  }

  fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Add to observers initially
    this.observers.add(server);

    const safeSend = (ws, data) => {
      try {
        if (ws.readyState === 1) {
          ws.send(typeof data === 'string' ? data : JSON.stringify(data));
        }
      } catch (e) {
        console.error('Send error:', e);
      }
    };

    const broadcastSessionList = () => {
      const list = Array.from(this.sessions.entries()).map(([id, s]) => ({
        id,
        name: s.name,
        deviceName: s.deviceName,
        isPrivate: s.isPrivate,
        fileCount: s.meta?.count || 0,
        totalSize: s.meta?.totalSize || 0,
        files: s.meta?.files || []
      }));

      const msg = JSON.stringify({ type: "SESSION_LIST", sessions: list });

      // Broadcast to all observers
      for (const obs of this.observers) {
        safeSend(obs, msg);
      }

      // Also broadcast to all clients in sessions (receivers)
      for (const [ws, info] of this.clients) {
        if (info.role === 'recv') {
          safeSend(ws, msg);
        }
      }

      console.log('Broadcasted session list:', list.length, 'sessions to', this.observers.size, 'observers');
    };

    server.addEventListener("message", (evt) => {
      const msg = evt.data;

      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);

          // Request session list
          if (parsed.type === "GET_SESSIONS") {
            const list = Array.from(this.sessions.entries()).map(([id, s]) => ({
              id,
              name: s.name,
              deviceName: s.deviceName,
              isPrivate: s.isPrivate,
              fileCount: s.meta?.count || 0,
              totalSize: s.meta?.totalSize || 0,
              files: s.meta?.files || []
            }));
            safeSend(server, { type: "SESSION_LIST", sessions: list });
            return;
          }

          // Create new session
          if (parsed.type === "CREATE_SESSION") {
            const sessionId = crypto.randomUUID();
            const passcode = parsed.isPrivate ? this.generatePasscode() : null;

            this.sessions.set(sessionId, {
              sender: server,
              name: parsed.deviceName,
              deviceName: parsed.deviceName,
              isPrivate: parsed.isPrivate || false,
              passcode: passcode,
              meta: parsed.meta,
              receivers: new Set(),
              requested: new Set()
            });

            this.clients.set(server, { sessionId, role: 'send' });
            this.observers.delete(server); // Remove from observers

            safeSend(server, {
              type: "SESSION_CREATED",
              sessionId,
              passcode,
              isPrivate: parsed.isPrivate || false,
              name: parsed.deviceName
            });

            console.log('Session created:', sessionId, 'Name:', parsed.deviceName);
            broadcastSessionList();
            return;
          }

          // Update session name
          if (parsed.type === "UPDATE_SESSION_NAME") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'send') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                session.name = parsed.name;
                console.log('Session name updated:', clientInfo.sessionId, 'to', parsed.name);
                broadcastSessionList();
              }
            }
            return;
          }

          // Toggle privacy
          if (parsed.type === "TOGGLE_PRIVACY") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'send') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                session.isPrivate = !session.isPrivate;

                if (session.isPrivate) {
                  session.passcode = this.generatePasscode();
                } else {
                  session.passcode = null;
                }

                safeSend(server, {
                  type: "PRIVACY_TOGGLED",
                  isPrivate: session.isPrivate,
                  passcode: session.passcode
                });

                console.log('Session privacy toggled:', clientInfo.sessionId, 'isPrivate:', session.isPrivate);
                broadcastSessionList();
              }
            }
            return;
          }

          // Join session as receiver
          if (parsed.type === "JOIN_SESSION") {
            const session = this.sessions.get(parsed.sessionId);

            if (!session) {
              safeSend(server, { type: "ERROR", message: "Session not found" });
              return;
            }

            if (session.isPrivate && session.passcode !== parsed.passcode) {
              safeSend(server, { type: "ERROR", message: "Invalid Passcode" });
              return;
            }

            session.receivers.add(server);
            this.clients.set(server, { sessionId: parsed.sessionId, role: 'recv' });
            this.observers.delete(server); // Remove from observers

            safeSend(server, {
              type: "JOINED_SESSION",
              sessionId: parsed.sessionId,
              meta: session.meta
            });

            safeSend(session.sender, {
              type: "RECEIVER_JOINED",
              receiverCount: session.receivers.size
            });

            console.log('Receiver joined session:', parsed.sessionId);
            return;
          }

          // Request file download
          if (parsed.type === "REQUEST_FILE") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'recv') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                session.requested.add(server);
                safeSend(session.sender, { type: "START_SEND" });
                console.log('Download requested in session:', clientInfo.sessionId);
              }
            }
            return;
          }

          // Handle metadata from sender
          if (parsed.type === "metadata") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'send') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                for (const r of session.requested) {
                  safeSend(r, parsed);
                }
              }
            }
            return;
          }

          // Handle file complete
          if (parsed.type === "FILE_COMPLETE") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'send') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                for (const r of session.requested) {
                  safeSend(r, { type: "NEXT_FILE" });
                }
              }
            }
            return;
          }

          // Handle ready for next
          if (parsed.type === "READY_FOR_NEXT") {
            const clientInfo = this.clients.get(server);
            if (clientInfo && clientInfo.role === 'recv') {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                safeSend(session.sender, { type: "NEXT_FILE" });
              }
            }
            return;
          }

          // Leave session
          if (parsed.type === "LEAVE_SESSION") {
            const clientInfo = this.clients.get(server);
            if (clientInfo) {
              const session = this.sessions.get(clientInfo.sessionId);
              if (session) {
                if (clientInfo.role === 'send') {
                  // Sender is ending the session - close it completely
                  console.log('Sender ending session:', clientInfo.sessionId);
                  for (const r of session.receivers) {
                    safeSend(r, { type: "SESSION_CLOSED" });
                    try { r.close(); } catch {}
                  }
                  this.sessions.delete(clientInfo.sessionId);
                } else if (clientInfo.role === 'recv') {
                  // Receiver is leaving
                  session.receivers.delete(server);
                  session.requested.delete(server);
                  if (session.sender) {
                    safeSend(session.sender, {
                      type: "RECEIVER_LEFT",
                      receiverCount: session.receivers.size
                    });
                  }
                }
              }
              this.clients.delete(server);
              this.observers.add(server); // Back to observer
              safeSend(server, { type: "LEFT_SESSION" });

              // Broadcast updated session list immediately
              broadcastSessionList();
            }
            return;
          }

        } catch (e) {
          console.error("Parse error:", e);
        }
        return;
      }

      // Binary data from sender
      const clientInfo = this.clients.get(server);
      if (clientInfo && clientInfo.role === 'send') {
        const session = this.sessions.get(clientInfo.sessionId);
        if (session) {
          for (const r of session.requested) {
            try {
              if (r.readyState === 1) {
                r.send(msg);
              }
            } catch (e) {
              console.error('Binary send error:', e);
            }
          }
        }
      }
    });

    server.addEventListener("close", () => {
      const clientInfo = this.clients.get(server);

      if (clientInfo) {
        const session = this.sessions.get(clientInfo.sessionId);

        if (session) {
          if (clientInfo.role === 'send') {
            // Sender left, close entire session
            console.log('Sender left, closing session:', clientInfo.sessionId);
            for (const r of session.receivers) {
              safeSend(r, { type: "SESSION_CLOSED" });
              try { r.close(); } catch {}
            }
            this.sessions.delete(clientInfo.sessionId);
            broadcastSessionList();
          } else {
            // Receiver left
            session.receivers.delete(server);
            session.requested.delete(server);
            if (session.sender) {
              safeSend(session.sender, {
                type: "RECEIVER_LEFT",
                receiverCount: session.receivers.size
              });
            }
          }
        }

        this.clients.delete(server);
      }

      this.observers.delete(server);
    });

    server.addEventListener("error", (e) => {
      console.error('WebSocket error:', e);
      try { server.close(); } catch {}
    });

    // Send initial session list after a short delay
    setTimeout(() => {
      const list = Array.from(this.sessions.entries()).map(([id, s]) => ({
        id,
        name: s.name,
        deviceName: s.deviceName,
        isPrivate: s.isPrivate,
        fileCount: s.meta?.count || 0,
        totalSize: s.meta?.totalSize || 0,
        files: s.meta?.files || []
      }));
      safeSend(server, { type: "SESSION_LIST", sessions: list });
      console.log('Sent initial session list to new client:', list.length, 'sessions');
    }, 100);

    return new Response(null, { status: 101, webSocket: client });
  }

  generatePasscode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}