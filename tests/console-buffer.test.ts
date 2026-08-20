import { BoundedSequenceStore } from "../frontend/server/console/src/client/console-buffer.ts";
import assert from "node:assert/strict";
import test from "node:test";

await test("bounded sequence store merges subscription-first history without growing past its window", () => {
  const store = new BoundedSequenceStore<{ sequence: number; text: string }>(3);

  assert.equal(store.add({ sequence: 5, text: "live" }), true);
  assert.equal(store.add({ sequence: 3, text: "history-3" }), true);
  assert.equal(store.add({ sequence: 4, text: "history-4" }), true);
  assert.deepEqual(
    store.values().map((line) => line.sequence),
    [3, 4, 5],
  );
  assert.equal(store.size, 3);
  assert.equal(store.add({ sequence: 5, text: "duplicate" }), false);

  assert.equal(store.add({ sequence: 6, text: "next" }), true);
  assert.deepEqual(
    store.values().map((line) => line.sequence),
    [4, 5, 6],
  );
  assert.equal(store.add({ sequence: 3, text: "evicted" }), false);
  assert.equal(store.size, 3);

  assert.equal(store.add({ sequence: 100, text: "jump" }), true);
  assert.deepEqual(
    store.values().map((line) => line.sequence),
    [100],
  );
  assert.equal(store.size, 1);

  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.add({ sequence: 1, text: "fresh" }), true);
  assert.deepEqual(store.values(), [{ sequence: 1, text: "fresh" }]);
});
