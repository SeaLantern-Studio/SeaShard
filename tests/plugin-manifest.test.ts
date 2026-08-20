import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginManifest } from "../packages/plugin-system/src/manifest.ts";
import { validManifest } from "./plugin-test-fixtures.ts";

await test("manifest parser rejects unknown fields and module traversal", () => {
  assert.deepEqual(parsePluginManifest(validManifest, "0.0.0"), validManifest);
  assert.throws(
    () => parsePluginManifest({ ...validManifest, typo: true }, "0.0.0"),
    /manifest\.typo is not supported/,
  );
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validManifest,
          entries: [{ ...validManifest.entries[0], module: "../outside.js" }],
        },
        "0.0.0",
      ),
    /without traversal/,
  );
});
