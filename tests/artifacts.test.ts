import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CancelledError, KeyLock } from "../src/artifacts.ts";

test("a queued caller cancels before the holder releases without breaking FIFO", async () => {
	const lock = new KeyLock();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const holder = lock.run("key", undefined, async () => {
		events.push("holder");
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	const controller = new AbortController();
	let cancelled = false;
	const waiter = lock.run("key", controller.signal, async () => {
		assert.fail("cancelled caller must not execute");
	}).catch(error => {
		assert.ok(error instanceof CancelledError);
		cancelled = true;
	});
	controller.abort();
	try {
		await setImmediate();
		assert.equal(cancelled, true, "cancellation must not wait for the holder");
		const next = lock.run("key", undefined, async () => { events.push("next"); });
		const last = lock.run("key", undefined, async () => { events.push("last"); });
		await setImmediate();
		assert.deepEqual(events, ["holder"], "new callers must not bypass the holder through a cancelled tail");
		release.resolve();
		await Promise.all([holder, waiter, next, last]);
		assert.deepEqual(events, ["holder", "next", "last"]);
		await lock.run("key", undefined, async () => { events.push("reused"); });
		assert.equal(events.at(-1), "reused");
	} finally {
		release.resolve();
		await Promise.all([holder, waiter]);
	}
});

test("cancelling a middle waiter preserves already-queued successors", async () => {
	const lock = new KeyLock();
	const release = Promise.withResolvers<void>();
	const holder = lock.run("key", undefined, () => release.promise);
	const controller = new AbortController();
	let didCancel = false;
	const cancelled = assert.rejects(lock.run("key", controller.signal, async () => {
		assert.fail("cancelled caller must not execute");
	}), CancelledError).then(() => { didCancel = true; });
	let ran = false;
	const successor = lock.run("key", undefined, async () => { ran = true; });
	controller.abort();
	try {
		await setImmediate();
		assert.equal(didCancel, true);
		assert.equal(ran, false);
	} finally {
		release.resolve();
		await Promise.all([holder, successor, cancelled]);
	}
	assert.equal(ran, true);
});

test("pre-aborted calls never execute and failed holders release their key", async () => {
	const lock = new KeyLock();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(lock.run("key", controller.signal, async () => assert.fail("must not run")), CancelledError);
	await assert.rejects(lock.run("key", undefined, async () => { throw new Error("fixture failure"); }), /fixture failure/);
	assert.equal(await lock.run("key", undefined, async () => "available"), "available");
});
