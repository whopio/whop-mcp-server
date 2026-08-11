const WHOP_LOGO_PATH =
	"M27.1309 8.31348C28.6407 8.31348 30.1822 9.43651 31 10.5625H30.9864L19.1729 22.375C17.4239 24.124 14.5605 24.124 12.8116 22.375L11.6817 21.2441L22.3614 10.5625C22.3761 10.5433 22.7583 10.1702 22.7715 10.1572C23.8 9.17896 25.1594 8.31355 27.1309 8.31348ZM16.4356 8.31348C17.9454 8.31348 19.4869 9.43651 20.3047 10.5625L10.6534 20.2148L6.34087 15.9023L11.6797 10.5625C11.6967 10.5404 12.0648 10.1688 12.0762 10.1572C13.1047 9.17893 14.464 8.3135 16.4356 8.31348ZM5.76958 8.31348C7.27863 8.31352 8.82085 9.43653 9.63872 10.5625L5.31939 14.8818L1.00005 10.5625C0.994867 10.5507 1.40013 10.1668 1.41021 10.1572C2.43874 9.17892 3.79797 8.31348 5.76958 8.31348Z";

export function whopLogoSvg(size: number): string {
	return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="${WHOP_LOGO_PATH}" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>`;
}

function patternTile(fill: string, opacity: string): string {
	const svg =
		`<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>` +
		`<defs><path id='w' d='${WHOP_LOGO_PATH}'/></defs>` +
		`<use href='#w' fill='${fill}' fill-opacity='${opacity}' transform='translate(22 36) scale(1.9)'/>` +
		`<use href='#w' fill='${fill}' fill-opacity='${opacity}' transform='translate(142 156) scale(1.9)'/>` +
		`</svg>`;
	const encoded = svg
		.replaceAll("#", "%23")
		.replaceAll("<", "%3C")
		.replaceAll(">", "%3E");
	return `url("data:image/svg+xml,${encoded}")`;
}

const STYLES = `
:root{
--bg:#fff;--card:#f9f9f9;
--stroke:#0000001f;
--ink:#202020;--muted:#0000009b;
--accent-ring:#0052ec81;
--pattern:${patternTile("#dfdfe0", "1")};
--fade:radial-gradient(ellipse farthest-corner at 50% 50%,var(--bg) 0%,transparent 100%)
}
@media(prefers-color-scheme:dark){:root{
--bg:#111;--card:#191919;
--stroke:#ffffff22;
--ink:#eee;--muted:#ffffffaf;
--accent-ring:#407effb4;
--pattern:${patternTile("#ffffff", ".06")};
--fade:radial-gradient(ellipse farthest-corner at 50% 50%,var(--bg) 70%,transparent 100%)
}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
background-color:var(--bg);background-image:var(--fade),var(--pattern);
color:var(--ink);font:400 14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",system-ui,sans-serif;
-webkit-font-smoothing:antialiased;letter-spacing:.000625em}
.card{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--stroke);border-radius:16px;overflow:hidden;box-shadow:0 1px 2px #0000000d}
.pane{padding:24px}
.pane .brand{margin-bottom:16px}
.brand{display:flex;align-items:center;flex-shrink:0;color:var(--ink)}
.brand svg{display:block}
h1{margin:0 0 8px;font-size:17px;font-weight:600;letter-spacing:-.01125em;line-height:1.3}
p{margin:0 0 8px;color:var(--muted)}
p:last-child{margin-bottom:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;letter-spacing:.01em;overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// `img-src data:` admits only the inline backdrop tile; all fetches stay blocked.
const CONTENT_SECURITY_POLICY =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function htmlResponse(body: string, status = 200): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect Whop</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLES}</style></head><body><main class="card">${body}</main></body></html>`,
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				"Content-Security-Policy": CONTENT_SECURITY_POLICY,
				"Content-Type": "text/html; charset=utf-8",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
			},
		},
	);
}

export function errorPage(message: string, status = 400): Response {
	return htmlResponse(
		`<div class="pane"><div class="brand">${whopLogoSvg(32)}</div><h1>Connection failed</h1><p>${escapeHtml(message)}</p><p>Close this window and try connecting again.</p></div>`,
		status,
	);
}
