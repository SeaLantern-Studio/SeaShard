import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInternalPluginManifest,
  parsePluginManifest,
} from "../packages/plugin-system/src/manifest.ts";
import { validManifest, validPluginPackageManifest } from "./plugin-test-fixtures.ts";

await test("third-party manifest parser normalizes entries to global scope", () => {
  assert.deepEqual(parsePluginManifest(validPluginPackageManifest, "0.0.0"), {
    ...validPluginPackageManifest,
    entries: [
      {
        ...validPluginPackageManifest.entries[0],
        activationScopes: ["global"],
        permissions: ["example.echo"],
      },
    ],
  });
});

await test("third-party manifest parser rejects internal scope and permission fields", () => {
  for (const internalField of [
    { activationScopes: ["server"] },
    { permissions: ["example.echo"] },
  ]) {
    assert.throws(
      () =>
        parsePluginManifest(
          {
            ...validPluginPackageManifest,
            entries: [{ ...validPluginPackageManifest.entries[0], ...internalField }],
          },
          "0.0.0",
        ),
      /is not supported/,
    );
  }
});

await test("third-party manifest parser validates method-level uses", () => {
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validPluginPackageManifest,
          entries: [
            {
              ...validPluginPackageManifest.entries[0],
              uses: { "example.echo": [] },
            },
          ],
        },
        "0.0.0",
      ),
    /must contain at least one method/,
  );
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validPluginPackageManifest,
          entries: [
            {
              ...validPluginPackageManifest.entries[0],
              uses: { "example.echo": ["echo", "echo"] },
            },
          ],
        },
        "0.0.0",
      ),
    /contains duplicate value echo/,
  );
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validPluginPackageManifest,
          entries: [
            {
              ...validPluginPackageManifest.entries[0],
              uses: { "example.echo": ["delete-all"] },
            },
          ],
        },
        "0.0.0",
      ),
    /has an invalid identifier/,
  );
});

await test("internal manifest parser preserves existing scope declarations", () => {
  assert.deepEqual(parseInternalPluginManifest(validManifest, "0.0.0"), validManifest);
});

await test("manifest parser rejects unknown fields and module traversal", () => {
  assert.throws(
    () => parsePluginManifest({ ...validPluginPackageManifest, typo: true }, "0.0.0"),
    /manifest\.typo is not supported/,
  );
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validPluginPackageManifest,
          entries: [{ ...validPluginPackageManifest.entries[0], module: "../outside.js" }],
        },
        "0.0.0",
      ),
    /without traversal/,
  );
});
