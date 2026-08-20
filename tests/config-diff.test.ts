import { buildChangedConfigurationLines } from "../frontend/server/configuration/src/client/config-diff.ts";
import assert from "node:assert/strict";
import test from "node:test";

await test("configuration diff returns only deleted and added lines with unified line numbers", () => {
  const lines = buildChangedConfigurationLines(
    "# header\na=1\nb=2\nc=3\n",
    "# header\na=1\nb=9\nnew=true\nc=3\n",
  );

  assert.deepEqual(lines, [
    { type: "deletion", leftNumber: 3, rightNumber: null, text: "b=2" },
    { type: "addition", leftNumber: null, rightNumber: 3, text: "b=9" },
    { type: "addition", leftNumber: null, rightNumber: 4, text: "new=true" },
  ]);
});

await test("configuration diff keeps duplicate surrounding lines out of an insertion", () => {
  assert.deepEqual(
    buildChangedConfigurationLines("a\nsame\nsame\nz\n", "a\nsame\nnew\nsame\nz\n"),
    [{ type: "addition", leftNumber: null, rightNumber: 3, text: "new" }],
  );
});

await test("configuration diff handles large mostly unchanged files without a full LCS matrix", () => {
  const original = Array.from({ length: 5_000 }, (_, index) => `property-${index}=old`).join("\n");
  const targetLines = original.split("\n");
  targetLines[2_499] = "property-2499=new";

  assert.deepEqual(buildChangedConfigurationLines(original, targetLines.join("\n")), [
    { type: "deletion", leftNumber: 2_500, rightNumber: null, text: "property-2499=old" },
    { type: "addition", leftNumber: null, rightNumber: 2_500, text: "property-2499=new" },
  ]);
});
