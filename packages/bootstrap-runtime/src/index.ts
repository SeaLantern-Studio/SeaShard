import { Context, type Fiber } from "cordis";

export type BootstrapDisposer = () => void | Promise<void>;

/**
 * 编译进 Core 的受保护启动组件描述。
 *
 * Bootstrap Descriptor 只描述启动依赖和装载函数，不参与普通插件的
 * Generation、Publication 与热重载流程。
 */
export interface BootstrapDescriptor {
  readonly id: string;
  readonly buildDigest: string;
  readonly inject: readonly string[];
  readonly provides: readonly string[];
  load(ctx: Context): void | BootstrapDisposer | Promise<void | BootstrapDisposer>;
}

export interface LoadedBootstrapComponent {
  readonly id: string;
  readonly buildDigest: string;
  readonly provides: readonly string[];
}

const componentIdPattern = /^[a-z][a-z0-9.-]{0,126}$/;
const contractPattern = /^[a-z][a-z0-9.*:-]{0,126}$/;
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * 在普通插件运行时创建前装载受保护组件。
 *
 * Loader 只负责固定依赖图、Cordis 生命周期绑定和失败回滚；它不读取插件目录，
 * 也不根据数据库中的启用状态决定是否启动组件。
 */
export class BootstrapLoader {
  private readonly fibers: Fiber[] = [];
  private readonly loadedComponents: LoadedBootstrapComponent[] = [];
  private started = false;
  private disposeTask?: Promise<void>;

  constructor(readonly root: Context) {}

  /**
   * 校验并启动完整 Descriptor 集合。
   *
   * 任一组件启动失败时会逆序释放已经启动的 Fiber，避免留下半初始化数据库、
   * 文件租约或 Worker。
   */
  async start(descriptors: readonly BootstrapDescriptor[]): Promise<void> {
    if (this.started) throw new Error("bootstrap loader has already started");
    this.started = true;
    // 先完成确定性的拓扑排序，避免依赖装载顺序受调用方数组顺序影响。
    const ordered = orderDescriptors(descriptors);
    try {
      for (const descriptor of ordered) {
        const adapter = {
          name: descriptor.id,
          // Cordis 也必须看到 inject；仅在 Loader 内排序不足以获得 Context 服务访问权。
          inject: descriptor.inject,
          apply: async (ctx: Context) => {
            const dispose = await descriptor.load(ctx);
            if (dispose) ctx.effect(() => dispose, `bootstrap component ${descriptor.id}`);
          },
        };
        // 每个 Bootstrap Component 仍使用独立 Fiber，统一继承 Cordis 的清理栈。
        const fiber = this.root.plugin(adapter);
        this.fibers.push(fiber);
        await fiber;
        this.loadedComponents.push({
          id: descriptor.id,
          buildDigest: descriptor.buildDigest,
          provides: [...descriptor.provides],
        });
      }
    } catch (error) {
      // 启动失败不是降级成功：必须先完整回滚，再把原始错误交给宿主。
      await this.dispose();
      throw error;
    }
  }

  /** 返回防御性复制的已启动组件视图，供启动诊断使用。 */
  snapshot(): readonly LoadedBootstrapComponent[] {
    return this.loadedComponents.map((component) => ({
      ...component,
      provides: [...component.provides],
    }));
  }

  /** 幂等地逆序释放全部受保护组件。 */
  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeFibers();
    return this.disposeTask;
  }

  private async disposeFibers(): Promise<void> {
    // 依赖者必须先于提供者停止，例如 Storage 先停、Database 最后释放 DataRoot Lease。
    const failures: unknown[] = [];
    for (const fiber of this.fibers.reverse()) {
      try {
        await fiber.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.fibers.length = 0;
    this.loadedComponents.length = 0;
    if (failures.length) throw new AggregateError(failures, "bootstrap component disposal failed");
  }
}

/**
 * 根据 inject/provides 构建稳定的拓扑顺序。
 *
 * 相同层级按组件 ID 排序，保证不同平台和不同调用方得到一致的启动结果。
 */
export function orderDescriptors(
  descriptors: readonly BootstrapDescriptor[],
): readonly BootstrapDescriptor[] {
  const components = new Map<string, BootstrapDescriptor>();
  const providers = new Map<string, string>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (components.has(descriptor.id))
      throw new Error(`duplicate bootstrap component: ${descriptor.id}`);
    components.set(descriptor.id, descriptor);
    for (const contract of descriptor.provides) {
      const existing = providers.get(contract);
      if (existing) {
        throw new Error(
          `bootstrap contract ${contract} is provided by both ${existing} and ${descriptor.id}`,
        );
      }
      providers.set(contract, descriptor.id);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    const required = new Set<string>();
    for (const contract of descriptor.inject) {
      const provider = providers.get(contract);
      if (!provider) {
        throw new Error(`bootstrap component ${descriptor.id} requires missing ${contract}`);
      }
      if (provider === descriptor.id) {
        throw new Error(`bootstrap component ${descriptor.id} cannot inject its own ${contract}`);
      }
      required.add(provider);
    }
    dependencies.set(descriptor.id, required);
  }

  const ordered: BootstrapDescriptor[] = [];
  const remaining = new Map(dependencies);
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, required]) => [...required].every((id) => !remaining.has(id)))
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right));
    if (!ready.length) {
      throw new Error(`bootstrap dependency cycle: ${[...remaining.keys()].sort().join(", ")}`);
    }
    for (const id of ready) {
      ordered.push(components.get(id)!);
      remaining.delete(id);
    }
  }
  return ordered;
}

function validateDescriptor(descriptor: BootstrapDescriptor): void {
  if (!componentIdPattern.test(descriptor.id)) {
    throw new TypeError(`invalid bootstrap component id: ${descriptor.id}`);
  }
  if (!digestPattern.test(descriptor.buildDigest)) {
    throw new TypeError(`invalid bootstrap build digest for ${descriptor.id}`);
  }
  for (const [kind, contracts] of [
    ["inject", descriptor.inject],
    ["provides", descriptor.provides],
  ] as const) {
    const unique = new Set<string>();
    for (const contract of contracts) {
      if (!contractPattern.test(contract)) {
        throw new TypeError(`invalid bootstrap ${kind} contract: ${contract}`);
      }
      if (unique.has(contract)) {
        throw new TypeError(`duplicate bootstrap ${kind} contract: ${contract}`);
      }
      unique.add(contract);
    }
  }
}
