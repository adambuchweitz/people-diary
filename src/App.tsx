import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  NotConnected,
  connect,
  disconnect,
  finishConnect,
  isCallback,
  isConnected,
  people,
  type Person,
  type PersonExport,
} from "./people";
import { deleteEntry, listEntries, newEntry, saveEntry, type Entry } from "./store";
import { entryTitle, forgetEntry, presentMentions, syncEntry } from "./sync";

/** The callback is handled once, even when React runs effects twice. */
let finishing: Promise<void> | null = null;

/** A photo, with its object URL let go when it's no longer shown. */
function Thumb({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={name} />;
}

/** The button from the developer guide. */
function ConnectButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="connect-with-people" onClick={onClick} disabled={busy}>
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="20" cy="16" r="9" fill="#8fd3cb" />
        <circle cx="12" cy="16" r="8.25" fill="none" stroke="#fff" strokeWidth="2.5" />
      </svg>
      {busy ? "Connecting" : "Connect with People"}
    </button>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** What People knows about someone, on hover. */
function PersonCard({ personId, cache }: { personId: string; cache: Map<string, Promise<PersonExport>> }) {
  const [data, setData] = useState<PersonExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!cache.has(personId)) cache.set(personId, people.export(personId));
    cache.get(personId)!.then(
      (value) => live && setData(value),
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [personId, cache]);
  if (error) return <div className="person-card">{error}</div>;
  if (!data) return <div className="person-card">Asking People…</div>;
  const latest = [...data.memories].sort((a, b) =>
    (b.happenedAt ?? b.createdAt).localeCompare(a.happenedAt ?? a.createdAt),
  )[0];
  const { person } = data;
  return (
    <div className="person-card" role="tooltip">
      <strong>{person.displayName}</strong>
      {person.relationshipLabel ? <span>{person.relationshipLabel}</span> : null}
      {person.birthday ? <span>Birthday {person.birthday}</span> : null}
      {person.preferences.length ? <span>Likes {person.preferences.join(", ")}</span> : null}
      {latest ? (
        <span className="person-card-memory">
          Latest: {latest.title}
          {latest.contributorSignature ? ` · from ${latest.contributorSignature}` : ""}
        </span>
      ) : (
        <span className="person-card-memory">No memories yet.</span>
      )}
    </div>
  );
}

/** The `@name` being typed just before the caret, if any. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N} .'-]{0,40})?$/u.exec(before);
  if (!match) return null;
  return { start: before.length - (match[2]?.length ?? 0) - 1, query: (match[2] ?? "").trimEnd() };
}

function Editor({
  entry,
  connected,
  onChange,
  onSave,
  onDelete,
  status,
}: {
  entry: Entry;
  connected: boolean;
  onChange: (entry: Entry) => void;
  onSave: () => void;
  onDelete: () => void;
  status: string | null;
}) {
  const body = useRef<HTMLTextAreaElement>(null);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [matches, setMatches] = useState<Person[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Where the caret sat after inserting a mention and its space. */
  const pickedAt = useRef<number | null>(null);
  const cache = useMemo(() => new Map<string, Promise<PersonExport>>(), []);

  useEffect(() => {
    if (!picker || !connected) return setMatches([]);
    let live = true;
    const timer = setTimeout(() => {
      people.search(picker.query).then(
        (found) => live && (setMatches(found), setHighlight(0)),
        () => live && setMatches([]),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [picker, connected]);

  const onBody = (event: ChangeEvent<HTMLTextAreaElement>) => {
    let text = event.target.value;
    let caret = event.target.selectionStart;
    // "@Maya Chen ." reads oddly: punctuation right after a picked mention
    // takes the place of the space that came with it.
    if (pickedAt.current !== null && caret === pickedAt.current + 1 && /[.,!?;:)]/.test(text[caret - 1] ?? "") && text[caret - 2] === " ") {
      text = text.slice(0, caret - 2) + text.slice(caret - 1);
      caret -= 1;
      const at = caret;
      requestAnimationFrame(() => body.current?.setSelectionRange(at, at));
    }
    pickedAt.current = null;
    onChange({ ...entry, body: text });
    setPicker(mentionQuery(text, caret));
  };

  const pick = (person: Person) => {
    if (!picker) return;
    const caret = body.current?.selectionStart ?? entry.body.length;
    const inserted = `@${person.displayName} `;
    const text = entry.body.slice(0, picker.start) + inserted + entry.body.slice(caret);
    const mentions = entry.mentions.some((m) => m.personId === person.id)
      ? entry.mentions
      : [...entry.mentions, { personId: person.id, name: person.displayName }];
    onChange({ ...entry, body: text, mentions });
    setPicker(null);
    const at = picker.start + inserted.length;
    pickedAt.current = at;
    requestAnimationFrame(() => {
      body.current?.focus();
      body.current?.setSelectionRange(at, at);
    });
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!picker || !matches.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(matches[highlight]!);
    } else if (event.key === "Escape") {
      setPicker(null);
    }
  };

  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    const photos = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, type: file.type, blob: file as Blob }));
    onChange({ ...entry, photos: [...entry.photos, ...photos] });
  };

  const present = presentMentions(entry);

  return (
    <article className="editor">
      <div className="editor-meta">
        <input type="date" value={entry.date} onChange={(e) => onChange({ ...entry, date: e.target.value })} aria-label="Date" />
        <input
          className="editor-title"
          value={entry.title}
          onChange={(e) => onChange({ ...entry, title: e.target.value })}
          placeholder="Title (optional)"
          aria-label="Title"
        />
      </div>
      <div className="editor-body">
        <textarea
          ref={body}
          value={entry.body}
          onChange={onBody}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setPicker(null), 150)}
          placeholder={connected ? "What happened today? Type @ to mention someone." : "What happened today?"}
          aria-label="Entry"
        />
        {picker && matches.length ? (
          <ul className="picker" role="listbox" aria-label="People">
            {matches.map((person, i) => (
              <li key={person.id} role="option" aria-selected={i === highlight}>
                <button type="button" onMouseDown={(e) => (e.preventDefault(), pick(person))}>
                  <strong>{person.displayName}</strong>
                  {person.relationshipLabel ? <span>{person.relationshipLabel}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {entry.photos.length ? (
        <ul className="photos">
          {entry.photos.map((photo) => (
            <li key={photo.id}>
              <Thumb blob={photo.blob} name={photo.name} />
              <button type="button" aria-label={`Remove ${photo.name}`} onClick={() => onChange({ ...entry, photos: entry.photos.filter((p) => p.id !== photo.id) })}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {present.length ? (
        <div className="mentioned">
          <span>In this entry</span>
          {present.map((mention) => (
            <span
              key={mention.personId}
              className="chip"
              tabIndex={0}
              onMouseEnter={() => setHovered(mention.personId)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(mention.personId)}
              onBlur={() => setHovered(null)}
            >
              {mention.name}
              {mention.memoryId ? <em> · in People</em> : null}
              {hovered === mention.personId && connected ? <PersonCard personId={mention.personId} cache={cache} /> : null}
            </span>
          ))}
        </div>
      ) : null}

      <footer className="editor-actions">
        <label className="button button-quiet">
          Add photos
          <input type="file" accept="image/*" multiple hidden onChange={addPhotos} />
        </label>
        <span className="status" role="status">
          {status}
        </span>
        <button type="button" className="button button-quiet" onClick={onDelete}>
          Delete
        </button>
        <button type="button" className="button button-primary" onClick={onSave}>
          Save
        </button>
      </footer>
    </article>
  );
}

export function App() {
  const [connected, setConnected] = useState(isConnected());
  const [signer, setSigner] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(isCallback());
  const [banner, setBanner] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await listEntries();
    setEntries(list);
    setSelected((current) => current ?? list[0]?.id ?? null);
  }, []);

  // Coming back from People (step 3 of the guide).
  useEffect(() => {
    if (!isCallback()) return;
    finishing ??= finishConnect();
    finishing
      .then(() => setConnected(true), (err) => setBanner(errorText(err)))
      .finally(() => {
        window.history.replaceState(null, "", "/");
        setConnecting(false);
      });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!connected) return setSigner(null);
    people.whoami().then(
      (who) => setSigner(who.token?.name ?? null),
      (err) => {
        if (err instanceof NotConnected) setConnected(false);
      },
    );
  }, [connected]);

  const entry = entries.find((e) => e.id === selected) ?? null;

  const update = (next: Entry) => {
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    setEntries((list) => list.map((e) => (e.id === stamped.id ? stamped : e)));
    setStatus("Not saved yet");
    void saveEntry(stamped);
  };

  const save = async () => {
    if (!entry) return;
    await saveEntry(entry);
    if (!connected || !entry.mentions.length) {
      setStatus("Saved on this computer");
      return;
    }
    setStatus("Saving to People…");
    try {
      const synced = await syncEntry(entry);
      await saveEntry(synced);
      setEntries((list) => list.map((e) => (e.id === synced.id ? synced : e)));
      const names = synced.mentions.map((m) => m.name);
      setStatus(names.length ? `Saved. People remembers it for ${names.join(", ")}.` : "Saved");
    } catch (err) {
      if (err instanceof NotConnected) setConnected(false);
      setStatus(`Saved here, but not in People: ${errorText(err)}`);
    }
  };

  const remove = async () => {
    if (!entry) return;
    try {
      if (connected) await forgetEntry(entry);
    } catch (err) {
      setStatus(`Couldn't remove its memories from People: ${errorText(err)}`);
      return;
    }
    await deleteEntry(entry.id);
    setSelected(null);
    await reload();
  };

  const create = async () => {
    const fresh = newEntry();
    await saveEntry(fresh);
    setSelected(fresh.id);
    setStatus(null);
    await reload();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Diary
        </div>
        {connected ? (
          <div className="connection">
            Connected to People{signer ? <> as <strong>{signer}</strong></> : null}
            <button
              type="button"
              className="button button-quiet"
              onClick={async () => {
                await disconnect();
                setConnected(false);
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <ConnectButton
            busy={connecting}
            onClick={() => {
              setConnecting(true);
              connect().catch((err) => {
                setConnecting(false);
                setBanner(errorText(err));
              });
            }}
          />
        )}
      </header>

      {banner ? (
        <p className="banner" role="alert">
          {banner} <button type="button" onClick={() => setBanner(null)}>Dismiss</button>
        </p>
      ) : null}
      {!connected && !connecting ? (
        <p className="hint">
          Diary works on its own. Connect it to <a href="https://people.buchweitz.life">People</a> and mentioning someone saves a memory of
          them there, for you and your other apps.
        </p>
      ) : null}

      <div className="layout">
        <nav className="sidebar" aria-label="Entries">
          <button type="button" className="button button-primary new-entry" onClick={create}>
            New entry
          </button>
          <ul>
            {entries.map((e) => (
              <li key={e.id}>
                <button type="button" className={e.id === selected ? "is-selected" : undefined} onClick={() => (setSelected(e.id), setStatus(null))}>
                  <span className="entry-date">{prettyDate(e.date)}</span>
                  <strong>{e.title.trim() || (e.body.trim() ? e.body.trim().slice(0, 40) : entryTitle(e))}</strong>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main>
          {entry ? (
            <Editor key={entry.id} entry={entry} connected={connected} onChange={update} onSave={save} onDelete={remove} status={status} />
          ) : (
            <div className="empty">
              <h1>Your diary</h1>
              <p>Write down what happened. Mention the people who were there.</p>
              <button type="button" className="button button-primary" onClick={create}>
                Write the first entry
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
