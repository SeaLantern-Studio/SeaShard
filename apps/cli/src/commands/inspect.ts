import { discoverHostSnapshots, projectLiveServices } from "../host-control";
import {
  findServiceInspection,
  formatServiceDetail,
  formatServiceDirectory,
  inspectServices,
} from "../service-catalog";

export async function inspectServiceDirectory(json: boolean): Promise<void> {
  const providers = projectLiveServices(await discoverHostSnapshots());
  const services = inspectServices(providers);
  console.log(
    json ? JSON.stringify({ version: 1, services }, null, 2) : formatServiceDirectory(services),
  );
}

export async function inspectSingleService(contract: string, json: boolean): Promise<void> {
  const providers = projectLiveServices(await discoverHostSnapshots());
  const service = findServiceInspection(contract, providers);
  if (!service) throw new Error(`Service Contract is not documented or active: ${contract}`);
  console.log(
    json ? JSON.stringify({ version: 1, service }, null, 2) : formatServiceDetail(service),
  );
}
