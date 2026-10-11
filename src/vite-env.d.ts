/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which People to connect to; the real one if unset. */
  readonly VITE_PEOPLE_API?: string;
}
