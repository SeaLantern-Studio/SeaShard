import {
  isMissingJava25RuntimeError,
  runtimeErrorMessage,
} from "../frontend/server/launch/src/client/runtime-error.ts";
import assert from "node:assert/strict";
import test from "node:test";

await test("runtime errors hide Electron IPC details and classify missing Java 25", () => {
  const missingJava25Error = new Error(
    "Error invoking remote method 'seashard:server-runtime:start': Error: 未检测到已启用的 Java 25。NeoForge 26.1 必须使用 Java 25，请先启用、安装或添加对应的 Java 后重试。",
  );

  assert.equal(
    runtimeErrorMessage(missingJava25Error),
    "未检测到已启用的 Java 25。NeoForge 26.1 必须使用 Java 25，请先启用、安装或添加对应的 Java 后重试。",
  );
  assert.equal(isMissingJava25RuntimeError(missingJava25Error), true);
  assert.equal(isMissingJava25RuntimeError(new Error("Error: 服务器启动失败")), false);
  assert.equal(runtimeErrorMessage(new Error("Error: 服务器启动失败")), "服务器启动失败");
  assert.equal(runtimeErrorMessage("服务器已停止"), "服务器已停止");
});
