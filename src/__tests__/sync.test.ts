import { afterEach, describe, expect, it, vi } from "vitest";
import { challengeFor } from "../people";
import * as peopleModule from "../people";
import type { Entry } from "../store";
import { entryTitle, excerpt, hash, memoryFor, presentMentions, syncEntry } from "../sync";

function entry(body: string, extra: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    date: "2026-08-14",
    title: "",
    body,
    photos: [],
    mentions: [
      { personId: "person_maya", name: "Maya Chen" },
      { personId: "person_dev", name: "Dev" },
    ],
    createdAt: "2026-08-14T20:00:00Z",
    updatedAt: "2026-08-14T20:00:00Z",
    ...extra,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("mentions", () => {
  it("counts a mention only while its @name is in the text", () => {
    const e = entry("Camping with @Maya Chen. @Devon came too.");
    expect(presentMentions(e).map((m) => m.personId)).toEqual(["person_maya"]);
  });

  it("summarizes the paragraphs that mention someone, without the @", () => {
    const body = "Drove up early.\n\nSet up camp with @Maya Chen and @Dev by the falls.\n\nRain at night.";
    expect(excerpt(body, "Maya Chen", ["Maya Chen", "Dev"])).toBe("Set up camp with Maya Chen and Dev by the falls.");
  });

  it("cuts long summaries at a word", () => {
    const body = `@Maya Chen ${"marshmallows ".repeat(40)}`;
    const text = excerpt(body, "Maya Chen", ["Maya Chen"], 80);
    expect(text.length).toBeLessThanOrEqual(81);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith("Maya Chen marshmallows")).toBe(true);
  });

  it("titles untitled entries by their date", () => {
    expect(entryTitle(entry(""))).toMatch(/^Diary, /);
    expect(entryTitle(entry("", { title: "  Silver Falls " }))).toBe("Silver Falls");
  });

  it("makes a diary-entry memory dated the day it's about", () => {
    const memory = memoryFor(entry("With @Maya Chen."), { personId: "person_maya", name: "Maya Chen" });
    expect(memory).toMatchObject({ kind: "diary-entry", happenedAt: "2026-08-14", tags: ["diary"], metadata: { app: "diary", entryId: "e1" } });
  });
});

describe("PKCE", () => {
  it("hashes the verifier as RFC 7636 says", async () => {
    // The example from RFC 7636, appendix B.
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("syncing", () => {
  it("creates, then updates, then deletes as the entry changes", async () => {
    const add = vi.spyOn(peopleModule.people, "addMemory").mockResolvedValue({ id: "mem_1" } as never);
    const update = vi.spyOn(peopleModule.people, "updateMemory").mockResolvedValue({} as never);
    const remove = vi.spyOn(peopleModule.people, "deleteMemory").mockResolvedValue({} as never);

    const first = await syncEntry(entry("Camping with @Maya Chen."));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![3]).toMatch(/^diary-e1-person_maya-[0-9a-f]{8}$/);
    expect(first.mentions).toHaveLength(1);
    expect(first.mentions[0]!.memoryId).toBe("mem_1");

    // Saving again sends nothing.
    await syncEntry(first);
    expect(add).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();

    // An edit updates the memory in place.
    const edited = await syncEntry({ ...first, body: "Camping with @Maya Chen at Silver Falls." });
    expect(update).toHaveBeenCalledWith("mem_1", expect.objectContaining({ summary: "Camping with Maya Chen at Silver Falls." }));

    // Removing the mention deletes it.
    const removed = await syncEntry({ ...edited, body: "Camping alone." });
    expect(remove).toHaveBeenCalledWith("mem_1");
    expect(removed.mentions).toEqual([]);
  });

  it("replaces the memory when the photos change, since files can't be edited", async () => {
    const add = vi.spyOn(peopleModule.people, "addMemory").mockResolvedValueOnce({ id: "mem_1" } as never).mockResolvedValueOnce({ id: "mem_2" } as never);
    const remove = vi.spyOn(peopleModule.people, "deleteMemory").mockResolvedValue({} as never);
    const first = await syncEntry(entry("With @Maya Chen."));
    const photo = { id: "p1", name: "falls.jpg", type: "image/jpeg", blob: new Blob(["x"]) };
    const second = await syncEntry({ ...first, photos: [photo] });
    expect(remove).toHaveBeenCalledWith("mem_1");
    expect(add).toHaveBeenCalledTimes(2);
    expect((add.mock.calls[1]![2] as File[])[0]!.name).toBe("falls.jpg");
    expect(second.mentions[0]!.memoryId).toBe("mem_2");
  });

  it("hashes stably", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
  });
});
