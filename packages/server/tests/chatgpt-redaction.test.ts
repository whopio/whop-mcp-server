import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
	CHATGPT_API_KEY_OBJECTS,
	CHATGPT_HIDDEN_OUTPUTS,
	CHATGPT_RESTRICTED_FIELDS,
} from "../src/policy/chatgpt.ts";
import {
	operationInSurface,
	operationKey,
	type SurfaceName,
} from "../src/policy/surfaces.ts";
import type { PrincipalContext } from "../src/policy/types.ts";
import type { JsonSchema, OperationDef } from "../src/registry/types.ts";
import {
	CHATGPT_BUILTINS,
	chatgptOperations,
} from "../src/runtime/chatgpt-route.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const byKey = new Map(registry.operations.map((op) => [operationKey(op), op]));
const servedOps = registry.operations.filter((op) =>
	operationInSurface(op, "chatgpt"),
);
const signedInUser = principalFixture({
	principalType: "user",
	accountId: null,
});
const INTENT = {
	intent: "Update my profile",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};

async function connect(
	options: {
		surface?: SurfaceName;
		principal?: PrincipalContext;
		fetch?: typeof fetch;
	} = {},
) {
	const { server, operations } = createWhopMcpServer({
		registry,
		surface: options.surface ?? "chatgpt",
		credentialAdapter: staticCredential(),
		principal: options.principal ?? signedInUser,
		fetch: options.fetch ?? fakeFetch().fetch,
		baseUrl: "https://api.whop.test/api/v1",
		chatGptCompat: true,
		docs: true,
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return { client, operations };
}

function text(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0].text;
}

function parse(result: unknown): Record<string, unknown> {
	return JSON.parse(text(result));
}

function propertyNames(schema: JsonSchema | undefined): string[] {
	if (!schema || typeof schema !== "object") return [];
	return [
		...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
			name,
			...propertyNames(property),
		]),
		...(schema.required ?? []),
		...propertyNames(schema.items),
		...[
			...(schema.oneOf ?? []),
			...(schema.anyOf ?? []),
			...(schema.allOf ?? []),
		].flatMap(propertyNames),
		...(typeof schema.additionalProperties === "object"
			? propertyNames(schema.additionalProperties)
			: []),
	];
}

function requiredInputs(operation: OperationDef): string[] {
	return operation.inputSchema.required ?? [];
}

describe("ChatGPT company formation link", () => {
	const linkName = CHATGPT_BUILTINS.company_formation.name;
	const formationOp = byKey.get("POST /accounts/{id}/form_company")!;

	it("returns Whop's formation page without calling the API and keeps form_company off the route", async () => {
		expect(propertyNames(formationOp.inputSchema)).toContain("ssn");
		expect(operationInSurface(formationOp, "chatgpt")).toBe(false);
		expect(formationOp.verbName).not.toBe(linkName);

		const { fetch, requests } = fakeFetch();
		const { client } = await connect({ fetch });
		const tool = (await client.listTools()).tools.find(
			(t) => t.name === linkName,
		);
		expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
			"account_id",
		]);
		expect(tool?.inputSchema).toMatchObject({
			required: ["account_id"],
			additionalProperties: false,
		});
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			openWorldHint: false,
		});

		const result = await client.callTool({
			name: linkName,
			arguments: { account_id: "biz_abc123" },
		});
		expect(result.isError).toBeFalsy();
		expect(parse(result)).toEqual({
			url: "https://whop.com/form-company/biz_abc123",
			message:
				"The person completes company formation themselves on Whop at this link; nothing was filed or submitted from here.",
		});
		expect(requests).toHaveLength(0);
	});

	it("refuses founder details, malformed IDs and mismatched bound accounts", async () => {
		const { fetch, requests } = fakeFetch();
		const { client } = await connect({ fetch });
		for (const args of [
			{ account_id: "biz_abc123", founders: [{ ssn: "000-00-0000" }] },
			{ account_id: "user_abc123" },
			{ id: "biz_abc123" },
		]) {
			const result = await client.callTool({ name: linkName, arguments: args });
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(parse(result)).toMatchObject({ error: { code: "invalid_input" } });
			expect(text(result)).not.toContain("000-00-0000");
		}
		expect(requests).toHaveLength(0);

		const bound = await connect({ principal: principalFixture() });
		const other = await bound.client.callTool({
			name: linkName,
			arguments: { account_id: "biz_otherAccount" },
		});
		expect(parse(other)).toMatchObject({ error: { code: "account_mismatch" } });
		const own = await bound.client.callTool({
			name: linkName,
			arguments: { account_id: "biz_boundAccount" },
		});
		expect(parse(own).url).toBe(
			"https://whop.com/form-company/biz_boundAccount",
		);
	});
});

describe("ChatGPT restricted fields and secret stripping", () => {
	const restrictedInputs = servedOps.flatMap((op) =>
		Object.keys(op.inputSchema.properties ?? {})
			.filter((field) => CHATGPT_RESTRICTED_FIELDS.has(field))
			.map((field) => ({ opKey: operationKey(op), name: op.verbName, field })),
	);

	it("strips restricted fields from every inputSchema and bodySchema at any depth", async () => {
		const { client, operations } = await connect();
		for (const tool of (await client.listTools()).tools) {
			expect(
				propertyNames(tool.inputSchema as JsonSchema).filter((name) =>
					CHATGPT_RESTRICTED_FIELDS.has(name),
				),
				tool.name,
			).toEqual([]);
		}
		for (const op of operations) {
			expect(
				propertyNames(op.bodySchema).filter((name) =>
					CHATGPT_RESTRICTED_FIELDS.has(name),
				),
				op.verbName,
			).toEqual([]);
		}

		const synthetic: OperationDef = {
			...byKey.get("POST /domains")!,
			inputSchema: {
				type: "object",
				properties: {
					domain: { type: "string" },
					ssn: { type: "string" },
					registration: {
						type: "object",
						properties: {
							payment_method_id: { type: "string" },
							auto_renew: { type: "boolean" },
						},
						required: ["payment_method_id", "auto_renew"],
					},
				},
				required: ["domain", "ssn"],
				additionalProperties: {
					type: "object",
					properties: {
						date_of_birth: { type: "string" },
						note: { type: "string" },
					},
					required: ["date_of_birth"],
				},
			},
		};
		const [stripped] = chatgptOperations([synthetic]);
		expect(stripped.inputSchema.required).toEqual(["domain"]);
		expect(stripped.inputSchema.properties?.registration?.required).toEqual([
			"auto_renew",
		]);
		expect(propertyNames(stripped.inputSchema)).not.toContain("ssn");
		expect(propertyNames(stripped.inputSchema)).not.toContain("date_of_birth");
		expect(propertyNames(stripped.inputSchema)).not.toContain(
			"payment_method_id",
		);
	});

	it.each([
		["PATCH /accounts/{id}", "tax_identifiers"],
		["PATCH /users/{id}", "date_of_birth"],
		["PATCH /users/me", "date_of_birth"],
	])("removes %s's %s on ChatGPT only", async (opKey, field) => {
		const op = byKey.get(opKey)!;
		expect(op.inputSchema.properties).toHaveProperty(field);
		const { client } = await connect();
		const tool = (await client.listTools()).tools.find(
			(t) => t.name === op.verbName,
		);
		expect(tool?.inputSchema.properties).not.toHaveProperty(field);
	});

	it.each(restrictedInputs)(
		"rejects $field on $name without calling the API",
		async ({ name, field }) => {
			const { fetch, requests } = fakeFetch();
			const { client } = await connect({ fetch });
			const result = await client.callTool({
				name,
				arguments: { id: "biz_1", [field]: "restricted-value" },
			});
			expect(result.isError).toBe(true);
			expect(parse(result)).toMatchObject({ error: { code: "invalid_input" } });
			expect(text(result)).toContain(`${name} does not take ${field}`);
			expect(text(result)).not.toContain("restricted-value");
			expect(requests).toHaveLength(0);
		},
	);

	it("rejects nested restricted fields and still accepts them on other routes", async () => {
		const { fetch, requests } = fakeFetch();
		const { client, operations } = await connect({ fetch });
		const nested = await client.callTool({
			name: operations[0].verbName,
			arguments: { metadata: { owners: [{ ssn: "restricted-value" }] } },
		});
		expect(parse(nested)).toMatchObject({ error: { code: "invalid_input" } });
		expect(text(nested)).toContain("does not take ssn");
		expect(text(nested)).not.toContain("restricted-value");
		expect(requests).toHaveLength(0);

		for (const surface of ["full", "claude_directory"] as const) {
			const other = fakeFetch();
			const conn = await connect({ surface, fetch: other.fetch });
			const res = await conn.client.callTool({
				name: "update_current_user",
				arguments: { ...INTENT, date_of_birth: "1990-01-02" },
			});
			expect(res.isError, surface).toBeFalsy();
			expect(other.requests[0]?.body, surface).toEqual({
				date_of_birth: "1990-01-02",
			});
		}
	});

	const record = {
		id: "prod_1",
		title: "Acme",
		token: "page-cursor",
		preview_token: "hidden-preview-token",
		tax_identifiers: [{ tax_id_type: "us_ein", tax_id_value: "00-0000001" }],
		owner: {
			name: "Sam",
			date_of_birth: "1990-01-02",
			ssn: "000-00-0000",
			tax_id_value: "00-0000002",
		},
		payments: [
			{
				client_secret: "hidden-client-secret",
				card: { brand: "visa", last4: "4242", exp_month: 11, exp_year: 2031 },
			},
		],
		api_key: { id: "key_1", token: "hidden-api-key-token" },
		default_api_key: {
			id: "key_2",
			token: "hidden-default-key-token",
			secret_key: "hidden-secret-key",
			obfuscated_secret_key: "sk_****",
		},
	};
	const shown = {
		id: "prod_1",
		title: "Acme",
		token: "page-cursor",
		owner: { name: "Sam" },
		payments: [{ card: { brand: "visa", last4: "4242" } }],
		api_key: { id: "key_1" },
		default_api_key: { id: "key_2", obfuscated_secret_key: "sk_****" },
	};
	const recordFetch = () =>
		fakeFetch((request) => ({
			body: new URL(request.url).pathname.endsWith("_1")
				? record
				: { data: [record] },
		}));

	it("strips restricted fields and secrets from reads, search and fetch on ChatGPT only", async () => {
		const { client, operations } = await connect({
			fetch: recordFetch().fetch,
		});
		const byId = operations.find(
			(op) => op.method === "get" && requiredInputs(op).join() === "id",
		)!;
		const list = operations.find(
			(op) =>
				op.method === "get" &&
				requiredInputs(op).length === 0 &&
				!op.requiresAccount,
		)!;

		expect(
			parse(
				await client.callTool({
					name: byId.verbName,
					arguments: { id: "prod_1" },
				}),
			),
		).toEqual(shown);
		expect(
			parse(await client.callTool({ name: list.verbName, arguments: {} })),
		).toEqual({ data: [shown] });

		const fetched = parse(
			await client.callTool({ name: "fetch", arguments: { id: "prod_1" } }),
		);
		expect(JSON.parse(fetched.text as string)).toEqual(shown);

		const found = await client.callTool({
			name: "search",
			arguments: { query: "acme" },
		});
		expect((parse(found).results as unknown[]).length).toBeGreaterThan(0);
		for (const field of CHATGPT_RESTRICTED_FIELDS) {
			expect(text(found)).not.toContain(field);
		}

		for (const surface of ["full", "claude_directory"] as const) {
			const other = await connect({ surface, fetch: recordFetch().fetch });
			expect(
				parse(
					await other.client.callTool({
						name: "get_product",
						arguments: { ...INTENT, id: "prod_1" },
					}),
				),
				surface,
			).toEqual(record);
		}
	});

	it("declares no output-only secret name in any served input schema", () => {
		const outputOnly = [
			...CHATGPT_HIDDEN_OUTPUTS,
			...CHATGPT_API_KEY_OBJECTS,
			"token",
		];
		expect(
			servedOps.flatMap((op) =>
				propertyNames(op.inputSchema)
					.filter((name) => outputOnly.includes(name))
					.map((name) => `${op.verbName} ${name}`),
			),
		).toEqual([]);
	});
});

describe("ChatGPT domain purchases", () => {
	const DOMAIN_OPERATIONS = ["POST /domains", "PATCH /domains/{id}"];
	const validArgs = (opKey: string) =>
		opKey.startsWith("POST") ? { domain: "example.com" } : { id: "dom_1" };

	it.each(DOMAIN_OPERATIONS)(
		"removes registration.payment_method_id from %s schema and rejects it before dispatch",
		async (opKey) => {
			const op = byKey.get(opKey)!;
			const upstream = op.inputSchema.properties?.registration?.properties;
			expect(upstream).toHaveProperty("payment_method_id");

			const { fetch, requests } = fakeFetch();
			const { client, operations } = await connect({ fetch });
			const tool = (await client.listTools()).tools.find(
				(t) => t.name === op.verbName,
			);
			const registration = (
				tool?.inputSchema.properties as Record<string, JsonSchema> | undefined
			)?.registration;
			expect(Object.keys(registration?.properties ?? {}).sort()).toEqual(
				Object.keys(upstream ?? {})
					.filter((name) => name !== "payment_method_id")
					.sort(),
			);
			const served = operations.find((o) => operationKey(o) === opKey)!;
			expect(propertyNames(served.bodySchema)).not.toContain(
				"payment_method_id",
			);

			for (const card of ["payt_savedcard1", null]) {
				const blocked = await client.callTool({
					name: op.verbName,
					arguments: {
						...validArgs(opKey),
						registration: { payment_method_id: card },
					},
				});
				expect(blocked.isError).toBe(true);
				expect(parse(blocked)).toMatchObject({
					error: { code: "invalid_input" },
				});
				expect(text(blocked)).toContain(
					`${op.verbName} does not take registration.payment_method_id`,
				);
				expect(text(blocked)).toContain("registration.purchase_url");
				expect(text(blocked)).not.toContain("payt_savedcard1");
			}
			expect(requests).toHaveLength(0);

			const allowed = await client.callTool({
				name: op.verbName,
				arguments: { ...validArgs(opKey), registration: { auto_renew: false } },
			});
			expect(allowed.isError).toBeFalsy();
			expect(requests).toHaveLength(1);
			expect(requests[0].body).toMatchObject({
				registration: { auto_renew: false },
			});

			const fullFetch = fakeFetch();
			const full = await connect({ surface: "full", fetch: fullFetch.fetch });
			const onFull = await full.client.callTool({
				name: op.verbName,
				arguments: {
					...INTENT,
					...validArgs(opKey),
					registration: { payment_method_id: "payt_savedcard1" },
				},
			});
			expect(onFull.isError).toBeFalsy();
			expect(fullFetch.requests[0]?.body).toMatchObject({
				registration: { payment_method_id: "payt_savedcard1" },
			});
		},
	);
});
