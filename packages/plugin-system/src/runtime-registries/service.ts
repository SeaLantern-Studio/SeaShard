import {
  getServiceProviderMethod,
  resolveServiceResultValidators,
  validateServiceResult,
} from "@seashard/plugin-sdk";
import type {
  ExecutionContext,
  JsonValue,
  ScopeAddress,
  ServiceProvideOptions,
  ServiceProvider,
  ServiceResultValidator,
} from "@seashard/plugin-sdk";
import { allowsPermission, validateContract } from "./shared";

interface ServiceRegistration {
  contract: string;
  runtimeId: string;
  scope: ScopeAddress;
  provider: ServiceProvider;
  resultValidators: Readonly<Record<string, ServiceResultValidator>>;
}

export type ServiceCallAuthorizer = (
  execution: Readonly<ExecutionContext>,
  method: string,
) => boolean;

/** Service Registry 对诊断工具发布的只读运行态投影。 */
export interface ServiceRuntimeSnapshot {
  readonly contract: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly methods: readonly string[];
}

/**
 * 运行时注册表只保存当前 Cordis Fiber 的公开内容。
 *
 * 注册随着 Fiber 的 effect 自动撤销，不再复制 Publication、Lease 或
 * Generation 状态，也不把运行态写入数据库。
 */
export class ServiceRegistry {
  private readonly registrations = new Map<string, Set<ServiceRegistration>>();
  private readonly authorizers = new Map<string, ServiceCallAuthorizer>();

  register(
    contract: string,
    runtimeId: string,
    scope: ScopeAddress,
    provider: ServiceProvider,
    options?: ServiceProvideOptions,
  ): () => void {
    validateContract(contract);
    const methods = Object.entries(provider);
    if (methods.length === 0 || methods.some(([, method]) => typeof method !== "function")) {
      throw new TypeError(`service provider ${contract} must expose callable methods`);
    }
    const registration: ServiceRegistration = {
      contract,
      runtimeId,
      scope,
      provider,
      resultValidators: resolveServiceResultValidators(contract, provider, options),
    };
    let set = this.registrations.get(contract);
    if (!set) {
      set = new Set();
      this.registrations.set(contract, set);
    }
    if (
      [...set].some(
        (candidate) =>
          candidate.runtimeId === runtimeId &&
          candidate.scope.type === scope.type &&
          candidate.scope.id === scope.id,
      )
    ) {
      throw new Error(
        `service ${contract} is already registered by ${runtimeId} in ${scope.type}:${scope.id}`,
      );
    }
    set.add(registration);
    return () => {
      set?.delete(registration);
      if (set?.size === 0) this.registrations.delete(contract);
    };
  }

  /** 为核心特权 Contract 安装调用身份门；Provider 无法自行放宽该限制。 */
  restrict(contract: string, authorize: ServiceCallAuthorizer): () => void {
    validateContract(contract);
    if (this.authorizers.has(contract)) {
      throw new Error(`service ${contract} already has a call authorizer`);
    }
    this.authorizers.set(contract, authorize);
    return () => {
      if (this.authorizers.get(contract) === authorize) this.authorizers.delete(contract);
    };
  }

  has(contract: string, execution?: ExecutionContext): boolean {
    const set = this.registrations.get(contract);
    if (!set) return false;
    return execution ? this.select(contract, execution) !== undefined : set.size > 0;
  }

  async call(
    contract: string,
    method: string,
    args: JsonValue[],
    execution: ExecutionContext,
  ): Promise<JsonValue | void> {
    if (execution.actorType !== "core" && !allowsPermission(execution.permissions, contract)) {
      throw new Error(`actor ${execution.actorId} is not allowed to call ${contract}`);
    }
    const authorize = this.authorizers.get(contract);
    if (authorize && !authorize(execution, method)) {
      throw new Error(`actor ${execution.actorId} is not authorized to call ${contract}.${method}`);
    }
    const registration = this.select(contract, execution);
    if (!registration) throw new Error(`no service provider available: ${contract}`);
    const target = getServiceProviderMethod(registration.provider, method);
    if (!target) throw new Error(`service method does not exist: ${contract}.${method}`);
    const result = await target(...args);
    const validator = Object.hasOwn(registration.resultValidators, method)
      ? registration.resultValidators[method]
      : undefined;
    await validateServiceResult(validator, result, {
      runtimeId: registration.runtimeId,
      contract,
      method,
    });
    return result;
  }

  /**
   * 返回当前全部 Provider 的确定性快照。
   *
   * 快照只暴露 Contract、注册身份、Scope 与方法名；Provider 函数和验证器始终留在 Host。
   */
  snapshot(): readonly ServiceRuntimeSnapshot[] {
    const snapshots: ServiceRuntimeSnapshot[] = [];
    for (const registrations of this.registrations.values()) {
      for (const registration of registrations) {
        snapshots.push({
          contract: registration.contract,
          runtimeId: registration.runtimeId,
          scope: { ...registration.scope },
          methods: Object.keys(registration.provider).sort((left, right) =>
            left.localeCompare(right),
          ),
        });
      }
    }
    return snapshots.sort(
      (left, right) =>
        left.contract.localeCompare(right.contract) ||
        left.runtimeId.localeCompare(right.runtimeId) ||
        left.scope.type.localeCompare(right.scope.type) ||
        left.scope.id.localeCompare(right.scope.id),
    );
  }

  removeRuntime(runtimeId: string): void {
    for (const [contract, set] of this.registrations) {
      for (const registration of set) {
        if (registration.runtimeId === runtimeId) set.delete(registration);
      }
      if (set.size === 0) this.registrations.delete(contract);
    }
  }

  countRuntime(runtimeId?: string): number {
    let count = 0;
    for (const set of this.registrations.values()) {
      for (const registration of set) {
        if (!runtimeId || registration.runtimeId === runtimeId) count += 1;
      }
    }
    return count;
  }

  private select(contract: string, execution: ExecutionContext): ServiceRegistration | undefined {
    const set = this.registrations.get(contract);
    if (!set) return undefined;
    const chain = execution.scopeChain;
    let selected: ServiceRegistration | undefined;
    let selectedRank = -1;
    for (const registration of set) {
      const rank = chain.findIndex(
        (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
      );
      if (rank < 0) continue;
      if (rank === selectedRank) {
        throw new Error(
          `ambiguous providers for ${contract} in ${registration.scope.type}:${registration.scope.id}`,
        );
      }
      if (rank > selectedRank) {
        selected = registration;
        selectedRank = rank;
      }
    }
    return selected;
  }
}
