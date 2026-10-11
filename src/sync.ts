// Keeps People in step with an entry: one memory per person mentioned.
// Saving twice changes nothing, editing updates the memories, and removing a
// mention deletes its memory. Diary only touches memories it made, which is
// all `people:write` lets it change anyway.

import { people, PeopleError } from "./people";
import type { Entry, Mention } from "./store";

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPattern(name: string, flags = "u"): RegExp {
  // `@Maya Chen`, not followed by more of a name (`@Maya Chenoweth`).
  return new RegExp(`@${escape(name)}(?![\\p{L}\\p{N}])`, flags);
}

/** The mentions still in the entry's text. */
export function presentMentions(entry: Entry): Mention[] {
  return entry.mentions.filter((mention) => mentionPattern(mention.name).test(entry.body));
}

/** Text for People to show: mentions without their `@`. */
function plain(text: string, names: string[]): string {
  return names.reduce((out, name) => out.replace(mentionPattern(name, "gu"), name), text);
}

/** The paragraphs that mention someone, as a summary, cut at a word. */
export function excerpt(body: string, name: string, allNames: string[], max = 280): string {
  const paragraphs = body.split(/\n\s*\n/).filter((paragraph) => mentionPattern(name).test(paragraph));
  const text = plain(paragraphs.join(" ").replace(/\s+/g, " ").trim(), allNames);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trimEnd()}…`;
}

export function entryTitle(entry: Entry): string {
  if (entry.title.trim()) return entry.title.trim();
  const date = new Date(`${entry.date}T12:00:00`);
  return `Diary, ${date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}

/** The memory People keeps of one mention. */
export function memoryFor(entry: Entry, mention: Mention) {
  const names = entry.mentions.map((m) => m.name);
  return {
    kind: "diary-entry",
    title: entryTitle(entry),
    summary: excerpt(entry.body, mention.name, names),
    happenedAt: entry.date,
    tags: ["diary"],
    metadata: { app: "diary", entryId: entry.id },
  };
}

/** A short, stable hash, for idempotency keys. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function deleteQuietly(memoryId: string) {
  try {
    await people.deleteMemory(memoryId);
  } catch (err) {
    // Already gone (the person deleted it in People): fine.
    if (!(err instanceof PeopleError && err.code === "not_found")) throw err;
  }
}

/**
 * Brings People up to date with the entry, and returns the entry with its
 * mentions' memory ids. Creates carry an idempotency key made from what's
 * sent, so a retry after a lost response replays instead of duplicating.
 */
export async function syncEntry(entry: Entry): Promise<Entry> {
  const present = presentMentions(entry);
  for (const gone of entry.mentions.filter((mention) => !present.includes(mention))) {
    if (gone.memoryId) await deleteQuietly(gone.memoryId);
  }
  const photos = entry.photos.map((photo) => photo.id).join(",");
  const files = entry.photos.map((photo) => new File([photo.blob], photo.name, { type: photo.type }));
  const synced: Mention[] = [];
  for (const mention of present) {
    const memory = memoryFor(entry, mention);
    const sent = JSON.stringify(memory);
    let memoryId = mention.memoryId;
    if (memoryId && mention.sentPhotos !== photos) {
      // Files can't be changed on a memory, so new photos mean a new one.
      await deleteQuietly(memoryId);
      memoryId = undefined;
    }
    if (!memoryId) {
      const key = `diary-${entry.id}-${mention.personId}-${hash(sent + photos)}`;
      memoryId = (await people.addMemory(mention.personId, memory, files, key)).id;
    } else if (mention.sent !== sent) {
      const { title, summary, happenedAt } = memory;
      await people.updateMemory(memoryId, { title, summary, happenedAt });
    }
    synced.push({ ...mention, memoryId, sent, sentPhotos: photos });
  }
  return { ...entry, mentions: synced };
}

/** Deleting an entry deletes the memories it made. */
export async function forgetEntry(entry: Entry): Promise<void> {
  for (const mention of entry.mentions) {
    if (mention.memoryId) await deleteQuietly(mention.memoryId);
  }
}
