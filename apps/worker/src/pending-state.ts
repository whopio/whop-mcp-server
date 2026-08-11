const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function aesKey(secret: string): Promise<CryptoKey> {
	if (secret.length < 16) {
		throw new Error("State encryption key must be at least 16 characters.");
	}
	const material = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(secret),
	);
	return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

/**
 * AES-GCM seal for OAuth state parked in KV between redirects. A readable
 * codeVerifier would let whoever reads KV redeem a stolen authorization
 * code; the auth tag, with the caller's context string as AAD, stops
 * tampered or transplanted state from completing a grant.
 */
export async function sealJson(
	secret: string,
	value: unknown,
	context: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
		await aesKey(secret),
		encoder.encode(JSON.stringify(value)),
	);
	return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function openJson<T>(
	secret: string,
	sealed: string,
	context: string,
): Promise<T | null> {
	const [iv, ciphertext] = sealed.split(".");
	if (!iv || !ciphertext) return null;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fromBase64(iv),
				additionalData: encoder.encode(context),
			},
			await aesKey(secret),
			fromBase64(ciphertext),
		);
		return JSON.parse(decoder.decode(plaintext)) as T;
	} catch {
		return null;
	}
}
