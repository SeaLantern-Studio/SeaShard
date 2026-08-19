import type { ServerSettingsSnapshot } from "@seashard/contracts";

export function buildManagedJvmArguments(settings: ServerSettingsSnapshot): readonly string[] {
  const customArguments = parseJvmArguments(settings.defaultJvmArguments);
  for (const argument of customArguments) {
    if (argument === "-jar" || /^-Xm[sx]/iu.test(argument)) {
      throw new TypeError("default JVM arguments must not override -jar, -Xms, or -Xmx");
    }
  }
  return [
    ...customArguments,
    `-Xms${settings.defaultMinimumMemoryMiB}M`,
    `-Xmx${settings.defaultMaximumMemoryMiB}M`,
  ];
}

/** 将设置中的 JVM 参数解析为 spawn 参数数组，不经过 shell。 */
export function parseJvmArguments(input: string): readonly string[] {
  const arguments_: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (!quote) quote = character;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next && (next === "\\" || next === '"' || next === "'" || /\s/u.test(next))) {
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    if (!quote && /\s/u.test(character)) {
      if (tokenStarted) arguments_.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote) throw new TypeError("default JVM arguments contain an unterminated quote");
  if (tokenStarted) arguments_.push(token);
  return arguments_;
}
