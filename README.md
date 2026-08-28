# Outlive

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

Background, in the order it matters:

1. Every Unix process belongs to a **process group**, and every group belongs to a **session**. A shell and everything it launched share a process, and a kill can target a whole group at once. 
   That's how a single kill sweeps an agent's entire tree.
1. **`setsid`** is the system call that gives a process a brand-new session and group of its own. Signals aimed at the old group no longer reach it.
1. When a parent process exits, the OS passes its surviving children to **PID 1**, the first process on the system. "Reparents to PID 1" means the child keeps running under a new parent that the system never kills.

Node exposes `setsid` functionality. Specifying the `spawn(..., { detached: true })` option makes the child call `setsid` before your command starts. 
The child runs in its own session, the launcher exits immediately, and the child ends up parented to PID 1. This is the same escape from the tree that `launchctl` provided.

The difference is file access. macOS grants access to `~/Documents`, `~/Desktop` and `~/Downloads` per **responsible process**: roughly, processes that identify which app started them.
When using `launchctl submit`, launchd starts the job, so launchd's permissions apply. However, launchd does not have the same permissions as you running commands in the shell.
A detached spawn is still started by your own process, so the permission your shell  or agent already has to read the repo carries over unchanged.

## Four things that will bite you

If you write your own version:

- **Write output to files, not pipes.** A pipe nobody reads fills up after about 64KB, and the child then blocks on its next print forever. This is indistinguishable from a hung process.
- **Call `unref()` on the child.** Otherwise the launcher stays alive waiting for it, and you are back in the process tree you were trying to leave.
- **Guard against two runs at once**, or they interleave into the same log files. The guard here is a recorded pid plus an "is it still alive" check, so a run that was killed cannot block the next one forever.
- **Give the caller a file to wait on, not a log to watch.** A quiet log could mean finished or stalled. The `exit` file is written as the command's very last step, so its existence means done and its content is the exit code.

## Run directory

The script uses `./.outlive` by default, or `$OUTLIVE_DIR`. 
It holds `run.sh`, `run.log`, `run.err`, `pid`, `started`, `exit`, `finished`, and is recreated per run. Add it to `.gitignore`.

## Test

Run the following command to test the functionality:

```
node test.mjs
```

It checks the two properties this exists for (own session, reparents to PID 1) plus the in-flight guard. Flipping `detached` to `false` in `outlive.mjs` makes it fail, which is how the test itself was verified.

## Is this the only fix?

Probably not. It's the smallest one found after two wrong turns, on one machine, with one agent harness. If you have solved this another way, open an issue and let me know!

MIT.
