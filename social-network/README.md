# Circle - Social Network Platform (Task 4)

Features: profiles, posts, photo sharing, likes, comments, friend requests,
real-time updates (WebSockets), notifications, privacy settings.

## Run
Windows shortcut: double-click start.bat (it starts the server and opens the browser).
Do NOT double-click public/index.html - it only works through the server.

1. Install Node.js 18 or newer (https://nodejs.org)
2. Open a terminal in this folder and start the server with: npm start
3. Open http://localhost:3000 in two different browsers (or one normal + one private window)
4. Create two accounts, add each other as friends and post - updates appear instantly.

No npm install needed: the WebSocket server uses only built-in Node.js modules.
Data is stored in data.json (created automatically). Delete it to reset.
