import { Cmz_Console, type ConsoleLine } from "cmzya-modern-ui";
import assert from "node:assert/strict";
import test from "node:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

await test("console parser tags an unbracketed Nukkit timestamp before metadata and INFO", async () => {
  const lines: ConsoleLine[] = [
    {
      text: "23:41:21 [main] [INFO] Done (4.018s)! For help, type help",
      type: "info",
      timestamp: "23:41:21",
    },
  ];
  const html = await renderToString(
    createSSRApp({
      render: () => h(Cmz_Console, { lines, readonly: true, height: "240px" }),
    }),
  );

  assert.match(html, /cmz-console__text--time[^>]*>23:41:21<\/span>/u);
  assert.match(html, /cmz-console__text--meta[^>]*>main<\/span>/u);
  assert.match(html, /cmz-console__text--level-info[^>]*>INFO<\/span>/u);
});
