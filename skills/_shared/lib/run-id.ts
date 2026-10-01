// run-id.ts — how a run's folder under outputs/ is named, in one place.
//
// The date and time come first (local time, as the user's file browser shows
// it), so outputs/ lists runs in the order they happened; what ran comes after.
// An orchestrator that names a run itself (`--project`) follows the same order:
// `<YYYYMMDD>-<subject>-<part>`.

const pad = (n: number) => String(n).padStart(2, "0");

/** `<YYYYMMDD>-<HHMM>-<target>`, e.g. `20261001-1307-copywriting-infoprodutos`. */
export function runFolderId(target: string, now: Date = new Date()): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${day}-${pad(now.getHours())}${pad(now.getMinutes())}-${target}`;
}

/** A project id or an entity slug is a folder NAME, never a path: letters,
 *  digits, '.', '_' and '-', no '..', no separator of either OS, no drive
 *  letter, no trailing dot and no Windows device name. */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_-])?$/.test(id) && !id.includes("..")
    && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(id);
}
