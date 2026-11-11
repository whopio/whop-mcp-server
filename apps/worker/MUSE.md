# Whop connector for Muse

## Overview

Whop is where creators and businesses sell memberships, courses, communities,
and digital products. The Whop connector lets a business owner run their store
from Muse: check sales and revenue, look up customers and their memberships,
manage products and prices, edit courses, and answer customer chats.

It reaches live, private account data that Muse cannot get from public pages:
payments, members, memberships, chats, and support conversations. A connection
can only reach businesses the signed-in Whop user already manages.

Restrictions: the user needs a Whop account. A user without a business can
create one with `accounts_create`. Tools act only on businesses Whop already
authorizes that user for. Pass
`account_id` (`biz_…`, from `accounts_list`) to choose a business.

## Setup

- Endpoint: `https://mcp.whop.com/muse/mcp`
- Transport: Streamable HTTP
- Authentication: OAuth 2.1 with PKCE and dynamic client registration.
  Discovery starts at
  `https://mcp.whop.com/.well-known/oauth-protected-resource/muse/mcp`.
- The client must send `resource=https://mcp.whop.com/muse/mcp`. A token issued
  for another resource is refused on this endpoint with `insufficient_scope`
  and must sign in again.
- Requested scope: `admin`. On this endpoint it maps to a Whop grant holding
  read permissions plus only the write permissions the listed write tools
  below need. The grant never holds permissions that move money, such as
  `payment:charge`, `payout:withdraw_funds`, or `payout:transfer_funds`.

## Tools

Every tool's full inputs and outputs are in its schema from `tools/list`.
Tools are listed most used first. `payments_list`, `variants_create`,
`variants_update`, and `stats_time-series_get` leave rarely used optional
inputs out of their listed schema to keep the listing small; the server accepts
and validates them, and the tool description says so.

The only writes on this endpoint are the ones listed below. Other Whop
information is read through `search_operations`, `describe_operation`, and
`call_read_operation`, which can only run read-only operations. Any other write
returns `tool_not_found`.

### Read

Reads change nothing.

| Tool | Returns | Whop permission |
|---|---|---|
| `payments_list` | Sales and payments, newest first | `payment:basic:read` |
| `payments_get` | One payment with its line items | `payment:basic:read` |
| `refunds_list` | Refunds issued | `payment:basic:read` |
| `disputes_list` | Chargebacks and disputes | `payment:dispute:read` |
| `stats_time-series_get` | A business metric over time | `stats:read` |
| `members_list` | A business's customers, including contact details | `member:basic:read` |
| `memberships_list` | Memberships and their status | `member:basic:read` |
| `memberships_get` | One membership | `member:basic:read` |
| `events_list` | Visits, checkouts, and purchases tied to a person | `company:basic:read`, `member:basic:read`, or `member:journey:read` |
| `products_list` | A business's products | none, or `access_pass:basic:read` |
| `products_get` | One product | none |
| `variants_list` | A product's prices | none, or `plan:basic:read` |
| `variants_get` | One price | none, or `plan:basic:read` |
| `experiences_list` | Apps set up in a business | none |
| `files_get` | An uploaded file and its upload status | none |
| `course-lessons_get` | One course lesson | `courses:read` |
| `forum-posts_list` | Forum posts | `forum:read` |
| `messages_list` | Messages in a chat, DM, or support conversation | `support_chat:read`, `chat:read`, or `dms:read` |
| `messages_get` | One message | `support_chat:read`, `chat:read`, or `dms:read` |
| `dm-channels_list` | The user's DM conversations | `dms:read` |
| `support-channels_list` | Customer support conversations | `support_chat:read` |
| `resolution-center-cases_list` | Buyer complaints and refund requests | `payment:resolution_center_case:read` |
| `accounts_list` | Businesses the user can act on | none, or `company:balance:read` |
| `accounts_get` | One business | `company:balance:read` |
| `bounties_list` | Paid content bounties | `bounty:basic:read` |

### Write

| Tool | Side effect | Whop permission |
|---|---|---|
| `products_create` | Creates a product for a business | `access_pass:create` |
| `variants_create` | Adds a price to a product | `plan:create` |
| `files_create` | Creates a file record and an upload URL; nothing changes until the file is attached | none |
| `accounts_create` | Creates a new business owned by the user | `company:create` |
| `experiences_create` | Adds an app (course, forum, chat) to a business; customers get no access until it is attached | `experience:create` |
| `courses_create` | Creates a course inside a course app | `courses:update` |
| `course-chapters_create` | Adds a chapter to a course | `courses:update` |
| `course-chapters_update` | Renames a course chapter | `courses:update` |
| `promo-codes_create` | Creates a discount code customers can use at checkout | `promo_code:create` |

### Sensitive write

Each of these changes what customers see, pay, or receive, so Muse should ask
for approval on every use.

| Tool | Side effect | Whop permission |
|---|---|---|
| `messages_create` | Sends a message to other people in a chat, DM, or support conversation | `support_chat:message:create`, `chat:message:create`, or `dms:message:manage` |
| `memberships_cancel` | Cancels a customer's membership, now or at the end of the billing period | `membership:cancel` or `member:manage` |
| `variants_update` | Changes a price, billing period, stock, or visibility that customers see | `plan:update` |
| `products_update` | Changes a product's details or visibility on the store | `access_pass:update` |
| `course-lessons_create` | Publishes a new lesson to a course's students | `courses:update` |
| `course-lessons_update` | Changes a lesson students can see | `courses:update` |
| `experiences_attach` | Gives a product's customers access to an app | `experience:attach` |
| `forum-posts_create` | Publishes a post or comment in a community forum | `forum:post:create` |

### Reading other Whop information

| Tool | Classification | What it does |
|---|---|---|
| `search_operations` | Read | Finds read-only Whop operations from plain words, with the input schema for the top 3 |
| `describe_operation` | Read | Returns one operation's full input schema, including inputs a listed tool leaves out |
| `call_read_operation` | Read | Runs one read-only operation found with `search_operations`; it refuses anything that changes data |

### Other tools

| Tool | Classification | What it does |
|---|---|---|
| `docs_search` | Read | Searches the public Whop documentation |
| `docs_query` | Read | Reads a page of the public Whop documentation |
| `connection_status` | Read | Returns the signed-in identity, business, and permissions; never credentials |

## Not available

This connector does not move money. It cannot charge customers, issue refunds,
create or send invoices, withdraw or transfer funds, change payout details,
trade or swap, buy domains, or pay for AI media generation. Those operations
are not served on this endpoint, and the connection's Whop credential does not
hold their permissions. There are no checkout or payment tools, so reviewers do
not need a way to test charges.

## Data handling

- Tools send the Whop API only the inputs the tool call contains. The connector
  does not ask for or store the user's request text.
- The OAuth grant, including the user's Whop token, is kept server-side until
  it expires or the user disconnects; it is never shown to Muse or the model.
- Server logs record which tool ran, for which user and business, the outcome,
  and the Whop request id. They do not record inputs or responses.

## Status and errors

Failed calls return `isError: true` with a JSON body of
`{ "error": { "code", "message" } }`.

| Code | Meaning | What to do |
|---|---|---|
| `tool_not_found` | The tool is not available on this connection | Use a listed tool |
| `account_required` | The tool needs a business | Pass `account_id` from `accounts_list` |
| `missing_scope` | The grant lacks a permission | Reconnect, or use another tool |
| `invalid_input` | An argument is missing or wrong | Correct the argument |
| `upstream_error` | The Whop API refused the call; `status` holds the HTTP status | Follow the message |
| `timeout` | The Whop API did not answer in time | Check the result before retrying a write |

Before retrying a write whose result is unclear, such as after a `timeout`,
read the record back: list the product, price, membership,
or messages. Writes that accept an `idempotency_key` replay the first result
when the same key is sent again. `messages_create` has no replay protection, so
a repeated call sends again.

The Whop API allows 600 requests per minute per operation and credential by
default. Past that, a tool returns `upstream_error` with status 429 and a
message saying how long to wait.

## Test account

Reviewers get a dedicated Whop test account that manages a business with
products, prices, customers, a course, and support chats, so every tool above
can be exercised. Sign-in details are provided through the submission form.
