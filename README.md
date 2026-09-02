# JanitorAI Full Export

Tampermonkey userscript that exports your whole JanitorAI account as one JSON file: every chat with every message, the character cards behind them, and every lorebook that is reachable from your session.

Install from Greasy Fork: https://greasyfork.org/en/scripts/593605-janitorai-full-export

Everything runs in your own browser. Nothing is sent to anyone.

## How to use

1. Install a userscript manager. Tampermonkey works on Chrome, Edge, Brave, Firefox, and Firefox for Android.
   https://www.tampermonkey.net/
2. Open the Greasy Fork page above and click "Install this script".
3. Go to https://janitorai.com and log in.
4. A pink "Export all" button appears in the bottom right corner. Click it and wait. The button shows progress.
5. When it finishes, a file named `janitorai-full-YYYY-MM-DD.json` is downloaded.

On Android only Firefox works, because Chrome for Android has no extensions. Keep the screen on and stay in Firefox until the export finishes.

## Import into Uno Chat

Go to https://unorouter.com/en/chat, open the three dots menu in the top right, then Tools, then Import / Export / Debug, then Import chat, and pick the downloaded file. Chats, characters, and lorebooks come in together.

## What it exports

- every character you have chatted with: name, description, personality, scenario, example dialogs, first message, alternate greetings, tags, avatar (URL plus the image inlined as data)
- every chat: all messages including swipes (`is_main` marks the chosen response), the persona used in that chat
- every lorebook attached to those characters, including private ones, because JanitorAI still resolves them into the prompt it builds for a generation
- a `skipped` list naming everything that could not be fetched, with the reason

## What it cannot export

A character whose creator hid the definition AND turned proxy access off. Both flags closed means the text is never assembled anywhere the browser can see it. The chat history for that character is still exported in full. Such cards show up in the `skipped` list.

## Output shape

```json
{
  "exported_at": "2026-08-30T16:00:00.000Z",
  "characters": {
    "<character_id>": {
      "name": "...",
      "description": "...",
      "lorebooks": [],
      "chats": [{ "id": "...", "persona": {}, "messages": [] }]
    }
  },
  "skipped": [{ "character": "...", "what": "definition", "why": "..." }]
}
```

## License

MIT
