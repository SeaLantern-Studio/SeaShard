export type ServerPropertyValueType = "boolean" | "number" | "gamemode" | "difficulty" | "text";

export interface ServerPropertyEntry {
  readonly key: string;
  readonly value: string;
  readonly description: string;
  readonly category: string;
  readonly valueType: ServerPropertyValueType;
  readonly defaultValue?: string;
}

interface PropertyMetadata {
  readonly description: string;
  readonly category: string;
  readonly valueType: ServerPropertyValueType;
  readonly defaultValue?: string;
}

export const serverPropertyCategories = [
  { id: "all", label: "全部" },
  { id: "network", label: "网络" },
  { id: "player", label: "玩家" },
  { id: "game", label: "玩法" },
  { id: "world", label: "世界" },
  { id: "performance", label: "性能" },
  { id: "display", label: "展示" },
  { id: "other", label: "其他" },
] as const;

const propertyMetadata: Readonly<Record<string, PropertyMetadata>> = {
  "server-port": numberProperty("服务器监听端口", "network", "25565"),
  "server-ip": textProperty("绑定 IP；留空监听所有网卡", "network", ""),
  "enable-query": booleanProperty("启用 GameSpy4 查询协议", "network", "false"),
  "query.port": numberProperty("查询协议监听端口", "network", "25565"),
  "enable-rcon": booleanProperty("启用 RCON 远程控制", "network", "false"),
  "rcon.port": numberProperty("RCON 监听端口", "network", "25575"),
  "rcon.password": textProperty("RCON 访问密码", "network", ""),
  "enable-status": booleanProperty("响应服务器列表状态查询", "network", "true"),
  "network-compression-threshold": numberProperty("网络数据压缩阈值", "network", "256"),
  "use-native-transport": booleanProperty("使用平台原生网络传输", "network", "true"),
  "max-players": numberProperty("允许同时在线的最大玩家数", "player", "20"),
  "online-mode": booleanProperty("验证玩家的正版账户", "player", "true"),
  "white-list": booleanProperty("启用白名单", "player", "false"),
  "enforce-whitelist": booleanProperty("立即移除不在白名单中的在线玩家", "player", "false"),
  "player-idle-timeout": numberProperty("空闲玩家自动踢出分钟数；0 表示关闭", "player", "0"),
  "prevent-proxy-connections": booleanProperty("阻止代理或 VPN 连接", "player", "false"),
  "hide-online-players": booleanProperty("在状态查询中隐藏在线玩家列表", "player", "false"),
  gamemode: selectProperty("新玩家的默认游戏模式", "game", "survival", "gamemode"),
  difficulty: selectProperty("世界难度", "game", "easy", "difficulty"),
  hardcore: booleanProperty("启用极限模式", "game", "false"),
  pvp: booleanProperty("允许玩家之间造成伤害", "game", "true"),
  "allow-flight": booleanProperty("允许生存模式玩家飞行", "game", "false"),
  "enable-command-block": booleanProperty("启用命令方块", "game", "false"),
  "force-gamemode": booleanProperty("玩家加入时强制切换默认游戏模式", "game", "false"),
  "spawn-protection": numberProperty("出生点保护半径", "game", "16"),
  "level-name": textProperty("世界目录名称", "world", "world"),
  "level-seed": textProperty("新世界种子；留空随机生成", "world", ""),
  "level-type": textProperty("世界生成类型", "world", "minecraft:normal"),
  "generator-settings": textProperty("自定义世界生成器设置", "world", "{}"),
  "allow-nether": booleanProperty("允许进入下界", "world", "true"),
  "spawn-monsters": booleanProperty("生成敌对生物", "world", "true"),
  "spawn-animals": booleanProperty("生成动物", "world", "true"),
  "spawn-npcs": booleanProperty("生成村民等 NPC", "world", "true"),
  "generate-structures": booleanProperty("生成村庄、要塞等结构", "world", "true"),
  "view-distance": numberProperty("发送给玩家的区块视距", "performance", "10"),
  "simulation-distance": numberProperty("实体与方块刻的模拟距离", "performance", "10"),
  "max-tick-time": numberProperty("单个 Tick 最大耗时；-1 关闭看门狗", "performance", "60000"),
  "sync-chunk-writes": booleanProperty("同步写入区块数据", "performance", "true"),
  "entity-broadcast-range-percentage": numberProperty("实体广播距离百分比", "performance", "100"),
  "rate-limit": numberProperty("单连接每秒数据包限制；0 表示关闭", "performance", "0"),
  motd: textProperty("服务器列表中显示的描述", "display", "A Minecraft Server"),
  "resource-pack": textProperty("资源包下载地址", "display", ""),
  "resource-pack-sha1": textProperty("资源包 SHA-1", "display", ""),
  "require-resource-pack": booleanProperty("要求玩家接受资源包", "display", "false"),
  "resource-pack-prompt": textProperty("资源包确认提示文本", "display", ""),
};

/** 解析 Minecraft 生成的 key=value 行；注释、空行与未知行始终留在原始文本中。 */
export function parseServerPropertiesSource(source: string): readonly ServerPropertyEntry[] {
  const entries = new Map<string, ServerPropertyEntry>();
  for (const line of source.split(/\r\n|\n|\r/u)) {
    const parsed = parsePropertyLine(line);
    if (!parsed) continue;
    const metadata = propertyMetadata[parsed.key];
    const valueType = metadata?.valueType ?? inferValueType(parsed.value);
    entries.set(parsed.key, {
      key: parsed.key,
      value: parsed.value,
      description: metadata?.description ?? "此属性由当前服务器核心提供",
      category: metadata?.category ?? "other",
      valueType,
      ...(metadata?.defaultValue !== undefined ? { defaultValue: metadata.defaultValue } : {}),
    });
  }
  return [...entries.values()];
}

/** 只替换指定属性的值，保留原始注释、顺序、空行、分隔符和换行风格。 */
export function renderServerPropertiesSource(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  const parts = source.split(/(\r\n|\n|\r)/u);
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const parsed = parsePropertyLine(line);
    if (!parsed || !(parsed.key in values)) continue;
    parts[index] = `${parsed.prefix}${values[parsed.key]}`;
  }
  return parts.join("");
}

function parsePropertyLine(
  line: string,
): { readonly key: string; readonly value: string; readonly prefix: string } | undefined {
  if (/^\s*[#!]/u.test(line)) return undefined;
  const match = /^(\s*([^#!\s:=]+)\s*[=:]\s*)(.*)$/u.exec(line);
  if (!match) return undefined;
  return { key: match[2]!, value: match[3]!, prefix: match[1]! };
}

function inferValueType(value: string): ServerPropertyValueType {
  if (value === "true" || value === "false") return "boolean";
  return "text";
}

function textProperty(
  description: string,
  category: string,
  defaultValue: string,
): PropertyMetadata {
  return { description, category, valueType: "text", defaultValue };
}

function numberProperty(
  description: string,
  category: string,
  defaultValue: string,
): PropertyMetadata {
  return { description, category, valueType: "number", defaultValue };
}

function booleanProperty(
  description: string,
  category: string,
  defaultValue: string,
): PropertyMetadata {
  return { description, category, valueType: "boolean", defaultValue };
}

function selectProperty(
  description: string,
  category: string,
  defaultValue: string,
  valueType: "gamemode" | "difficulty",
): PropertyMetadata {
  return { description, category, valueType, defaultValue };
}
