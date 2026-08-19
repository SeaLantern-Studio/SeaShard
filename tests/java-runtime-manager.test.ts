import {
  createJavaRuntimeManagerModule,
  JavaRuntimeScanner,
  javaRuntimeManagerManifest,
  parseJavaMajorVersion,
  shouldExploreNanaloveyukiDirectory,
} from "../components/game/java-runtime-manager/src/index.ts";
import {
  javaRuntimeManagerContract,
  type JavaRuntimeManagerService,
} from "../packages/contracts/src/index.ts";
import type {
  JsonValue,
  PluginContext,
  PluginStorage,
  PluginStoredDocument,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

class MemoryPluginStorage implements PluginStorage {
  private readonly documents = new Map<string, PluginStoredDocument>();

  async get(key: string): Promise<PluginStoredDocument | undefined> {
    return this.documents.get(key);
  }

  async put(key: string, value: JsonValue): Promise<PluginStoredDocument> {
    const previous = this.documents.get(key);
    const document: PluginStoredDocument = {
      value,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(key, document);
    return document;
  }

  async delete(key: string): Promise<boolean> {
    return this.documents.delete(key);
  }
}

interface FakeJavaOptions {
  readonly directoryName: string;
  readonly version: string;
  readonly vendor: string;
  readonly architecture: string;
  readonly writeRelease?: boolean;
}

async function writeFakeJava(
  root: string,
  options: FakeJavaOptions,
): Promise<{ readonly executable: string; readonly javaHome: string }> {
  const javaHome = join(root, options.directoryName);
  const binDirectory = join(javaHome, "bin");
  const executable = join(binDirectory, "java.exe");
  await mkdir(binDirectory, { recursive: true });
  // 内容故意不是可执行程序：自动发现必须仅依赖 release 元数据。
  await writeFile(executable, "SeaShard test fixture; never execute this file.\n", "utf8");
  if (options.writeRelease !== false) {
    await writeFile(
      join(javaHome, "release"),
      [
        `JAVA_VERSION="${options.version}"`,
        `IMPLEMENTOR="${options.vendor}"`,
        `OS_ARCH="${options.architecture}"`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return { executable, javaHome };
}

await test("Java scanner reads release metadata, deduplicates paths, and sorts new versions first", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-java-runtime-"));
  try {
    const java21 = await writeFakeJava(root, {
      directoryName: "temurin-21",
      version: "21.0.7+6-LTS",
      vendor: "Eclipse Adoptium",
      architecture: "amd64",
    });
    const java8 = await writeFakeJava(root, {
      directoryName: "zulu-8",
      version: "1.8.0_452",
      vendor: "Azul Systems, Inc.",
      architecture: "x86",
    });
    const javaWithoutRelease = await writeFakeJava(root, {
      directoryName: "manual-java-17",
      version: "unused",
      vendor: "unused",
      architecture: "unused",
      writeRelease: false,
    });
    const invalidJava = await writeFakeJava(root, {
      directoryName: "invalid-java",
      version: "not-a-version",
      vendor: "Broken Vendor",
      architecture: "amd64",
    });
    let inspectedJavaPath: string | undefined;
    const rejected: unknown[] = [];
    const scanner = new JavaRuntimeScanner({
      platform: "win32",
      candidateProviders: [
        async () => [
          { path: java8.executable, source: "filesystem" },
          { path: java21.executable, source: "java-home" },
          { path: java21.executable, source: "path" },
          { path: invalidJava.executable, source: "filesystem" },
          { path: join(root, "missing", "bin", "java.exe"), source: "filesystem" },
        ],
      ],
      reportError: (error) => rejected.push(error),
      selectedJavaPropertiesProvider: async (executablePath) => {
        inspectedJavaPath = executablePath;
        return [
          "Property settings:",
          "    java.version = 17.0.12",
          "    java.vendor = Manual Java Vendor",
          "    os.arch = aarch64",
        ].join("\n");
      },
    });

    const installations = await scanner.scan();
    assert.equal(installations.length, 2);
    assert.deepEqual(
      installations.map((installation) => installation.majorVersion),
      [21, 8],
    );
    assert.deepEqual(installations[0], {
      id: installations[0]!.id,
      path: java21.executable,
      javaHome: java21.javaHome,
      version: "21.0.7+6-LTS",
      majorVersion: 21,
      vendor: "Eclipse Adoptium",
      architecture: "x64",
      is64Bit: true,
      source: "java-home",
      disabled: false,
    });
    assert.match(installations[0]!.id, /^[a-f0-9]{16}$/u);
    assert.equal(installations[1]!.architecture, "x86");
    assert.equal(installations[1]!.is64Bit, false);
    assert.equal(rejected.length, 1, "单个损坏候选不能中止完整扫描");
    const manuallySelected = await scanner.inspect(javaWithoutRelease.executable);
    assert.deepEqual(manuallySelected, {
      id: manuallySelected.id,
      path: javaWithoutRelease.executable,
      javaHome: javaWithoutRelease.javaHome,
      version: "17.0.12",
      majorVersion: 17,
      vendor: "Manual Java Vendor",
      architecture: "arm64",
      is64Bit: true,
      source: "manual",
      disabled: false,
    });
    assert.equal(inspectedJavaPath, javaWithoutRelease.executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Java manager persists manual records and disabled automatic installations", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-java-manager-"));
  try {
    const selectedJava = await writeFakeJava(root, {
      directoryName: "manual-java-21",
      version: "21.0.7",
      vendor: "Manual Vendor",
      architecture: "amd64",
    });
    const storage = new MemoryPluginStorage();
    const activateManager = async (): Promise<JavaRuntimeManagerService> => {
      const providers = new Map<string, ServiceProvider>();
      const context = {
        storage,
        provide: (contract: string, provider: ServiceProvider) => providers.set(contract, provider),
      } as unknown as PluginContext;
      await createJavaRuntimeManagerModule({
        platform: "win32",
        candidateProviders: [async () => [{ path: selectedJava.executable, source: "filesystem" }]],
      }).apply(context, null);
      const service = providers.get(javaRuntimeManagerContract);
      assert.ok(service, "Java runtime manager must publish its scan service");
      return service as unknown as JavaRuntimeManagerService;
    };

    const javaRuntimeManager = await activateManager();
    const automatic = (await javaRuntimeManager.scan())[0]!;
    assert.equal(automatic.source, "filesystem");
    assert.equal(automatic.disabled, false);
    assert.equal(await javaRuntimeManager.setDisabled(automatic.id, true), true);
    assert.deepEqual(await javaRuntimeManager.scan(), [{ ...automatic, disabled: true }]);

    const restartedJavaRuntimeManager = await activateManager();
    assert.deepEqual(await restartedJavaRuntimeManager.scan(), [{ ...automatic, disabled: true }]);
    assert.equal(await restartedJavaRuntimeManager.setDisabled(automatic.id, false), false);
    assert.deepEqual(await restartedJavaRuntimeManager.scan(), [automatic]);

    const inspected = await restartedJavaRuntimeManager.inspect(selectedJava.executable);
    assert.equal(inspected.source, "manual");
    assert.equal(inspected.disabled, false);
    assert.deepEqual(await restartedJavaRuntimeManager.scan(), [inspected]);
    assert.equal(await restartedJavaRuntimeManager.remove(selectedJava.executable), true);
    assert.deepEqual(await restartedJavaRuntimeManager.scan(), [automatic]);
    await access(selectedJava.executable);

    assert.equal(await restartedJavaRuntimeManager.remove(selectedJava.executable), false);
    await assert.rejects(restartedJavaRuntimeManager.inspect(""), /non-empty string/);
    await assert.rejects(restartedJavaRuntimeManager.remove(""), /non-empty string/);
    await assert.rejects(restartedJavaRuntimeManager.setDisabled("invalid", true), /16-character/);
    assert.equal(javaRuntimeManagerManifest.entries[0]?.runtime, "host");
    assert.equal(parseJavaMajorVersion("1.8.0_452"), 8);
    assert.equal(parseJavaMajorVersion("21.0.7+6-LTS"), 21);
    assert.equal(parseJavaMajorVersion("invalid"), 0);
    assert.equal(shouldExploreNanaloveyukiDirectory("Eclipse Adoptium JDK 21"), true);
    assert.equal(shouldExploreNanaloveyukiDirectory("Documents"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
