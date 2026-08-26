// fake-home.ts — the environment for a test that runs a real installer in a
// temporary HOME.
//
// A fake HOME/USERPROFILE redirects every file an installer writes, but not the
// Windows registry: wireLocalBinOnPath() persists %USERPROFILE%\.local\bin to
// HKCU\Environment\Path, and the 'User' target is the account running the test,
// whatever USERPROFILE says. Issue #87: 22 %TEMP%\nrv-*\home\.local\bin entries
// on one machine, most pointing at directories long deleted. Every test that
// spawns install.ts / setup.ts (or anything that may reach them) with a fake
// HOME builds its env here, so NIRVANA_SKIP_PATH_PERSIST=1 can never be
// forgotten. `extra` wins over the defaults, PATH overrides included.
export function fakeHomeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SKIP_PATH_PERSIST: "1", ...extra };
}
