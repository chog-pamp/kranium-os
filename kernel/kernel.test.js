// KRNI kernel test suite — pure node, no DOM.
import { Kernel, SYS } from "./kernel.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.error("  ✗", name); } };

/* 1. basic spawn + WRITE to stdout */
{
  const k = new Kernel();
  let out = "";
  k.on("stdout", (_t, p) => { out += p.text; });
  k.spawn("hello", function* () { yield { sys: SYS.WRITE, a: [1, "hi kernel\n"] }; yield { sys: SYS.WRITE, a: [1, "line2"] }; });
  k.tickUntilIdle();
  ok(out === "hi kernel\nline2", "spawn + WRITE to stdout: " + JSON.stringify(out));
}

/* 2. OPEN/READ/WRITE on a real file via fd */
{
  const k = new Kernel();
  k.writeFileSync("/tmp/note.txt", "hello from vfs");
  let got = "";
  k.spawn("reader", function* (p) {
    const fd = yield { sys: SYS.OPEN, a: ["/tmp/note.txt"] };
    if (fd.err) throw new Error(fd.err);
    got = yield { sys: SYS.READ, a: [fd] };
    yield { sys: SYS.CLOSE, a: [fd] };
    yield { sys: SYS.EXIT, a: [0] };
  });
  k.tickUntilIdle();
  ok(got === "hello from vfs", "OPEN/READ/CLOSE via fd: " + JSON.stringify(got));
  const dead = [...k.procs.values()].every((p) => p.state === "DEAD");
  ok(dead, "EXIT terminates the process");
}

/* 3. SPAWN from within a process + GETPID */
{
  const k = new Kernel();
  let childPid = null, pids = new Set();
  k.spawn("parent", function* (p) {
    pids.add(yield { sys: SYS.GETPID });
    childPid = yield { sys: SYS.SPAWN, a: ["child"] };
    pids.add(childPid);
  });
  k.bin.set("child", function* () { pids.add(yield { sys: SYS.GETPID }); });   // registered, spawned BY the parent
  k.tickUntilIdle();
  ok(childPid !== null && pids.size === 2, "SPAWN from process + distinct pids");
}

/* 4. SLEEP blocks and wakes */
{
  const k = new Kernel();
  let woke = false;
  k.spawn("sleeper", function* () {
    yield { block: true, sys: SYS.SLEEP, a: [60] };
    woke = true;
  });
  k.tick(); k.tick();                       // enters block
  ok(!woke, "sleeping process stays blocked before timer");
  const p = [...k.procs.values()][0];
  ok(p.state === "BLOCKED", "state is BLOCKED");
  k.runFor(120);
  ok(woke, "SLEEP wakes after delay");
}

/* 5. IPC: sender wakes a blocked receiver */
{
  const k = new Kernel();
  const log = [];
  k.spawn("rx", function* () {
    const m = yield { block: true, sys: SYS.IPCRECV };
    log.push("got:" + m.msg + ":from:" + m.from);
  });
  k.spawn("tx", function* (p) {
    yield { sys: SYS.IPCSEND, a: [1, "ping"] };
  });
  k.tickUntilIdle();
  ok(log.length === 1 && log[0].startsWith("got:ping:from:"), "IPC delivers + wakes receiver: " + log[0]);
}

/* 6. KILL + /proc reflects state */
{
  const k = new Kernel();
  k.spawn("victim", function* () { yield { block: true, sys: SYS.SLEEP, a: [9999] }; });
  k.spawn("killer", function* () { yield { sys: SYS.KILL, a: [1] }; });
  k.tickUntilIdle();
  const v = k.procs.get(1);
  ok(v.state === "DEAD", "KILL terminates target");
  const names = k._resolve("/proc").children.keys();
  ok(![...names].includes("1"), "/proc entry reaped after kill");
}

/* 7. READDIR + /proc is live filesystem */
{
  const k = new Kernel();
  let listing = null, procPid = null;
  k.spawn("lister", function* (p) {
    procPid = yield { sys: SYS.GETPID };
    listing = yield { sys: SYS.READDIR, a: ["/proc"] };
  });
  k.tickUntilIdle();
  ok(Array.isArray(listing) && listing.map(Number).includes(procPid), "READDIR /proc lists live pids incl. self");
}

/* 8. runaway process cannot wedge the scheduler (one batch per tick) */
{
  const k = new Kernel();
  k.spawn("spinner", function* () { for (;;) yield { sys: SYS.GETPID }; });   // infinite loop, yields forever
  k.spawn("polite", function* () { yield { sys: SYS.WRITE, a: [1, "still-alive"] }; });
  let out = "";
  k.on("stdout", (_t, p) => { out += p.text; });
  for (let i = 0; i < 5; i++) k.tick();
  ok(out.includes("still-alive"), "cooperative isolation: spinner cannot starve others");
}

/* 9. kernel-level error containment */
{
  const k = new Kernel();
  let err = "";
  k.on("stderr", (_t, p) => { err += p.text; });
  k.spawn("crasher", function* () { throw new Error("segfault-ish"); });
  k.spawn("survivor", function* () { yield { sys: SYS.WRITE, a: [1, "ok"] }; });
  k.tickUntilIdle();
  ok(err.includes("segfault-ish"), "crashing process is contained + reported");
  ok([...k.procs.values()].find((p) => p.name === "survivor").state === "DEAD", "survivor still ran to completion");
}

/* 10. REGISTER-based bin: spawn by name only */
{
  const k = new Kernel();
  k.bin.set("age", function* () { yield { sys: SYS.WRITE, a: [1, "17"] }; });
  let out = "";
  k.on("stdout", (_t, p) => { out += p.text; });
  k.spawn("init", function* () { yield { sys: SYS.SPAWN, a: ["age"] }; });
  k.tickUntilIdle();
  ok(out === "17", "bin registry: SPAWN by name resolves /bin");
}

/* 11. READ is non-destructive on regular files */
{
  const k = new Kernel();
  k.writeFileSync("/etc/motd", "stable data");
  let a = "", b = "";
  k.spawn("twice", function* () {
    const fd = yield { sys: SYS.OPEN, a: ["/etc/motd"] };
    a = yield { sys: SYS.READ, a: [fd] };
    b = yield { sys: SYS.READ, a: [fd] };
    yield { sys: SYS.EXIT, a: [0] };
  });
  k.tickUntilIdle();
  ok(a === b && a === "stable data", "READ does not consume regular files: " + JSON.stringify([a, b]));
}

/* 12. failed syscalls raise INSIDE the process (gen.throw ABI) */
{
  const k = new Kernel();
  let caught = "", survived = false;
  k.spawn("careful", function* () {
    try { yield { sys: SYS.OPEN, a: ["/no/such/path"] }; }
    catch (e) { caught = e.errno || e.message; }
    survived = true;
    yield { sys: SYS.EXIT, a: [0] };
  });
  k.spawn("careless", function* () { yield { sys: SYS.OPEN, a: ["/also/missing"] }; });
  let crashed = "";
  k.on("stderr", (_t, p) => { crashed += p.text; });
  k.tickUntilIdle();
  ok(caught === "ENOENT" && survived, "handled syscall error throws into process: " + caught);
  ok(crashed.includes("careless"), "unhandled syscall error = contained crash report");
}

/* 13. on() unsubscribe stops event delivery */
{
  const k = new Kernel();
  let n = 0;
  const off = k.on("stdout", () => { n++; });
  k.spawn("talker", function* () { yield { sys: SYS.WRITE, a: [1, "x"] }; });
  k.tickUntilIdle();
  off();
  k.spawn("talker2", function* () { yield { sys: SYS.WRITE, a: [1, "y"] }; });
  k.tickUntilIdle();
  ok(n === 1, "unsubscribe works (count=" + n + ")");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
