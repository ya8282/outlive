# outlive

Run a long command detached from the calling process tree, on macOS and Linux,
without handing it to `launchd` and without losing its file access.

```
node outlive.mjs pnpm test:e2e
```

```
Detached (pid 41883, own session, reparents to PID 1).
  command:  pnpm test:e2e
  stdout:   /path/to/repo/.outlive/run.log
  stderr:   /path/to/repo/.outlive/run.err

Block on the result:
  until [ -f /path/to/repo/.outlive/exit ]; do sleep 20; done; echo "exit=$(cat /path/to/repo/.outlive/exit)"

Stop it early:  kill 41883
```

It returns immediately. Nothing long-lived stays in your process tree.

## The problem

A coding agent that runs a long command as a descendant of itself can lose that
command to any kill aimed at its own process tree. Here, a ~14 minute Playwright
suite died at roughly the 10 minute mark, every time, in the foreground, in the
background, and under `nohup` + `disown` alike. The identical command run by
hand in a terminal completed. The variable was the process tree.

`nohup` and `disown` do not help. They change signal disposition and job
control, not membership: a process stays in the tree it was born in.

## Why not `launchctl submit`

It does move the job out of the tree. On macOS it also moves it into
**launchd's privacy context**, which:

- has no access to `~/Documents`, `~/Desktop` or `~/Downloads`,
- cannot be widened from inside the job, and
- has no UI session, so the denial is silent rather than a prompt.

A repo under `~/Documents` therefore fails invisibly: exit 126, a 0-byte log,
and a wait loop blocking on an exit file that is never written. Measured with
launchd probes: the job could `stat` a file in the repo but not read it, and
could exec a script from `~` but not the identical script from `~/Documents`.

Staging the wrapper elsewhere does not help either, because the command still
has to read the files it was pointed at.

## Why `setsid` does work

`spawn(..., { detached: true })` reaches libuv, which asks `posix_spawn` for a
new session on macOS and otherwise forks and calls `setsid` directly:

```c
/* node/deps/uv/src/unix/process.c */
if (options->flags & UV_PROCESS_DETACHED)
  setsid();
```

The child gets its own session and process group, so nothing aimed at the
launcher's group reaches it, and it reparents to PID 1 once the launcher exits.
Same escape from the tree as launchd, except the child is still the launcher's
own fork, so the process macOS holds responsible for its file access does not
change.

## Four things that will bite you

- **Piped stdio freezes it mid-run.** A pipe nobody reads fills at ~64KB and the
  child blocks there forever, looking exactly like a hang. Write to file
  descriptors instead.
- **`unref()` the child**, or the launcher waits on it and you are back in the
  tree you were leaving.
- **Two concurrent runs interleave** into the same log and sentinel files. The
  guard here is a recorded pid plus a liveness check, so a run that *was* killed
  cannot block the next one forever.
- **Wait on a sentinel, not on log output.** Log output cannot distinguish
  "finished" from "stalled". The exit file, written as the command's last act,
  can.

## Run dir

`./.outlive` by default, or `$OUTLIVE_DIR`. It holds `run.sh`, `run.log`,
`run.err`, `pid`, `started`, `exit`, `finished`, and is recreated per run. Add
it to `.gitignore`.

## Test

```
node test.mjs
```

Checks the two properties this exists for (own session, reparents to PID 1) plus
the in-flight guard. Verified red-then-green by flipping `detached` to `false`.

## Is this the only fix?

Probably not. It is the smallest one found after two wrong turns, on one
machine, with one agent harness. If you have solved this another way, open an
issue.

MIT.
