import catalogDocument from "./generated/service-catalog.json";

export interface ServiceCatalogParameter {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

export interface ServiceCatalogMethod {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
  readonly parameters: readonly ServiceCatalogParameter[];
  readonly returns: { readonly type: string; readonly description: string };
  readonly throws: readonly string[];
}

export interface ServiceCatalogType {
  readonly name: string;
  readonly description: string;
  readonly declaration: string;
  readonly source: string;
}

export interface ServiceCatalogEntry {
  readonly contract: string;
  readonly owner: string;
  readonly description: string;
  readonly source: string;
  readonly methods: readonly ServiceCatalogMethod[];
  readonly types: readonly ServiceCatalogType[];
}

export interface LiveServiceProvider {
  readonly sessionId: string;
  readonly contract: string;
  readonly runtimeId: string;
  readonly scope: { readonly type: string; readonly id: string };
  readonly methods: readonly string[];
}

export interface ServiceProviderDrift {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly missingMethods: readonly string[];
  readonly extraMethods: readonly string[];
}

export interface ServiceInspection {
  readonly contract: string;
  readonly status: "active" | "inactive" | "undocumented";
  readonly owner?: string;
  readonly description?: string;
  readonly catalog?: ServiceCatalogEntry;
  readonly providers: readonly LiveServiceProvider[];
  readonly drift: readonly ServiceProviderDrift[];
  readonly uses: Readonly<Record<string, readonly string[]>>;
}

const catalog = catalogDocument as {
  readonly version: 1;
  readonly services: readonly ServiceCatalogEntry[];
};

/** 将编译期 Catalog 与一个或多个实际 Host 会话的 Registry 快照交叉。 */
export function inspectServices(
  providers: readonly LiveServiceProvider[],
): readonly ServiceInspection[] {
  const catalogByContract = new Map(catalog.services.map((service) => [service.contract, service]));
  const providersByContract = new Map<string, LiveServiceProvider[]>();
  for (const provider of providers) {
    const group = providersByContract.get(provider.contract);
    if (group) group.push(provider);
    else providersByContract.set(provider.contract, [provider]);
  }
  const contracts = new Set([...catalogByContract.keys(), ...providersByContract.keys()]);
  return [...contracts]
    .sort((left, right) => left.localeCompare(right))
    .map((contract) =>
      inspectContract(
        contract,
        catalogByContract.get(contract),
        providersByContract.get(contract) ?? [],
      ),
    );
}

export function findServiceInspection(
  contract: string,
  providers: readonly LiveServiceProvider[],
): ServiceInspection | undefined {
  return inspectServices(providers).find((service) => service.contract === contract);
}

export function formatServiceDirectory(services: readonly ServiceInspection[]): string {
  if (services.length === 0) return "No Service Contracts found.";
  const lines: string[] = [];
  for (const service of services) {
    const owner = service.owner ? ` · ${service.owner}` : " · third-party runtime";
    const description = service.description ? ` · ${service.description}` : "";
    lines.push(`${service.status.padEnd(12)} ${service.contract}${owner}${description}`);
    if (service.catalog) {
      for (const method of service.catalog.methods) lines.push(`  ${method.signature}`);
    } else {
      const methods = new Set(service.providers.flatMap((provider) => provider.methods));
      for (const method of [...methods].sort((left, right) => left.localeCompare(right))) {
        lines.push(`  ${method}(signature unavailable)`);
      }
    }
    for (const drift of service.drift) {
      if (drift.missingMethods.length) {
        lines.push(`  ! ${drift.runtimeId} missing: ${drift.missingMethods.join(", ")}`);
      }
      if (drift.extraMethods.length) {
        lines.push(`  ! ${drift.runtimeId} extra: ${drift.extraMethods.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatServiceDetail(service: ServiceInspection): string {
  const lines = [
    service.contract,
    `Status: ${service.status}`,
    `Owner: ${service.owner ?? "third-party runtime"}`,
    `Description: ${service.description ?? "signature unavailable"}`,
  ];
  if (service.catalog) lines.push(`Source: ${service.catalog.source}`);

  lines.push("", "Uses:", JSON.stringify(service.uses, null, 2), "", "Methods:");
  if (service.catalog) {
    for (const method of service.catalog.methods) {
      lines.push(`- ${method.signature}`, `  ${method.description}`);
      for (const parameter of method.parameters) {
        lines.push(`  @param ${parameter.name}: ${parameter.description} [${parameter.type}]`);
      }
      if (method.returns.description) {
        lines.push(`  @returns ${method.returns.description} [${method.returns.type}]`);
      }
      for (const failure of method.throws) lines.push(`  @throws ${failure}`);
    }
  } else {
    const methods = new Set(service.providers.flatMap((provider) => provider.methods));
    for (const method of [...methods].sort((left, right) => left.localeCompare(right))) {
      lines.push(`- ${method}(signature unavailable)`);
    }
  }

  lines.push("", "Providers:");
  if (service.providers.length === 0) {
    lines.push("- inactive");
  } else {
    for (const provider of service.providers) {
      lines.push(
        `- ${provider.runtimeId} · ${provider.scope.type}:${provider.scope.id} · session ${provider.sessionId}`,
        `  methods: ${provider.methods.join(", ")}`,
      );
    }
  }

  if (service.drift.length) {
    lines.push("", "Drift:");
    for (const drift of service.drift) {
      lines.push(
        `- ${drift.runtimeId}: missing [${drift.missingMethods.join(", ")}], extra [${drift.extraMethods.join(", ")}]`,
      );
    }
  }

  if (service.catalog?.types.length) {
    lines.push("", "Referenced types:");
    for (const type of service.catalog.types) {
      lines.push("", `${type.name} · ${type.source}`);
      if (type.description) lines.push(type.description);
      lines.push(type.declaration);
    }
  }
  return lines.join("\n");
}

function inspectContract(
  contract: string,
  catalogEntry: ServiceCatalogEntry | undefined,
  providers: readonly LiveServiceProvider[],
): ServiceInspection {
  const catalogMethods = new Set(catalogEntry?.methods.map((method) => method.name) ?? []);
  const drift = catalogEntry
    ? providers
        .map((provider) => {
          const providerMethods = new Set(provider.methods);
          return {
            sessionId: provider.sessionId,
            runtimeId: provider.runtimeId,
            missingMethods: [...catalogMethods]
              .filter((method) => !providerMethods.has(method))
              .sort((left, right) => left.localeCompare(right)),
            extraMethods: [...providerMethods]
              .filter((method) => !catalogMethods.has(method))
              .sort((left, right) => left.localeCompare(right)),
          };
        })
        .filter((difference) => difference.missingMethods.length || difference.extraMethods.length)
    : [];
  const methodNames = catalogEntry
    ? catalogEntry.methods.map((method) => method.name)
    : [...new Set(providers.flatMap((provider) => provider.methods))].sort((left, right) =>
        left.localeCompare(right),
      );
  return {
    contract,
    status: catalogEntry ? (providers.length ? "active" : "inactive") : "undocumented",
    ...(catalogEntry
      ? {
          owner: catalogEntry.owner,
          description: catalogEntry.description,
          catalog: catalogEntry,
        }
      : {}),
    providers: [...providers].sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.runtimeId.localeCompare(right.runtimeId),
    ),
    drift,
    uses: { [contract]: methodNames },
  };
}
