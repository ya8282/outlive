# Outlive

Run a long command so it outlives the agent that started it, on macOS and
Linux. It survives the shell tool's 600-second cap, survives the session going
quiet, keeps its file access, and leaves an exit record on disk either way.

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

Two separate things kill a long command that a coding agent launches. Both were
found the slow way, and the second one is still live.

**One: the foreground timeout is capped.** The agent's shell tool clamps a
foreground command to 600 seconds, silently ignoring a larger requested
timeout. Measured: 800,000 ms requested, killed at exactly 600 s. On an older
build, hitting that cap did something worse than fail. It moved the run to the
background and reported *"It's still executing; I'll report the result when it
finishes."* It was not. It died leaving no output and no record. Current builds
kill the command honestly instead, but the cap itself is unchanged and still
documented at 600,000 ms. A command typed into a plain terminal is
unaffected, since there is no tool in the way.

**Two: an unattended heavy run gets killed anyway.** A full test suite launched
as a background task, in a session that then goes quiet, dies at around 350
seconds with no message, no exit code, and no record that it ever ran. Six
runs, on one build, one day:

| task | session kept taking tool rounds | outcome |
| --- | --- | --- |
| trivial blocker | yes | survived 2,457 s |
| trivial blocker | no | survived 945 s |
| full suite | yes | 17m 00s, exit 0 |
| full suite | **no** | **killed at 345 s** |
| full suite | **no** | **killed at 351 s** |
| full suite | yes | 16m 20s, exit 0 |

Two kills six seconds apart is a boundary, not noise. It needs both conditions:
a heavy run *and* a quiet session. Neither alone does it.

Ruled out by measurement: not workload targeting, because a trivial sampler
running alongside was killed in the same instant; not duration, because a
trivial task survived 945 s unattended; not memory pressure, with no jetsam
entries and memory never below 29% free; not idle sleep, because that sampler's
unbroken timestamps prove the machine was awake.

**The cause is not known.** Attendance correlates across all six runs and that
is still a correlation, so this README describes the signature and stops there.

`nohup` and `disown` do not help with either. They change signal disposition
and job control, not membership: a process stays in the tree it was born in.

## Why not `launchctl submit`

It does move the job out of the tree. On macOS it also moves it into
launchd's privacy context, which:

- has no access to `~/Documents`, `~/Desktop` or `~/Downloads`,
- cannot be widened from inside the job, and
- has no UI session, so the denial is silent rather than a prompt.

A repo under `~/Documents` therefore fails invisibly: exit 126, a 0-byte log,
and a wait loop blocking on an exit file that is never written. Measured with
launchd probes: the job could `stat` a file in the repo but not read it, and
could exec a script from `~` but not the identical script from `~/Documents`.

Staging the wrapper elsewhere does not help either, because the command still
has to read the files it was pointed at.

## Why this works

`spawn(..., { detached: true })` reaches libuv, which asks `posix_spawn` for a
new session on macOS and otherwise forks and calls `setsid` directly:

```c
/* node/deps/uv/src/unix/process.c */
if (options->flags & UV_PROCESS_DETACHED)
  setsid();
```

That gives the launcher three properties:

- **The launcher returns in milliseconds**, so no tool call is ever open long
  enough to reach the 600-second cap. This, rather than the session change, is
  what defeats problem one.
- **The child reparents to PID 1**, outside the session that started it, rather
  than being owned by it.
- **It writes `started`, `exit` and `finished` to disk.** A run that dies
  silently still leaves something a later session can read, which matters
  because both failure modes above erase their own evidence.

It is also still the launcher's own fork, so the process the OS holds
responsible for file access does not change, which is what `launchctl submit`
got wrong.

## If you would rather not use this

`run_in_background` is simpler, and it works **as long as the session keeps
taking tool rounds for the whole run**. Arm a monitor on a short interval and
stay in the loop. Launch it and go quiet and you are in the table above.

## Four things that will bite you

If you write your own version:

- **Write output to files, not pipes.** A pipe nobody reads fills up after about 64KB, and the child then blocks on its next print forever. This is indistinguishable from a hung process.
- **Call `unref()` on the child.** Otherwise the launcher stays alive waiting for it, and you are back in the process tree you were trying to leave.
- **Guard against two runs at once**, or they interleave into the same log files. The guard here is a recorded pid plus an "is it still alive" check, so a run that was killed cannot block the next one forever.
- **Give the caller a file to wait on, not a log to watch.** A quiet log could mean finished or stalled. The `exit` file is written as the command's very last step, so its existence means done and its content is the exit code. Without it, a run killed by either failure mode above looks the same as one still going.

## Run directory

The script uses `./.outlive` by default, or `$OUTLIVE_DIR`. 
It holds `run.sh`, `run.log`, `run.err`, `pid`, `started`, `exit`, `finished`, and is recreated per run. Add it to `.gitignore`.

## Test

```
node test.mjs
```

It checks the two properties this exists for (own session, reparents to PID 1) plus the in-flight guard. Flipping `detached` to `false` in `outlive.mjs` makes it fail, which is how the test itself was verified.

## Is this the only fix?

Probably not. It's the smallest one found after two wrong turns, on one machine, with one agent harness. If you have solved this another way, please open an issue.

MIT.
