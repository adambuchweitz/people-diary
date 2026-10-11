# Diary

A small journal that connects to [People](https://people.buchweitz.life).
Mention someone in an entry, and People keeps a memory of it on their page,
where your other apps and agents can find it.

Diary is the reference app for **Connect with People**. It uses only what the
[developer guide](https://people.buchweitz.life/developers.md) documents, so if
you're adding People to your own app, this is a working example to read or
copy.

## Run it

```sh
npm install
npm run dev
```

Then open http://localhost:5174 and click **Connect with People**. You'll sign
in to People (or make an account), approve Diary, and come back.

Diary runs on your own computer and keeps your entries in this browser. Only
the parts about people go to People.

To connect to a People of your own, copy `.env.example` to `.env.local` and set
`VITE_PEOPLE_API`.

## What it does with People

- **Typing `@`** searches your people and links whoever you pick.
- **Saving** an entry makes one memory per person mentioned: kind
  `diary-entry`, dated the day the entry is about, with the sentences that
  mention them as its summary, and the entry's photos attached. People signs
  it `diary`.
- **Editing** the entry updates those memories. **Removing a mention** deletes
  its memory, and **deleting the entry** deletes them all.
- **Hovering** a person under the entry shows what People knows about them,
  including the latest memory and which app wrote it.

Saving twice changes nothing: creates carry an idempotency key, so a retry
after a dropped connection replays instead of making a duplicate. Diary asks
for `people:write`, which lets it add memories and change only its own.

## Where to look

| File | What's in it |
| --- | --- |
| [`src/people.ts`](src/people.ts) | Connect with People, start to finish: registering, PKCE, the callback, tokens, refreshing, signing out, and the API calls. Nothing in it is specific to Diary, so it's the file to copy. |
| [`src/sync.ts`](src/sync.ts) | Keeps People's memories in step with an entry. |
| [`src/store.ts`](src/store.ts) | Entries, in IndexedDB. |
| [`src/App.tsx`](src/App.tsx) | The journal itself. |

`npm test` runs the tests for the sync rules and PKCE.

## Trade-offs, on purpose

- **Entries live in one browser.** Clear its storage and they're gone; the
  memories in People stay. A real journal would sync entries somewhere.
- **The refresh token is in `localStorage`,** where any script on this origin
  could read it. Diary loads no scripts it doesn't control. A hosted app would
  keep tokens on its server.
- **It registers as a local app.** An app on `localhost` can't host a client
  metadata document, so it registers with People instead and is asked to
  approve every time it connects. A hosted app would publish a metadata
  document; see the guide.

## License

MIT
