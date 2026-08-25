import { Command } from "commander";

const program = new Command();
program
  .name("seashard")
  .description("SeaShard Host plugin development CLI")
  .version("0.0.0")
  .showHelpAfterError();

const plugin = program
  .command("plugin")
  .description("Validate, package, install, and run Host plugins");

plugin
  .command("validate")
  .argument("[directory]", "plugin package directory", ".")
  .description("Validate plugin.json, compatibility, package paths, and entry modules")
  .action(async (directory: string) => {
    const { validatePlugin } = await import("./commands/validate");
    await validatePlugin(directory);
  });

plugin
  .command("build")
  .argument("[directory]", "plugin project directory", ".")
  .description("Run the plugin project's build script and validate its package")
  .action(async (directory: string) => {
    const { buildPlugin } = await import("./commands/build");
    await buildPlugin(directory);
  });

plugin
  .command("pack")
  .argument("[directory]", "validated plugin package directory", ".")
  .description("Create a deterministic .seashard-plugin archive")
  .action(async (directory: string) => {
    const { packPlugin } = await import("./commands/pack");
    await packPlugin(directory);
  });

plugin
  .command("install")
  .argument("<package-or-directory>", "plugin archive or directory snapshot")
  .description("Install a plugin through the actual SeaShard Host")
  .action(async (source: string) => {
    const { installPlugin } = await import("./commands/install");
    await installPlugin(source);
  });

plugin
  .command("dev")
  .argument("[directory]", "plugin project directory", ".")
  .description("Build the plugin, start the actual Host, and reload on source changes")
  .action(async (directory: string) => {
    const { developPlugin } = await import("./commands/dev");
    await developPlugin(directory);
  });

plugin
  .command("reload")
  .argument("[runtime-id]", "specific runtime ID")
  .description("Reload Host runtimes in active plugin development sessions")
  .action(async (runtimeId?: string) => {
    const { reloadPlugin } = await import("./commands/reload");
    await reloadPlugin(runtimeId);
  });

plugin
  .command("logs")
  .argument("[runtime-id]", "specific runtime ID")
  .description("Read bounded lifecycle and failure records from development Hosts")
  .action(async (runtimeId?: string) => {
    const { showPluginLogs } = await import("./commands/logs");
    await showPluginLogs(runtimeId);
  });

const inspect = program.command("inspect").description("Inspect public Host Service Contracts");

inspect
  .command("services")
  .option("--json", "emit stable JSON")
  .description("List compile-time Service documentation and live Providers")
  .action(async (options: { readonly json?: boolean }) => {
    const { inspectServiceDirectory } = await import("./commands/inspect");
    await inspectServiceDirectory(options.json === true);
  });

inspect
  .command("service")
  .argument("<contract>", "Service Contract")
  .option("--json", "emit stable JSON")
  .description("Show one Service Contract, its types, uses declaration, and live drift")
  .action(async (contract: string, options: { readonly json?: boolean }) => {
    const { inspectSingleService } = await import("./commands/inspect");
    await inspectSingleService(contract, options.json === true);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
