import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getNamespacesRegistryPath, getServerDir } from "./config.ts";
import type { InstanceRecord, MachineRecord, NamespaceRecord } from "./types.ts";

function ensureServerDir(): void {
	const serverDir = getServerDir();
	if (!existsSync(serverDir)) {
		mkdirSync(serverDir, { recursive: true });
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return undefined;
	}

	const data = readFileSync(machinePath, "utf-8");
	return JSON.parse(data) as MachineRecord;
}

export function saveMachine(machine: MachineRecord): void {
	ensureServerDir();
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
	if (!existsSync(instancesPath)) {
		return [];
	}

	const data = readFileSync(instancesPath, "utf-8");
	return JSON.parse(data) as InstanceRecord[];
}

export function saveInstances(instances: InstanceRecord[]): void {
	ensureServerDir();
	writeFileSync(getInstancesPath(), JSON.stringify(instances, null, 2));
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}

export function loadNamespaces(): NamespaceRecord[] {
	const registryPath = getNamespacesRegistryPath();
	if (!existsSync(registryPath)) {
		return [];
	}

	const data = readFileSync(registryPath, "utf-8");
	return JSON.parse(data) as NamespaceRecord[];
}

/** Write via temp-file + rename so a crash mid-write never leaves a truncated/corrupt namespaces.json. */
export function saveNamespaces(namespaces: NamespaceRecord[]): void {
	ensureServerDir();
	const registryPath = getNamespacesRegistryPath();
	const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(namespaces, null, 2));
	renameSync(tmpPath, registryPath);
}

let namespacesLockHeld = false;

/**
 * Run a namespaces.json read-modify-write cycle exclusively. create/deleteNamespace
 * (namespaces.ts) go through this so two overlapping requests in this single server
 * process can never interleave one's load with another's save and silently drop an
 * update. Synchronous by design: the critical section must stay fully synchronous
 * (no await) so it cannot yield to the event loop mid-update; this throws instead of
 * silently corrupting the registry if that invariant is ever broken.
 */
export function withNamespacesLock<T>(fn: () => T): T {
	if (namespacesLockHeld) {
		throw new Error("Namespaces registry is already being modified; concurrent write attempted");
	}
	namespacesLockHeld = true;
	try {
		return fn();
	} finally {
		namespacesLockHeld = false;
	}
}
