# KraniumOS

A browser desktop that runs on KRNI, a JavaScript nanokernel. Boot it, log in
as guest, and the terminal talks to a real kernel: process table, syscalls,
file descriptors, /proc.

## What's in it

- Generator-based processes. `yield` is the context switch, and the only way
  into the kernel is the 13-syscall ABI.
- Cooperative scheduler, one batch per process per tick. A busy loop in one
  process doesn't starve the others.
- VFS with per-process fds, plus `/proc` as a live filesystem that reaps
  itself when a process dies.
- Error isolation by contract: a failed syscall raises inside the process,
  and an uncaught one becomes a stderr report instead of a dead tab.

## Run it

    python3 -m http.server 8090

Open `index.html`, log in as `guest` / `guest`, then try `ps`, `spawn demo`,
`kill 2` in the terminal.

## Tests

    node kernel/kernel.test.js

19 tests, no dependencies.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).
