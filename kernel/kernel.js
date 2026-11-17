/*  KRNI — the KraniumOS nanokernel (Tier 1: cooperative, generator processes)
 *  ------------------------------------------------------------------
 *  Processes never touch kernel state. Every capability is a syscall
 *  performed by yielding a request object; the kernel executes it and
 *  feeds the result back through gen.next(). See spec.md for the ABI.
 */

export const SYS = {
  WRITE: 1, OPEN: 2, READ: 3, CLOSE: 4, SPAWN: 5, EXIT: 6, KILL: 7,
  READDIR: 8, GETPID: 9, IPCSEND: 10, IPCRECV: 11, SLEEP: 12, STATS: 13,
};
export const SYSNAME = Object.fromEntries(Object.entries(SYS).map(([k, v]) => [v, k]));

const ENOENT = (p) => { const e = new Error("ENOENT: " + p); e.errno = "ENOENT"; return e; };

export class Kernel {
  constructor({ name = "KRNI", version = "0.1" } = {}) {
    this.name = name; this.version = version;
    this.nextPid = 1;
    this.procs = new Map();          // pid -> proc
    this.ready = [];                 // scheduling queue (pids)
    this.timers = [];                // {pid, wakeAt, result}
    this.vfs = this._newDir();
    this.bin = new Map();            // name -> spawnable (fn or generator fn)
    this.onBootListeners = [];
    this.ticks = 0;
  }

  /* ---------------- VFS ---------------- */
  _newDir() { return { type: "dir", children: new Map() }; }
  _newFile(data = "") { return { type: "file", data: String(data) }; }
  _resolve(path) {
    const parts = String(path).split("/").filter(Boolean);
    let node = this.vfs;
    for (const part of parts) {
      if (node.type !== "dir" || !node.children.has(part)) return null;
      node = node.children.get(part);
    }
    return node;
  }
  _mkdirp(path) {
    const parts = String(path).split("/").filter(Boolean);
    let node = this.vfs;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, this._newDir());
      node = node.children.get(part);
      if (node.type !== "dir") throw new Error("ENOTDIR: " + path);
    }
    return node;
  }
  writeFileSync(path, data) { this._mkdirp(path.split("/").slice(0, -1).join("/")); const n = this._resolve(path); if (n && n.type === "file") { n.data = String(data); return; } const dir = this._mkdirp(path.split("/").slice(0, -1).join("/")); dir.children.set(path.split("/").filter(Boolean).pop(), this._newFile(data)); }
  readFileSync(path) { const n = this._resolve(path); if (!n || n.type !== "file") throw ENOENT(path); return n.data; }

  /* ---------------- process table ---------------- */
  spawn(name, body, argv = []) {
    if (!body && this.bin.has(name)) body = this.bin.get(name);
    if (typeof body !== "function") throw ENOENT("/bin/" + name);
    const pid = this.nextPid++;
    const proc = {
      pid, name, argv, state: "READY", exitCode: null,
      mailbox: [], fds: new Map(), nextFd: 3, // 0,1,2 reserved
      wakeResult: undefined,
    };
    proc.gen = body({ pid, name, argv, sys: (sys, a) => ({ sys, a }) });
    this.procs.set(pid, proc);
    this.ready.push(pid);
    this._refreshProcFS();
    return pid;
  }
  kill(pid, code = 1) {
    const p = this.procs.get(pid);
    if (!p) return false;
    try { p.gen.return(code); } catch (_) { /* already dead */ }
    p.state = "DEAD"; p.exitCode = code;
    this.ready = this.ready.filter((x) => x !== pid);
    this._reap(pid);
    return true;
  }
  _reap(pid) {
    const p = this.procs.get(pid);
    if (!p) return;
    this.timers = this.timers.filter((t) => t.pid !== pid);
    for (const fd of p.fds.keys()) p.fds.delete(fd);
    // anyone blocked receiving from a dead process stays blocked (kernel logs it)
    this._refreshProcFS();
  }
  isAlive(pid) { const p = this.procs.get(pid); return !!p && p.state !== "DEAD"; }

  /* ---------------- /proc ---------------- */
  _refreshProcFS() {
    const procDir = this._mkdirp("/proc");
    for (const [pid, p] of this.procs) {
      if (p.state === "DEAD") { procDir.children.delete(String(pid)); continue; }   // reaped: not on the filesystem
      let d = procDir.children.get(String(pid));
      if (!d || d.type !== "dir" || !d.live) {
        d = this._newDir(); d.live = true;
        procDir.children.set(String(pid), d);
      }
      d.children.set("name", this._newFile(p.name));
      d.children.set("status", this._newFile(
        `pid=${pid} state=${p.state} name=${p.name} exit=${p.exitCode ?? "-"}`
      ));
    }
    for (const [k, d] of procDir.children) {
      if (d.type === "dir" && d.live && !this.procs.has(Number(k))) procDir.children.delete(k);
    }
  }

  /* ---------------- syscalls ---------------- */
  _perform(proc, req) {
    const S = SYS;
    switch (req.sys) {
      case S.WRITE: {
        const [fd, text] = req.a;
        if (fd === 1 || fd === 2) { this._emit("stdout", { pid: proc.pid, text: String(text) }); return String(text).length; }
        const node = proc.fds.get(fd);
        if (!node || node.type !== "file") throw new Error("EBADF: fd " + fd);
        node.data += String(text); return String(text).length;
      }
      case S.OPEN: {
        const [path] = req.a;
        const node = this._resolve(path);
        if (!node) throw ENOENT(path);
        const fd = proc.nextFd++;
        proc.fds.set(fd, node);
        return fd;
      }
      case S.READ: {
        const [fd] = req.a;
        const node = proc.fds.get(fd);
        if (!node) throw new Error("EBADF: fd " + fd);
        if (node.type === "procfile") return node.read();
        if (node.consume) { const d = node.data; node.data = ""; return d; }   // pipes consume
        return node.data;                                      // regular files: non-destructive
      }
      case S.CLOSE: { proc.fds.delete(req.a[0]); return true; }
      case S.SPAWN: {
        const [name, body, argv] = req.a;
        return this.spawn(name, body, argv ?? []);
      }
      case S.EXIT: { this.kill(proc.pid, req.a[0] ?? 0); return { exited: true }; }
      case S.KILL: return this.kill(req.a[0]);
      case S.READDIR: {
        const node = this._resolve(req.a[0]);
        if (!node || node.type !== "dir") throw ENOENT(req.a[0]);
        return [...node.children.keys()];
      }
      case S.GETPID: return proc.pid;
      case S.IPCSEND: {
        const [to, msg] = req.a;
        const target = this.procs.get(to);
        if (!target || target.state === "DEAD") throw new Error("ESRCH: pid " + to);
        target.mailbox.push({ from: proc.pid, msg });
        if (target.state === "BLOCKED") {           // wake the receiver
          target.state = "READY";
          target.wakeResult = target.mailbox.shift();
          this.ready.push(to);
        }
        return true;
      }
      case S.STATS: return {
        kernel: this.name + " " + this.version, ticks: this.ticks,
        procs: [...this.procs.values()].map((p) => ({ pid: p.pid, name: p.name, state: p.state })),
      };
      default: throw new Error("ENOSYS: " + req.sys);
    }
  }

  /* ---------------- scheduler ---------------- */
  tick() {
    this.ticks++;
    // wake timers
    const now = Date.now();
    const due = this.timers.filter((t) => t.wakeAt <= now);
    this.timers = this.timers.filter((t) => t.wakeAt > now);
    for (const t of due) {
      const p = this.procs.get(t.pid);
      if (p && p.state === "BLOCKED") { p.state = "READY"; p.wakeResult = t.result; this.ready.push(t.pid); }
    }
    const queue = this.ready; this.ready = [];
    for (const pid of queue) {
      const p = this.procs.get(pid);
      if (!p || p.state === "DEAD") continue;
      let step;
      try { step = p.gen.next(p.wakeResult); p.wakeResult = undefined; }
      catch (err) { p.state = "DEAD"; p.exitCode = 1; this._emit("stderr", { pid, text: p.name + ": " + err.message }); this._reap(pid); continue; }
      if (step.done) { p.state = "DEAD"; p.exitCode = step.value ?? 0; this._reap(pid); continue; }
      const req = step.value;
      // the ABI decides which syscalls block — the caller cannot get this wrong
      const blocking = req && (req.block || req.sys === SYS.SLEEP || req.sys === SYS.IPCRECV);
      if (blocking) {
        if (req.sys === SYS.IPCRECV && p.mailbox.length) {   // message already waiting: deliver now, no block
          p.wakeResult = p.mailbox.shift();
          this.ready.push(pid);
          continue;
        }
        p.state = "BLOCKED";
        if (req.sys === SYS.SLEEP) {
          const d = Array.isArray(req.a) ? (req.a[0] ?? 0) : Number(req.a) || 0;   // tolerate bare-number ABI misuse
          this.timers.push({ pid, wakeAt: now + d });
        }
        continue;
      }
      if (req && req.sys !== undefined) {
        let result, sysErr = null;
        try { result = this._perform(p, req); }
        catch (err) { sysErr = err; }
        if (result && result.exited) continue;      // EXIT killed it
        if (sysErr) {
          // ABI contract: a failed syscall raises inside the process
          try { p.gen.throw(sysErr); p.state = "DEAD"; p.exitCode = 1; this._reap(pid); continue; }
          catch (unhandled) {   // no try/catch in the process: crash report
            p.state = "DEAD"; p.exitCode = 1;
            this._emit("stderr", { pid, text: p.name + ": " + (unhandled && unhandled.message || String(sysErr)) });
            this._reap(pid); continue;
          }
        }
        // give the result back next tick (fair: one syscall per tick per proc)
        p.wakeResult = result;
      }
      this.ready.push(pid);
    }
    this._refreshProcFS();
  }
  tickUntilIdle(maxTicks = 10000) { let n = 0; while (this.ready.length && n++ < maxTicks) this.tick(); return n; }
  runFor(ms) { const end = Date.now() + ms; while (Date.now() < end && (this.ready.length || this.timers.length)) this.tick(); }

  /* ---------------- events / boot ---------------- */
  _emit(type, payload) { for (const fn of this.onBootListeners) fn(type, payload); }
  on(type, fn) { this.onBootListeners.push(fn); return () => { this.onBootListeners = this.onBootListeners.filter((f) => f !== fn); }; }

  boot(initBody) {
    this.writeFileSync("/etc/motd", `Welcome to ${this.name} ${this.version}\n`);
    const pid = this.spawn("init", initBody, []);
    this.initPid = pid;
    return pid;
  }
}
