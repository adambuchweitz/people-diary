// Connect with People, for an app that runs in the browser on localhost.
//
// This file is the whole integration, following
// https://people.buchweitz.life/developers.md. Copy it if it helps: nothing
// in it is specific to Diary except APP_NAME.
//
// The flow:
//   1. Register once (an app on localhost can't host a metadata document).
//   2. Send the person to People's authorize page, with PKCE.
//   3. They approve; People sends them back to /callback with a code.
//   4. Trade the code for an access token and a refresh token.
//   5. Call the API with the access token, refreshing when it expires.
//   6. Sign out by revoking the refresh token.

export const API = (import.meta.env.VITE_PEOPLE_API ?? "https://api.people.buchweitz.life").replace(/\/+$/, "");
const APP_NAME = "Diary";
const SCOPE = "people:write";
/** Where People sends the person back: this app's /callback, on whatever port it runs. */
const redirectUri = () => `${window.location.origin}/callback`;
const ISSUER = `${API}/oauth`;

const CLIENT_KEY = "people.client";
const TOKENS_KEY = "people.tokens";
const PENDING_KEY = "people.pending";
/** People drops a registration that never connects after a day. */
const REGISTRATION_TTL_MS = 20 * 60 * 60 * 1000;

type Registration = { api: string; clientId: string; redirectUri: string; registeredAt: number; connected: boolean };
type Tokens = { access: string; refresh: string; expiresAt: number; scope: string };
type Pending = { state: string; verifier: string };

/** An error from People's API, in its `{ ok: false, error: { code, message } }` envelope. */
export class PeopleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thrown when there's no connection, or it ended: connect again. */
export class NotConnected extends Error {
  constructor(message = "Diary isn't connected to People.") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Storage. The refresh token sits in localStorage, readable by any script on
// this origin, so this app loads no scripts it doesn't control.

function read<T>(key: string, store: Storage = localStorage): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, store: Storage = localStorage) {
  if (value === null) store.removeItem(key);
  else store.setItem(key, JSON.stringify(value));
}

export function isConnected(): boolean {
  return read<Tokens>(TOKENS_KEY) !== null;
}

// ---------------------------------------------------------------------------
// PKCE (step 2): a random verifier, and its SHA-256 as the challenge.

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Step 1: register, once per People and redirect URI.

async function registration(): Promise<Registration> {
  const saved = read<Registration>(CLIENT_KEY);
  const fresh = saved?.connected || (saved && Date.now() - saved.registeredAt < REGISTRATION_TTL_MS);
  if (saved && saved.api === API && saved.redirectUri === redirectUri() && fresh) return saved;

  const response = await fetch(`${API}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: APP_NAME, redirect_uris: [redirectUri()] }),
  });
  const body = await response.json();
  if (!response.ok) throw new PeopleError(body.error, body.error_description ?? "People refused the registration.", response.status);
  const registered: Registration = {
    api: API,
    clientId: body.client_id,
    redirectUri: redirectUri(),
    registeredAt: Date.now(),
    connected: false,
  };
  write(CLIENT_KEY, registered);
  return registered;
}

// ---------------------------------------------------------------------------
// Step 2: send the person to People.

export async function connect(): Promise<void> {
  const { clientId } = await registration();
  const pending: Pending = { state: randomString(16), verifier: randomString(32) };
  write(PENDING_KEY, pending, sessionStorage);
  const url = new URL(`${API}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state: pending.state,
    code_challenge: await challengeFor(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(url.toString());
}

// ---------------------------------------------------------------------------
// Steps 3 and 4: People sent the person back. Check it's our request, then
// trade the code for tokens.

export function isCallback(url: URL = new URL(window.location.href)): boolean {
  return url.pathname === "/callback";
}

export async function finishConnect(url = new URL(window.location.href)): Promise<void> {
  const params = url.searchParams;
  const pending = read<Pending>(PENDING_KEY, sessionStorage);
  write(PENDING_KEY, null, sessionStorage);
  if (!pending || params.get("state") !== pending.state) {
    throw new Error("That sign-in didn't start here. Try connecting again.");
  }
  if (params.get("error")) {
    throw new Error(
      params.get("error") === "access_denied"
        ? "You didn't connect Diary. Nothing was shared."
        : params.get("error_description") ?? "People couldn't connect Diary.",
    );
  }
  if (params.get("iss") !== ISSUER) throw new Error("That answer didn't come from People.");

  const client = await registration();
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: params.get("code") ?? "",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_verifier: pending.verifier,
  });
  write(TOKENS_KEY, tokens);
  write(CLIENT_KEY, { ...client, connected: true });
}

async function tokenRequest(fields: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const body = await response.json();
  if (!response.ok) {
    if (body.error === "invalid_grant") throw new NotConnected("The connection to People ended. Connect again.");
    throw new PeopleError(body.error, body.error_description ?? "People couldn't sign Diary in.", response.status);
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  };
}

// ---------------------------------------------------------------------------
// Step 5: the API. An access token lasts an hour; on a 401, refresh and try
// once more.

/**
 * A new access token. Refresh tokens rotate and work once, so only one
 * refresh may run at a time, across every tab: a Web Lock keeps them in
 * line, and a tab that waited finds the new tokens already there.
 */
async function refresh(stale: string): Promise<Tokens> {
  return navigator.locks.request("people-refresh", async () => {
    const current = read<Tokens>(TOKENS_KEY);
    if (!current) throw new NotConnected();
    if (current.access !== stale) return current;
    const { clientId } = await registration();
    try {
      const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: clientId });
      write(TOKENS_KEY, tokens);
      return tokens;
    } catch (err) {
      if (err instanceof NotConnected) write(TOKENS_KEY, null);
      throw err;
    }
  });
}

async function accessToken(): Promise<string> {
  const tokens = read<Tokens>(TOKENS_KEY);
  if (!tokens) throw new NotConnected();
  if (Date.now() < tokens.expiresAt - 30_000) return tokens.access;
  return (await refresh(tokens.access)).access;
}

/** Calls People's API: JSON in and out, or a FormData body for uploads. */
export async function api<T>(
  method: string,
  path: string,
  options: { json?: unknown; form?: FormData; idempotencyKey?: string } = {},
): Promise<T> {
  const send = async (token: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (options.form) body = options.form;
    else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    return fetch(`${API}${path}`, { method, headers, body });
  };
  let token = await accessToken();
  let response = await send(token);
  if (response.status === 401) {
    token = (await refresh(token)).access;
    response = await send(token);
  }
  if (response.status === 401) {
    write(TOKENS_KEY, null);
    throw new NotConnected("The connection to People ended. Connect again.");
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new PeopleError(body?.error?.code ?? `http_${response.status}`, body?.error?.message ?? "People said no.", response.status);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Step 6: sign out. The connection stays on the person's Connect page.

export async function disconnect(): Promise<void> {
  const tokens = read<Tokens>(TOKENS_KEY);
  const client = read<Registration>(CLIENT_KEY);
  write(TOKENS_KEY, null);
  if (tokens && client) {
    await fetch(`${API}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh, client_id: client.clientId }),
    }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The parts of People Diary uses. See the guide's Reference for the rest.

export type Person = {
  id: string;
  displayName: string;
  relationshipLabel: string | null;
  birthday: string | null;
  preferences: string[];
};

export type Memory = {
  id: string;
  personId: string;
  kind: string;
  title: string;
  summary: string | null;
  happenedAt: string | null;
  contributorSignature: string | null;
  createdAt: string;
};

export type PersonExport = { person: Person; memories: Memory[] };

export type Whoami = { kind: string; token?: { name: string; access: string } };

export const people = {
  whoami: () => api<Whoami>("GET", "/whoami"),
  search: (query: string) =>
    api<{ people: Person[] }>("GET", `/people?${new URLSearchParams({ query, limit: "8" })}`).then((r) => r.people),
  export: (personId: string) => api<PersonExport>("GET", `/people/${encodeURIComponent(personId)}/export`),
  addMemory: (personId: string, memory: object, files: File[], idempotencyKey: string) => {
    const path = `/people/${encodeURIComponent(personId)}/memories`;
    if (!files.length) return api<Memory>("POST", path, { json: memory, idempotencyKey });
    const form = new FormData();
    form.append("memory", JSON.stringify(memory));
    for (const file of files) form.append("file", file, file.name);
    return api<Memory>("POST", path, { form, idempotencyKey });
  },
  updateMemory: (memoryId: string, patch: object) =>
    api<Memory>("PATCH", `/memories/${encodeURIComponent(memoryId)}`, { json: patch }),
  deleteMemory: (memoryId: string) => api<unknown>("DELETE", `/memories/${encodeURIComponent(memoryId)}`),
};
