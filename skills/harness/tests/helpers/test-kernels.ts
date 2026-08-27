// test-kernels.ts — how a harness test opens the Run Kernel, and why the hermetic one is the default.
//
// The kernel opens with `PRAGMA synchronous = FULL`, so every event it journals costs one fsync. A
// test that opens it as a file under a temp directory stops measuring the code it exercises and
// starts measuring the runner's disk. PR #146 measured the size of that: in
// `gauntlet-revision-loop.e2e.test.ts` a case that costs 14 ms on an idle machine timed out at
// 8,415 ms on `smoke (windows-latest)` while the twin leg of its own `test.each` — the identical
// code path — finished in 688 ms. Under 40 concurrent copies, 640 runs on disk produced 100
// timeouts; the same 640 in memory produced 5.
//
// The reason the disk kept winning is that nobody chose it. A new test copies its neighbour, the
// neighbour opened a file, and the fsync arrives without a decision. So the default here is
// `openTestKernel()` and the file is the named exception.
//
// Take `openTestKernelFile(path)` only when the test READS THE DATABASE BACK through a connection
// that is not the one it writes with: a spawned child process, an HTTP server the test drives, or a
// second handle the code under test opens from a path it was given. `:memory:` is private to a
// single connection — every other reader opens an empty database — so those tests would go green on
// nothing at all. That failure is silent, and a green lie costs more than an honest fsync.
//
// Both register the handle with `closeTestKernels()`, which belongs in `afterEach`. A handle left
// open holds the file on Windows and turns the temp-root cleanup into EBUSY, where it hides the
// real failure (see temp-dirs.ts).
import { openKernel, type KernelHandle } from "../../lib/run-kernel/index.ts";

const opened: KernelHandle[] = [];

/** The default: a Run Kernel whose journal never reaches the disk. */
export function openTestKernel(): KernelHandle {
  const handle = openKernel(":memory:");
  opened.push(handle);
  return handle;
}

/** The exception: a Run Kernel on disk, for a test whose database another connection reads back. */
export function openTestKernelFile(dbPath: string): KernelHandle {
  const handle = openKernel(dbPath);
  opened.push(handle);
  return handle;
}

/** Close every handle these helpers opened. A handle the test already closed absorbs this as a no-op. */
export function closeTestKernels(): void {
  while (opened.length) opened.pop()!.close();
}
