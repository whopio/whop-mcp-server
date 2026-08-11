export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type PrincipalType = "user" | "business" | "app";

export type SafetyClassification = "read_only" | "mutating" | "destructive";

export type IdempotencyPolicy = "none" | "supported" | "required";

/**
 * "native" operations are the hand-built REST surface (marked
 * x-whop-surface: native in the spec) — curated names, docs-aligned copy.
 * Everything else is the legacy GraphQL-proxy surface, retained in the
 * registry for parity but not exposed by default.
 */
export type OperationSurface = "native" | "legacy";

/**
 * The account-scoping parameters the runtime injects the bound business
 * into. parent_company_id is the same boundary under a different name (e.g.
 * POST /companies/{parent_company_id}/api_keys).
 */
export type AccountParam = "company_id" | "account_id" | "parent_company_id";

export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	nullable?: boolean;
	additionalProperties?: boolean | JsonSchema;
	description?: string;
	format?: string;
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	allOf?: JsonSchema[];
	[key: string]: unknown;
}

export interface OperationParameter {
	name: string;
	in: "path" | "query";
	required: boolean;
	schema: JsonSchema;
	description?: string;
}

export interface OperationSafety {
	classification: SafetyClassification;
	financial: boolean;
	credential: boolean;
	externalPublication: boolean;
	idempotency: IdempotencyPolicy;
	confirmationRequired: boolean;
}

export interface ToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface OperationDef {
	/** Stable public MCP tool name, e.g. "accounts_me". */
	toolName: string;
	/** The operationId as authored in the canonical OpenAPI contract. */
	openapiOperationId: string;
	method: HttpMethod;
	path: string;
	tag: string;
	/** CLI-style group derived from the tag, e.g. "ad-campaigns". */
	group: string;
	surface: OperationSurface;
	summary?: string;
	description?: string;
	parameters: OperationParameter[];
	hasRequestBody: boolean;
	bodyRequired: string[];
	/** Full dereferenced request-body schema (including oneOf variants) for dispatch-time validation. */
	bodySchema?: JsonSchema;
	/** Merged strict input schema across path, query, and body inputs. */
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
	/** The account parameter this operation accepts, if any. */
	accountParam: AccountParam | null;
	requiresAccount: boolean;
	principals: PrincipalType[];
	scopes: string[];
	safety: OperationSafety;
	annotations: ToolAnnotations;
	profiles: string[];
	/** Expected tag prefix per path parameter (e.g. { id: "pay" }), derived from spec examples. */
	idPrefixes?: Record<string, string>;
}

export interface ExclusionDef {
	/** "METHOD /path" key of the excluded operation. */
	operation: string;
	openapiOperationId: string;
	reason: string;
	owner: string;
}

/**
 * A write operation the spec exposes but no safety rule has classified yet.
 * It is NOT in the registry — it becomes a tool only after a human adds a
 * matching rule to metadata/safety.yml. Surfaced by `whop mcp doctor` and
 * the generator's --summary output.
 */
export interface PendingReviewDef {
	operation: string;
	openapiOperationId: string;
	tag: string;
	surface: OperationSurface;
}

export interface RegistryManifest {
	meta: {
		generatorVersion: string;
		/** Provenance of the spec this manifest was generated from (informational). */
		openapiSha256: string;
		apiVersionDate: string;
		operationCount: number;
		nativeOperationCount: number;
		exclusionCount: number;
		profiles: string[];
		pendingReview: PendingReviewDef[];
	};
	operations: OperationDef[];
	exclusions: ExclusionDef[];
}
