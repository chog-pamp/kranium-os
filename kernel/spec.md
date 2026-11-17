# KRNI — the KraniumOS nanokernel · ABI spec v0.1

One rule: **processes never touch kernel state.** Every capability is a syscall.

## Process model
- A process is a **generator function** `(self) => generator`. It yields to hand
  control back to the kernel — that yield IS the context switch.
- A process performs syscalls by yielding a request object:
  `{ sys: SYS.WRITE, a: [fd, "text"] }`. The kernel executes it and feeds the
  result back through `gen.next(result)`. Same mechanics as a real
  user→kernel transition: the process cannot reach kernel memory, only the ABI.
- `self.pid`, `self.argv` are stamped on the process context at spawn time.

## Syscall table (v0.1)
| #  | name      | args              | returns            |
|----|-----------|-------------------|--------------------|
| 1  | WRITE     | fd, string        | bytes written      |
| 2  | OPEN      | path, flags       | fd (or throws ENOENT) |
| 3  | READ      | fd                | string (non-destructive on files; pipes consume) |
| 4  | CLOSE     | fd                | true               |
| 5  | SPAWN     | path/name, fn?, argv | pid             |
| 6  | EXIT      | code              | (never returns)    |
| 7  | KILL      | pid               | ok                 |
| 8  | READDIR   | path              | string[]           |
| 9  | GETPID    | —                 | pid                |
| 10 | IPCSEND   | pid, obj          | true               |
| 11 | IPCRECV   | —                 | {from, msg} (blocks) |
| 12 | SLEEP     | ms                | (blocks, then ms elapsed) |
| 13 | STATS     | —                 | kernel stats       |

Blocking (IPCRECV, SLEEP): **the scheduler owns blocking semantics** — yielding a
SLEEP or IPCRECV request blocks the caller; no flag needed. A failed syscall
raises inside the process (the kernel re-enters via `gen.throw`); without a
local try/catch that is a contained crash reported on stderr. The kernel
marks it BLOCKED and stops scheduling it. Wake events (message arrival, timer)
move it back to READY with the pending result queued for the next `next()`.

## Scheduler
Cooperative round-robin, one instruction-batch per READY process per tick.
`kernel.tick()` is the clock — the OS page drives it from rAF. One blocked or
busy-looping process cannot stall the machine; nothing here can wedge the tab.

## VFS
In-memory node tree, OPFS-mountable later (a mount is just a node whose
read/write delegate to a FileSystemFileHandle — the ABI does not change).
`/proc/<pid>/{name,status}` is generated live by the kernel: process state is
the filesystem. fd table is per-process; fds are integers that die with the
process.

## What this is
The boundary is honest: same shape as a real kernel's user/kernel split,
scaled to what a tab can enforce. Tier 2 (wasm processes in Workers) replaces
the generator bodies with wasm modules — the ABI above does not change.
