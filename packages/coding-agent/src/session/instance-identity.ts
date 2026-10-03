/** X2 owner launch identity. startKey is corroboration; authority is sandboxId + generation. */
export interface InstanceIdentity {
	sandboxId: string;
	generation: string;
	startKey: string;
}

export interface IncompleteReason {
	category: string;
	text: string;
	issuer: InstanceIdentity | null;
}

export function instanceIdentity(value: unknown): InstanceIdentity | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some(key => !["sandboxId", "generation", "startKey"].includes(key))) return null;
	if (typeof v.sandboxId !== "string" || Buffer.byteLength(v.sandboxId) > 128) return null;
	if (typeof v.generation !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v.generation)) return null;
	if (BigInt(v.generation) > 18446744073709551615n) return null;
	if (typeof v.startKey !== "string" || Buffer.byteLength(v.startKey) > 128) return null;
	if (Buffer.byteLength(JSON.stringify(v)) > 512) return null;
	return {
		sandboxId: v.sandboxId,
		generation: v.generation,
		startKey: v.startKey,
	};
}

export function instanceKey(value: InstanceIdentity | null | undefined): string {
	return value ? JSON.stringify([value.sandboxId, value.generation]) : "null";
}

/** Provenance dedupe must not erase contradictory corroboration. */
export function issuerKey(value: InstanceIdentity | null | undefined): string {
	return value ? JSON.stringify([value.sandboxId, value.generation, value.startKey ?? null]) : "null";
}

/** A contradictory corroboration is conflicting provenance, not another incarnation. */
export function sameInstance(a: InstanceIdentity | null | undefined, b: InstanceIdentity | null | undefined): boolean {
	return (
		!!a &&
		!!b &&
		typeof a.startKey === "string" &&
		a.sandboxId === b.sandboxId &&
		a.generation === b.generation &&
		a.startKey === b.startKey
	);
}

export function parseInstanceValue(text: string): InstanceIdentity {
	if (Buffer.byteLength(text) > 512) throw new Error("instance exceeds 512 bytes");
	const value = instanceIdentity(JSON.parse(text));
	if (!value) throw new Error("invalid instance schema");
	return value;
}

export function parseExtinctValue(text: string): InstanceIdentity[] {
	if (Buffer.byteLength(text) > 40 * 1024) throw new Error("extinct list exceeds 40 KiB");
	const values: unknown = JSON.parse(text);
	if (!Array.isArray(values) || values.length > 64) throw new Error("invalid extinct list");
	const seen = new Set<string>();
	return values.map(value => {
		const identity = instanceIdentity(value);
		if (!identity || seen.has(instanceKey(identity))) throw new Error("invalid or duplicate extinct instance");
		seen.add(instanceKey(identity));
		return identity;
	});
}

const fenceable: Record<string, true> = {
	"owner-marker": true,
	"pty-untracked": true,
	"debug-untracked": true,
	"eval-untracked": true,
	"bash-background-uncounted": true,
	"service-identity-unknown": true,
	"scan-unsound": true,
	"foreign-invocation-unobservable": true,
	"open-record-unended": true,
	"shell-backend-unreported": true,
};

export function canFence(
	category: string,
	issuer: InstanceIdentity | null | undefined,
	extinct: readonly InstanceIdentity[],
): boolean {
	return Object.hasOwn(fenceable, category) && extinct.some(value => sameInstance(issuer, value));
}

/** Legacy strings have no issuing provenance and can never be fenced. */
export function incompleteReason(value: unknown): IncompleteReason {
	if (typeof value === "string") return { category: "reason-malformed", text: value, issuer: null };
	if (typeof value !== "object" || value === null)
		return { category: "reason-malformed", text: "incomplete", issuer: null };
	const v = value as Record<string, unknown>;
	if (typeof v.category !== "string" || typeof v.text !== "string")
		return { category: "reason-malformed", text: "incomplete", issuer: null };
	return { category: v.category, text: v.text, issuer: instanceIdentity(v.issuer) };
}

export function reasonKey(reason: IncompleteReason): string {
	return JSON.stringify([reason.category, reason.text, issuerKey(reason.issuer)]);
}
