export type NativeNoReplaceResult = { ok: true } | { ok: false; code: number; name: string };
export interface NativeNoReplace { publish(candidate: string, destination: string): NativeNoReplaceResult; }

const COLLISIONS = {
  linux: new Set([17]),
  darwin: new Set([17]),
  win32: new Set([80, 183]),
} as const;

export function publishNoReplace(adapter: NativeNoReplace, candidate: string, destination: string): void {
  const result = adapter.publish(candidate, destination);
  if (result.ok) return;
  const platform = process.platform as keyof typeof COLLISIONS;
  if (COLLISIONS[platform]?.has(result.code)) throw new Error("LOCK_EXISTS");
  throw new Error(`SERVICE_IO:NATIVE_NO_REPLACE:${result.name}:${result.code}`);
}
