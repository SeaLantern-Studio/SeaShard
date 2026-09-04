import process from "node:process";

const [, , packageName, version] = process.argv;

if (!packageName || !version) {
  console.error("用法: node scripts/verify-npm-registry-version.mjs <package-name> <version>");
  process.exit(1);
}

const attempts = 12;
const intervalMs = 5_000;
const encodedPackageName = encodeURIComponent(packageName);
const encodedVersion = encodeURIComponent(version);
const metadataUrl = `https://registry.npmjs.org/${encodedPackageName}/${encodedVersion}`;
let lastResult = "尚未请求";

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    // 精确版本端点不会依赖包级 packument 与 dist-tag 的同步进度，适合紧跟 publish 的确认步骤。
    const response = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (response.ok) {
      const metadata = await response.json();
      if (metadata.name === packageName && metadata.version === version) {
        console.log(`${packageName}@${version} 已在 npm Registry 可见`);
        process.exit(0);
      }
      lastResult = `元数据不匹配: ${String(metadata.name)}@${String(metadata.version)}`;
    } else {
      lastResult = `HTTP ${response.status}`;
    }
  } catch (error) {
    lastResult = error instanceof Error ? error.message : String(error);
  }

  if (attempt < attempts) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

console.error(`${packageName}@${version} 在 npm Registry 的可见性校验超时：${lastResult}`);
process.exit(1);
