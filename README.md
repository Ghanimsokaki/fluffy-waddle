# Fluffy Waddle

A clean, single-file AI chat interface. No build step, no dependencies.

## Run

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Connect a model

Click **Settings** and enter an OpenAI-compatible chat endpoint
(`/v1/chat/completions`), model name and optional API key. Without an endpoint the app runs in demo mode.

Settings and chats are stored in your browser's `localStorage`. The API key is stored there in plain text, so use a scoped key.

## Features

- Light and dark themes (follows the system, with a manual toggle)
- Chat history sidebar, responsive on mobile
- Code blocks with a copy button
- Auto-growing input, Enter to send
