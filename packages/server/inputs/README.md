# Registry inputs

`openapi.json` is a pinned copy of Whop's public API contract from
`https://api.whop.com/openapi.json`.

`scope-definitions.json` contains only scopes referenced by that contract and
only the four capability fields used to decide whether user, business, and app
credentials can call an operation. It intentionally excludes backend-only
scope metadata.

The build combines these inputs with the reviewed files in `../metadata/` and
writes `../generated/manifest.json`.
