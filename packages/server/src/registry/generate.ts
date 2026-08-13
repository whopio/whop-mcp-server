import { PROFILE_NAMES, profilesForSafety } from "../policy/profiles.ts";
import type {
	AccountParam,
	ExclusionDef,
	HttpMethod,
	JsonSchema,
	OperationDef,
	OperationParameter,
	OperationSafety,
	OperationSurface,
	PendingReviewDef,
	PrincipalType,
	RegistryManifest,
	SafetyClassification,
} from "./types.ts";

export const GENERATOR_VERSION = "2.2.0";

const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

const ACCOUNT_PARAMS: readonly AccountParam[] = [
	"company_id",
	"account_id",
	"parent_company_id",
];

const STRIPPED_PARAMETERS = new Set(["authorization", "api-version-date"]);

/**
 * Kept identical to the public CLI's sync-spec.ts so the tool names this
 * registry produces stay identical to the CLI surface that is already public.
 * Do not change an entry here without a documented alias or migration window.
 * Entries whose path only exists in the native-filtered spec are harmless
 * lookups here; they exist for naming parity.
 */
const OP_ID_OVERRIDES: Record<string, string> = {
	"GET /swaps": "status",
	// Root-collection GET infers "list", which GET /partners/businesses claims in the Referrals tag.
	"GET /partners/businesses": "list",
	"GET /partners/businesses/{id}": "get",
	"GET /partners/businesses/{id}/earnings": "earnings",
	"GET /workforce/bounties": "list",
	"GET /workforce/bounties/{id}": "get",
	// Root-collection GET infers "list", which GET /financial-activity already claims in the Ledgers tag.
	"GET /financial_reports": "report",
	// Root-collection GET infers "list", which GET /cards already claims in the Cards tag.
	"GET /card_transactions": "transactions",
	"GET /card_transactions/{id}": "get-transaction",
	// GET and PATCH both infer "preferences" from the static path segment.
	"GET /accounts/{account_id}/preferences": "preferences",
	"PATCH /accounts/{account_id}/preferences": "update-preferences",
	"GET /users/me/preferences": "preferences",
	"PATCH /users/me/preferences": "update-preferences",
	"PATCH /users/me/preferences/notifications": "set-notification-preferences",
	"GET /users/me/preferences/notifications/topics":
		"notification-topic-preferences",
	"GET /users/me/preferences/notifications/experiences":
		"experience-notification-preferences",
	"GET /payouts/supported_methods": "supported-methods",
	"GET /permissions": "check",
	// GET and PATCH both infer "me" from the static path segment.
	"GET /users/me": "me",
	"PATCH /users/me": "update-me",
	// All four infer "me-passkeys" — the {id} segment is filtered out.
	"GET /users/me/passkeys": "passkeys",
	"POST /users/me/passkeys": "register-passkey",
	"DELETE /users/me/passkeys/{id}": "delete-passkey",
	"POST /users/me/passkeys/challenge": "passkey-challenge",
	// The verb methods all infer "methods" from the static path segment.
	"GET /payouts/methods": "methods",
	"POST /payouts/methods": "create-method",
	"PATCH /payouts/methods/{payout_method_id}": "update-method",
	"DELETE /payouts/methods/{payout_method_id}": "delete-method",
	// Not part of the pre-existing CLI surface; named here to avoid collisions
	// between methods sharing a static path segment.
	"GET /affiliates/{id}/overrides": "list-overrides",
	"POST /affiliates/{id}/overrides": "create-override",
	"PATCH /affiliates/{id}/overrides/{override_id}": "update-override",
	"DELETE /affiliates/{id}/overrides/{override_id}": "delete-override",
};

const SEND_PATH = "/wallets/send";
const SEND_TAG = "Sends";

export function inferOperationName(method: string, path: string): string {
	const key = `${method.toUpperCase()} ${path}`;
	if (OP_ID_OVERRIDES[key]) return OP_ID_OVERRIDES[key];

	const segments = path.split("/").filter(Boolean);
	const actions = segments.slice(1).filter((s) => !s.startsWith("{"));
	if (actions.length > 0) return actions.join("-");

	const last = segments[segments.length - 1] ?? "";
	const isItem = last.startsWith("{");
	const m = method.toUpperCase();

	if (isItem) {
		if (m === "GET") return "get";
		if (m === "PATCH" || m === "PUT") return "update";
		if (m === "DELETE") return "delete";
	}
	if (m === "GET") return "list";
	if (m === "POST") return "create";
	if (m === "PATCH") return "update";
	if (m === "DELETE") return "delete";
	return method.toLowerCase();
}

export function groupNameForTag(tag: string): string {
	return tag.toLowerCase().replace(/\s+/g, "-");
}

export interface SafetyRule {
	name: string;
	match: {
		operations?: string[];
		tags?: string[];
		methods?: string[];
	};
	set: {
		classification?: SafetyClassification;
		financial?: boolean;
		credential?: boolean;
		externalPublication?: boolean;
		idempotency?: "none" | "supported" | "required";
		confirmation?: boolean;
	};
}

export interface OperationOverride {
	description?: string;
	principals?: PrincipalType[];
	requiresAccount?: boolean;
}

export interface ScopeDefinition {
	user?: boolean;
	bot?: boolean;
	disallow_api_authorization?: boolean;
	disallow_app_authorization?: boolean;
}

export interface GeneratorMetadata {
	safety: { rules: SafetyRule[] };
	exclusions: {
		exclusions: { operation: string; reason: string; owner: string }[];
	};
	overrides: { overrides: Record<string, OperationOverride> };
	/**
	 * The configured scope capabilities record which credential kinds can hold
	 * each scope. Principals are derived from them so tools a connection can
	 * never successfully call are not offered to it (e.g.
	 * developer:manage_api_key is user: false — a hosted OAuth grant gets a
	 * guaranteed 403).
	 */
	scopeDefinitions: Record<string, ScopeDefinition>;
}

/**
 * Mirrors the backend's PermissionActionMetadata predicates: allowed_on_user,
 * allowed_on_api_key (business), allowed_on_app. OpenAPI security is a list
 * of alternatives (OR), each requiring all of its scopes (AND) — a principal
 * is supported when it can hold every scope of at least one alternative. An
 * alternative with no scopes admits every principal.
 */
function principalsForSecurity(
	alternatives: string[][],
	definitions: Record<string, ScopeDefinition>,
	key: string,
): PrincipalType[] {
	const holdable = (scope: string, principal: PrincipalType): boolean => {
		const definition = definitions[scope];
		if (!definition) {
			fail(`No scope definition for scope "${scope}" on ${key}.`);
		}
		if (principal === "user") return definition.user === true;
		if (principal === "business") {
			return (
				definition.bot === true &&
				definition.disallow_api_authorization !== true
			);
		}
		return (
			definition.bot === true && definition.disallow_app_authorization !== true
		);
	};
	return (["user", "business", "app"] as const).filter((principal) =>
		alternatives.some((scopes) =>
			scopes.every((scope) => holdable(scope, principal)),
		),
	);
}

type OpenApiDocument = {
	info?: Record<string, unknown>;
	paths: Record<string, Record<string, unknown>>;
	components?: { schemas?: Record<string, unknown> };
};

class RegistryError extends Error {}

function fail(message: string): never {
	throw new RegistryError(message);
}

function dereference(
	node: unknown,
	doc: OpenApiDocument,
	seen: Set<string>,
): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => dereference(item, doc, seen));
	}
	if (node === null || typeof node !== "object") return node;

	const obj = node as Record<string, unknown>;
	const ref = obj.$ref;
	if (typeof ref === "string") {
		if (seen.has(ref)) {
			return { description: `Recursive reference to ${ref}` };
		}
		const target = resolveRef(ref, doc);
		return dereference(target, doc, new Set([...seen, ref]));
	}

	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		out[key] = dereference(obj[key], doc, seen);
	}
	return out;
}

function resolveRef(ref: string, doc: OpenApiDocument): unknown {
	if (!ref.startsWith("#/")) fail(`Unsupported external $ref: ${ref}`);
	let node: unknown = doc;
	for (const segment of ref.slice(2).split("/")) {
		if (node === null || typeof node !== "object") {
			fail(`Unresolvable $ref: ${ref}`);
		}
		node = (node as Record<string, unknown>)[
			segment.replace(/~1/g, "/").replace(/~0/g, "~")
		];
	}
	if (node === undefined) fail(`Unresolvable $ref: ${ref}`);
	return node;
}

/**
 * Extracts an expected ID prefix (e.g. "biz" from example "biz_xxxxxxxxxxxxx")
 * so the dispatcher can reject obviously mistyped or cross-resource IDs.
 */
function idPrefixFromExample(schema: JsonSchema): string | null {
	const example = schema.example;
	if (typeof example !== "string") return null;
	const match = /^([a-zA-Z]+)_x{6,}$/.exec(example);
	return match ? match[1] : null;
}

function sortKeys<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map(sortKeys) as T;
	}
	if (value === null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) {
		out[key] = sortKeys(obj[key]);
	}
	return out as T;
}

interface RawOperation {
	method: HttpMethod;
	path: string;
	op: Record<string, unknown>;
	/** Path-item-level parameters, hoisted into every operation on the path. */
	pathItemParameters: unknown[];
	surface: OperationSurface;
}

function collectOperations(doc: OpenApiDocument): RawOperation[] {
	const out: RawOperation[] = [];
	for (const path of Object.keys(doc.paths).sort()) {
		const item = doc.paths[path];
		const pathItemParameters = Array.isArray(item.parameters)
			? (item.parameters as unknown[])
			: [];
		for (const method of HTTP_METHODS) {
			const op = item[method];
			if (op && typeof op === "object") {
				const opRecord = op as Record<string, unknown>;
				const surface: OperationSurface =
					opRecord["x-whop-surface"] === "native" ||
					item["x-whop-surface"] === "native"
						? "native"
						: "legacy";
				out.push({ method, path, op: opRecord, pathItemParameters, surface });
			}
		}
	}
	return out;
}

function operationTag(
	op: Record<string, unknown>,
	path: string,
): string | null {
	if (path === SEND_PATH) return SEND_TAG;
	const tags = op.tags as string[] | undefined;
	return Array.isArray(tags) && tags.length > 0 ? tags[0] : null;
}

function operationKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${path}`;
}

function matchesRule(
	rule: SafetyRule,
	key: string,
	tag: string,
	method: HttpMethod,
): boolean {
	const { operations, tags, methods } = rule.match;
	if (operations && !operations.includes(key)) return false;
	if (tags && !tags.includes(tag)) return false;
	if (methods && !methods.includes(method)) return false;
	return Boolean(operations || tags || methods);
}

/**
 * Returns null for a non-GET operation no rule matches. The caller drops the
 * operation into meta.pendingReview instead of the registry: an unclassified
 * write is never exposed as a tool.
 */
function classifySafety(
	key: string,
	tag: string,
	method: HttpMethod,
	rules: SafetyRule[],
): OperationSafety | null {
	if (method === "get") {
		return {
			classification: "read_only",
			financial: false,
			credential: false,
			externalPublication: false,
			idempotency: "none",
			confirmationRequired: false,
		};
	}

	for (const rule of rules) {
		if (!matchesRule(rule, key, tag, method)) continue;
		return {
			classification: rule.set.classification ?? "mutating",
			financial: rule.set.financial ?? false,
			credential: rule.set.credential ?? false,
			externalPublication: rule.set.externalPublication ?? false,
			idempotency: rule.set.idempotency ?? "none",
			confirmationRequired: rule.set.confirmation ?? false,
		};
	}

	return null;
}

interface BodyShape {
	present: boolean;
	required: string[];
	/** Properties required in EVERY variant of a union body. */
	requiredInAllVariants: string[];
	properties: Record<string, JsonSchema>;
	schema: JsonSchema | null;
}

function extractBody(
	op: Record<string, unknown>,
	doc: OpenApiDocument,
	key: string,
): BodyShape {
	const requestBody = op.requestBody as
		| { content?: Record<string, { schema?: unknown }> }
		| undefined;
	const jsonSchema = requestBody?.content?.["application/json"]?.schema;
	if (!jsonSchema) {
		return {
			present: false,
			required: [],
			requiredInAllVariants: [],
			properties: {},
			schema: null,
		};
	}

	const schema = dereference(jsonSchema, doc, new Set()) as JsonSchema;
	const variants = schema.oneOf ?? schema.anyOf ?? [schema];
	if (!Array.isArray(variants) || variants.length === 0) {
		fail(`Unsupported request body shape for ${key}`);
	}

	const properties: Record<string, JsonSchema> = {};
	for (const variant of variants) {
		if (variant.type && variant.type !== "object") {
			fail(`Non-object request body for ${key}`);
		}
		for (const [name, propSchema] of Object.entries(variant.properties ?? {})) {
			properties[name] ??= propSchema;
		}
	}

	// Body-level required only holds for a single-variant body; with a oneOf
	// union the per-variant requirements are enforced at dispatch time via the
	// full bodySchema.
	const required =
		variants.length === 1 ? ((variants[0].required as string[]) ?? []) : [];

	const requiredInAllVariants = (
		(variants[0].required as string[]) ?? []
	).filter((name) =>
		variants.every((variant) =>
			((variant.required as string[]) ?? []).includes(name),
		),
	);

	return {
		present: true,
		required,
		requiredInAllVariants,
		properties,
		schema,
	};
}

function buildOperation(
	raw: RawOperation,
	doc: OpenApiDocument,
	metadata: GeneratorMetadata,
	safety: OperationSafety,
): OperationDef {
	const { method, path } = raw;
	const key = operationKey(method, path);
	const op = raw.op;

	const openapiOperationId = op.operationId;
	if (typeof openapiOperationId !== "string" || !openapiOperationId) {
		fail(`Missing operationId for ${key}`);
	}

	const tag = operationTag(op, path);
	if (!tag) fail(`Missing tag for ${key}`);

	const group = groupNameForTag(tag);
	const toolName = `${group}_${inferOperationName(method, path)}`;

	const rawParams = [
		...raw.pathItemParameters,
		...((op.parameters ?? []) as unknown[]),
	];
	const parameters: OperationParameter[] = [];
	for (const rawParam of rawParams) {
		const param = dereference(rawParam, doc, new Set()) as {
			name?: string;
			in?: string;
			required?: boolean;
			schema?: JsonSchema;
			description?: string;
		};
		if (!param.name || !param.in) fail(`Malformed parameter on ${key}`);
		if (STRIPPED_PARAMETERS.has(param.name.toLowerCase())) continue;
		if (param.in === "header") continue;
		if (param.in !== "path" && param.in !== "query") {
			fail(`Unsupported parameter location "${param.in}" on ${key}`);
		}
		parameters.push({
			name: param.name,
			in: param.in,
			required: Boolean(param.required),
			schema: param.schema ?? { type: "string" },
			description: param.description,
		});
	}

	const body = extractBody(op, doc, key);

	const accountParam =
		ACCOUNT_PARAMS.find(
			(name) =>
				parameters.some((p) => p.name === name) || name in body.properties,
		) ?? null;

	const accountParamRequired = accountParam
		? parameters.some((p) => p.name === accountParam && p.required) ||
			body.required.includes(accountParam) ||
			body.requiredInAllVariants.includes(accountParam)
		: false;

	const override = metadata.overrides.overrides[key];

	const properties: Record<string, JsonSchema> = {};
	const required = new Set<string>();
	for (const param of parameters) {
		properties[param.name] = {
			...param.schema,
			...(param.description ? { description: param.description } : {}),
		};
		if (param.required) required.add(param.name);
	}
	for (const [name, schema] of Object.entries(body.properties)) {
		properties[name] ??= schema;
	}
	for (const name of body.required) required.add(name);
	// The dispatcher injects the bound account, so the model never has to
	// (and never gets to) choose one.
	if (accountParam) required.delete(accountParam);

	const inputSchema: JsonSchema = {
		type: "object",
		properties: sortKeys(properties),
		required: [...required].sort(),
		additionalProperties: false,
	};

	const idPrefixes: Record<string, string> = {};
	for (const param of parameters) {
		if (param.in !== "path") continue;
		const prefix = idPrefixFromExample(param.schema);
		if (prefix) idPrefixes[param.name] = prefix;
	}

	const security = op.security as { bearerAuth?: string[] }[] | undefined;
	// Missing or empty security means the endpoint takes no scopes at all.
	const alternatives =
		security && security.length > 0
			? security.map((alternative) => [...(alternative.bearerAuth ?? [])])
			: [[]];
	const scopeAlternatives = alternatives.map((alternative) =>
		[...new Set(alternative)].sort(),
	);
	// The flat union is kept for scope requesting (profile-scopes.ts) and display.
	const scopes = [...new Set(alternatives.flat())].sort();

	const scopePrincipals = principalsForSecurity(
		alternatives,
		metadata.scopeDefinitions,
		key,
	);
	// An override may narrow the scope-derived set but never widen it — the
	// backend would 403 the widened principal anyway.
	const principals = (override?.principals ?? scopePrincipals).filter((p) =>
		scopePrincipals.includes(p),
	);

	const description =
		override?.description ??
		(typeof op.description === "string" ? op.description : undefined);

	return sortKeys({
		toolName,
		openapiOperationId,
		method,
		path,
		tag,
		group,
		surface: raw.surface,
		summary: typeof op.summary === "string" ? op.summary : undefined,
		description,
		parameters,
		hasRequestBody: body.present,
		bodyRequired: [...body.required].sort(),
		...(body.schema ? { bodySchema: body.schema } : {}),
		inputSchema,
		accountParam,
		requiresAccount: override?.requiresAccount ?? accountParamRequired,
		principals,
		scopeAlternatives,
		scopes,
		safety,
		annotations: {
			readOnlyHint: safety.classification === "read_only",
			// Hosts key their don't-auto-approve behavior on destructiveHint, so
			// every confirmation-gated operation (money movement, credentials,
			// consequential actions) must carry it — not just deletes. Without
			// it a local host may auto-approve a withdrawal, and on the hosted
			// path a model could silently echo back its own confirmation token.
			destructiveHint:
				safety.classification === "destructive" ||
				safety.confirmationRequired ||
				safety.financial ||
				safety.credential,
			idempotentHint:
				safety.classification === "read_only" ||
				safety.idempotency === "required" ||
				method === "delete" ||
				method === "put",
			openWorldHint: safety.externalPublication,
		},
		profiles: profilesForSafety(safety),
		...(Object.keys(idPrefixes).length > 0 ? { idPrefixes } : {}),
	}) as OperationDef;
}

export function buildRegistry(
	doc: OpenApiDocument,
	metadata: GeneratorMetadata,
	inputs: { openapiSha256: string },
): RegistryManifest {
	const apiVersionDate = doc.info?.["x-api-version-date"];
	if (typeof apiVersionDate !== "string" || !apiVersionDate) {
		fail(
			"OpenAPI contract is missing info.x-api-version-date — the registry cannot pin an API version.",
		);
	}

	const rawOperations = collectOperations(doc);
	const allKeys = new Set(
		rawOperations.map((raw) => operationKey(raw.method, raw.path)),
	);

	for (const entry of metadata.exclusions.exclusions) {
		if (!allKeys.has(entry.operation)) {
			fail(
				`exclusions.yml entry "${entry.operation}" matches no operation in the OpenAPI contract.`,
			);
		}
		if (!entry.reason || !entry.owner) {
			fail(`exclusions.yml entry "${entry.operation}" needs reason and owner.`);
		}
	}
	for (const key of Object.keys(metadata.overrides.overrides)) {
		if (!allKeys.has(key)) {
			fail(
				`operation-overrides.yml entry "${key}" matches no operation in the OpenAPI contract.`,
			);
		}
	}
	for (const rule of metadata.safety.rules) {
		for (const key of rule.match.operations ?? []) {
			if (!allKeys.has(key)) {
				fail(
					`safety.yml rule "${rule.name}" references unknown operation "${key}".`,
				);
			}
		}
	}

	const excluded = new Map(
		metadata.exclusions.exclusions.map((entry) => [entry.operation, entry]),
	);

	const operations: OperationDef[] = [];
	const exclusions: ExclusionDef[] = [];
	const pendingReview: PendingReviewDef[] = [];
	const seenToolNames = new Map<string, string>();

	for (const raw of rawOperations) {
		const key = operationKey(raw.method, raw.path);
		const opId = raw.op.operationId;
		const exclusion = excluded.get(key);
		if (exclusion) {
			exclusions.push({
				operation: key,
				openapiOperationId: typeof opId === "string" ? opId : "",
				reason: exclusion.reason,
				owner: exclusion.owner,
			});
			continue;
		}

		const tag = operationTag(raw.op, raw.path);
		if (!tag) fail(`Missing tag for ${key}`);

		const safety = classifySafety(key, tag, raw.method, metadata.safety.rules);
		if (!safety) {
			pendingReview.push({
				operation: key,
				openapiOperationId: typeof opId === "string" ? opId : "",
				tag,
				surface: raw.surface,
			});
			continue;
		}

		const operation = buildOperation(raw, doc, metadata, safety);
		if (operation.principals.length === 0) {
			// e.g. developer:manage_api_key is user: false with both API-key
			// authorizations disallowed — only interactive dashboard sessions
			// qualify, which no MCP connection is.
			exclusions.push({
				operation: key,
				openapiOperationId: typeof opId === "string" ? opId : "",
				reason: `No MCP principal can hold the required scope(s) ${operation.scopes.join(", ")} per the configured scope definitions.`,
				owner: "registry-generator",
			});
			continue;
		}
		const previous = seenToolNames.get(operation.toolName);
		if (previous) {
			fail(
				`Duplicate tool name "${operation.toolName}" from ${previous} and ${key}. Add an OP_ID_OVERRIDES entry or exclude the legacy duplicate.`,
			);
		}
		seenToolNames.set(operation.toolName, key);
		operations.push(operation);
	}

	// Code-point comparison, not localeCompare: ICU collation varies with the
	// host locale (macOS vs CI runners disagree on "-"), and the manifest
	// should be byte-identical for a given spec regardless of build host.
	operations.sort((a, b) =>
		a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0,
	);
	exclusions.sort((a, b) =>
		a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0,
	);
	pendingReview.sort((a, b) =>
		a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0,
	);

	return {
		meta: {
			generatorVersion: GENERATOR_VERSION,
			openapiSha256: inputs.openapiSha256,
			apiVersionDate,
			operationCount: operations.length,
			nativeOperationCount: operations.filter((o) => o.surface === "native")
				.length,
			exclusionCount: exclusions.length,
			profiles: [...PROFILE_NAMES],
			pendingReview,
		},
		operations,
		exclusions,
	};
}
