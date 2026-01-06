# WebDrop
## Simple web page that lets people share files directly in browser.

Open the page, drop one or more files, and it creates a sharing session. Other people on the same page can see the session and download the files.

A live version is available to test on https://egeefes.com/webdrop

## How It Works
- The page connects to a WebSocket relay server
- When you choose files, it creates a session
- Receivers join the session and request the file, files are sent in chunks (64KB) over the WebSocket connection
- The receiver rebuilds the file in the browser and triggers a download

## Features
- Drag & drop or click to select files
- Share multiple files in one session
- Public or private sessions
- Display name customisation

## Tech Used
1. Single-page HTML + JavaScript
2. WebSockets for the relay connection
3. Cloudflare Workers

### How To Deploy
- Deploy the files in the [worker](/worker) folder to cloudflared and take note of the worker URL.
- In your [index.html](index.html) file, replace the worker websocket URL with yours in line 203.
- Host the HTML file either on your local machine or a hosting provider.

### Notes On Privacy
This app stores a username and session name in cookies (for convenience).
File contents are transferred via the configured WebSocket relay.

### License
GPL-3.0
