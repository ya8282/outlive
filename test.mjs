#!/usr/bin/env node
// One runnable check on the properties the whole thing exists for: the child
// gets its own session, it reparents to PID 1 once the launcher exits, and the
// caller can wait on a sentinel. Plus the in-flight guard. Run: node test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { shQuote, isAlive, start } from './outlive.mjs';

const cli = fileURLToPath(new URL('./outlive.mjs', import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'outlive-'));
const waitFor = async (p) => {
	for (let i = 0; i < 100 && !existsSync(p); i++) await sleep(100);
	assert.ok(existsSync(p), `${path.basename(p)} never appeared`);
};

assert.equal(shQuote("it's"), `'it'\\''s'`);
assert.equal(isAlive(process.pid), true);
assert.equal(isAlive(2 ** 22), false); // above pid_max everywhere this runs

// 1. In-process: own session (pgid == pid proves setsid), sentinel, exit code.
const runDir = path.join(work, 'a', '.outlive');
const run = start(['sh', '-c', 'sleep 1; ps -o pgid= -p $PPID > pgid.txt; exit 7'], {
	runDir,
	cwd: path.join(work, 'a')
});
assert.equal(existsSync(run.exitPath), false, 'start() must return before the command finishes');
assert.throws(() => start(['true'], { runDir }), /already in flight/, 'guard must refuse a live run');

await waitFor(run.exitPath);
assert.equal(readFileSync(run.exitPath, 'utf8').trim(), '7', 'exit code not propagated');
const pgid = readFileSync(path.join(work, 'a', 'pgid.txt'), 'utf8').trim();
assert.equal(pgid, String(run.pid), 'child is not a process group leader, so setsid did not run');

start(['true'], { runDir }); // a finished run must not block the next one

// 2. Through the CLI, where the launcher exits: the command reparents to PID 1.
const b = path.join(work, 'b');
mkdirSync(b, { recursive: true });
execFileSync(process.execPath, [cli, 'sh', '-c', 'sleep 1; ps -o ppid= -p $PPID > ppid.txt'], {
	cwd: b,
	env: { ...process.env, OUTLIVE_DIR: path.join(b, '.outlive') },
	stdio: 'ignore'
});
await waitFor(path.join(b, '.outlive', 'exit'));
const ppid = readFileSync(path.join(b, 'ppid.txt'), 'utf8').trim();
assert.equal(ppid, '1', `child should reparent to PID 1 once the launcher exits, got ppid ${ppid}`);

rmSync(work, { recursive: true, force: true });
console.log('ok');
