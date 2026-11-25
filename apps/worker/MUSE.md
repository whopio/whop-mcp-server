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
  below need. The only money it can move is a refund to a customer, through
  `payments_refund` and `resolution-center-cases_accept`. Refunds need
  `payment:manage`, `payment:dispute`, and `payment:resolution_center`, which
  the Whop API also accepts for actions this endpoint doesn't serve, such as
  retrying a failed charge or conceding a dispute. The Whop token stays on
  Whop's server and this endpoint runs only the tools listed below, so those
  actions can't be reached. The grant never holds `payment:charge`,
  `payout:withdraw_funds`, `payout:transfer_funds`, or any other payout,
  transfer, or trading permission.

## Tools

Every tool's full inputs and outputs are in its schema from `tools/list`.
Tools are grouped by the job they serve: checking the business, selling,
customers and support, then courses. `payments_list`, `variants_create`,
`variants_update`, `stats_time-series_get`, `accounts_update`,
`checkout-configurations_create`, and `apps_list` leave rarely used optional
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
| `refunds_list` | Refunds issued | `payment:basic:read` |
| `disputes_list` | Chargebacks and disputes | `payment:dispute:read` |
| `stats_time-series_get` | A business metric over time | `stats:read` |
| `stats_time-series_list` | The metrics `stats_time-series_get` can chart | none |
| `members_list` | A business's customers, including contact details | `member:basic:read` |
| `memberships_list` | Memberships and their status | `member:basic:read` |
| `products_list` | A business's products | none, or `access_pass:basic:read` |
| `products_get` | One product | none |
| `variants_list` | A product's prices | none, or `plan:basic:read` |
| `variants_get` | One price | none, or `plan:basic:read` |
| `promo-codes_list` | A business's promo codes | `promo_code:basic:read` |
| `experiences_list` | Apps set up in a business | none |
| `apps_list` | Apps a business can add or owns, such as Courses | none |
| `courses_list` | Courses in a business | `courses:read` |
| `course-chapters_list` | A course's chapters | `courses:read` |
| `course-lessons_list` | A course's lessons | `courses:read` |
| `files_get` | An uploaded file and its upload status | none |
| `forum-posts_list` | Forum posts | `forum:read` |
| `messages_list` | Messages in a chat, DM, or support conversation | `support_chat:read`, `chat:read`, or `dms:read` |
| `channels_list` | DM, group, chat, and customer support conversations | `dms:read`, `chat:read`, or `support_chat:read` |
| `resolution-center-cases_list` | Buyer complaints and refund requests | `payment:resolution_center_case:read` |
| `accounts_list` | Businesses the user can act on | none, or `company:balance:read` |
| `accounts_get` | One business | `company:balance:read` |
| `recommended-actions_list` | Recommended next actions for a business | `company:basic:read` |

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
| `members_update` | Changes a customer's details on the business | `member:manage` |
| `members_notes_create` | Adds a private note to a customer; the customer doesn't see it | `member:manage` |
| `memberships_resync_access` | Re-applies a membership's access to content and linked Discord | `membership:resync_access` |
| `payments_generate_pdf` | Creates a receipt PDF for a payment and returns a short-lived link | `payment:basic:read` |
| `channels_mark_read` | Marks a conversation read for the signed-in user | `dms:read`, `chat:read`, or `support_chat:read` |
| `channels_mark_unread` | Marks a conversation unread for the signed-in user | `dms:read`, `chat:read`, or `support_chat:read` |
| `channels_accept` | Accepts a DM request | `dms:read` |
| `channels_hide` | Declines a DM request by hiding it | `dms:read` |
| `channels_reopen` | Reopens a resolved support conversation | `support_chat:create` |
| `messages_pin` | Pins a message in its conversation | `dms:message:manage`, `chat:message:create`, or `support_chat:message:create` |
| `messages_unpin` | Unpins a message | `dms:message:manage`, `chat:message:create`, or `support_chat:message:create` |
| `messages_react` | Adds the user's emoji reaction to a message | `dms:read`, `chat:read`, or `support_chat:read` |
| `promo-codes_activate` | Turns a promo code back on | `promo_code:update` |
| `promo-codes_deactivate` | Turns a promo code off so it can't be used at checkout | `promo_code:update` |
| `disputes_update` | Edits a dispute's evidence; nothing is sent until `disputes_submit` | `payment:dispute` |
| `experiences_duplicate` | Copies an app (course, forum, chat) inside the business; customers get no access until it is attached | `experience:create` |
| `affiliates_create` | Adds an affiliate who earns commission on referred sales | `affiliate:create` |
| `affiliates_archive` | Stops an affiliate from earning on new sales | `affiliate:update` |
| `affiliates_unarchive` | Restores an archived affiliate | `affiliate:update` |
| `checkout-configurations_create` | Creates a checkout link; nobody is charged until a customer checks out | `checkout_configuration:create` |
| `channels_create` | Opens a DM or support conversation; nothing is sent until `messages_create` | `dms:channel:manage` or `support_chat:create` |
| `channels_resolve` | Marks a support conversation resolved | `support_chat:create` |
| `recommended-actions_dismiss` | Dismisses a recommended action the owner does not want | `company:update` |

### Sensitive write

Each of these changes what customers see, pay, or receive, so Muse should ask
for approval on every use.

| Tool | Side effect | Whop permission |
|---|---|---|
| `messages_create` | Sends a message to other people in a chat, DM, or support conversation | `support_chat:message:create`, `chat:message:create`, or `dms:message:manage` |
| `variants_update` | Changes a price, billing period, stock, or visibility that customers see | `plan:update` |
| `products_update` | Changes a product's details or visibility on the store | `access_pass:update` |
| `accounts_update` | Changes a business's public name, description, links, or images | `company:update` |
| `course-lessons_create` | Publishes a new lesson to a course's students | `courses:update` |
| `course-lessons_update` | Changes a lesson students can see | `courses:update` |
| `experiences_attach` | Gives a product's customers access to an app | `experience:attach` |
| `forum-posts_create` | Publishes a post or comment in a community forum | `forum:post:create` |
| `resolution-center-cases_reply` | Answers Whop's request for information on a buyer's complaint | `payment:resolution_center` |
| `payments_refund` | Refunds all or part of a customer's payment to their original payment method; it can't be undone | `payment:manage` |
| `resolution-center-cases_accept` | Accepts a buyer's complaint, refunds the payment in full, and closes the case | `payment:resolution_center` |
| `resolution-center-cases_deny` | Rejects a buyer's complaint and closes it with no refund | `payment:resolution_center` |
| `resolution-center-cases_request_info` | Asks the buyer for more information on their complaint | `payment:resolution_center` |
| `disputes_submit` | Sends a dispute's evidence to the payment processor; it can't be edited afterwards | `payment:dispute` |
| `memberships_cancel` | Cancels a customer's membership, now or at the end of the billing period | `membership:cancel` or `member:manage` |
| `memberships_pause` | Pauses a customer's recurring payments | `member:manage` |
| `memberships_resume` | Restarts a paused membership's recurring payments | `member:manage` |
| `notifications_create` | Sends a notification to every member of an app, or to the business's team | `notification:create` |
| `channel-members_create` | Adds someone to a DM, group, or support conversation | `dms:message:manage` or `support_chat:message:create` |
| `channel-members_delete` | Removes someone from a conversation | `dms:channel:manage` |
| `messages_update` | Edits a message others have already seen | `dms:message:manage`, `chat:message:create`, or `support_chat:message:create` |
| `messages_delete` | Deletes a message for everyone | `dms:message:manage`, `chat:message:create`, or `support_chat:message:create` |
| `shipments_create` | Adds a carrier tracking number to a customer's order | `shipment:create` |
| `shipments_update` | Changes an order's tracking number | `shipment:create` |
| `waitlist-entries_deny` | Turns down someone waiting to join a product | `plan:waitlist:manage` |
| `products_delete` | Deletes a product | `access_pass:delete` |
| `variants_delete` | Deletes a price from a product | `plan:delete` |
| `promo-codes_delete` | Archives a promo code for good | `promo_code:delete` |
| `checkout-configurations_delete` | Deletes a checkout link so it stops working | `checkout_configuration:delete` |
| `courses_update` | Changes a course students can see | `courses:update` |
| `courses_delete` | Deletes a course with its chapters, lessons, and student progress | `courses:update` |
| `course-chapters_delete` | Deletes a chapter and its lessons | `courses:update` |
| `course-lessons_delete` | Deletes a lesson | `courses:update` |
| `experiences_update` | Changes an app's name, logo, visibility, or place in the business | `experience:update` |
| `experiences_detach` | Removes a product's customers' access to an app | `experience:detach` |
| `experiences_delete` | Deletes an app and removes every customer's access to it | `experience:delete` |
| `forum-posts_update` | Edits a forum post or comment others can see | none |
| `forums_update` | Changes a forum's settings for its members | `forum:moderate` |

### Reading other Whop information

| Tool | Classification | What it does |
|---|---|---|
| `search_operations` | Read | Finds read-only Whop operations from plain words, with the input schema for the best match |
| `describe_operation` | Read | Returns one operation's full input schema, including inputs a listed tool leaves out |
| `call_read_operation` | Read | Runs one read-only operation found with `search_operations`; it refuses anything that changes data |

### Other tools

| Tool | Classification | What it does |
|---|---|---|
| `docs_search` | Read | Searches the public Whop documentation |
| `docs_query` | Read | Reads a page of the public Whop documentation |
| `connection_status` | Read | Returns the signed-in identity, business, and permissions; never credentials |

## Not available

The only money this connector moves is a refund to a customer of the user's
business (`payments_refund`, `resolution-center-cases_accept`). It cannot charge
customers, create or send invoices, withdraw or transfer funds, change payout
details, trade or swap, buy domains, or pay for AI media generation. Those
operations are not served on this endpoint, and the connection's Whop
credential does not hold their permissions. To exercise refunds, reviewers use
a completed purchase on the test account.

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
| `not_found` | No record has that id (404); the message names the list tool | Find the id with it |
| `conflict` | The record's state blocks this call (409) | Read it back, then retry |
| `rate_limited` | Too many calls (429); `retryable` is true | Wait, then retry |
| `upstream_unavailable` | The Whop API failed (5xx); `retryable` is true | Retry later |
| `upstream_error` | The Whop API refused the call another way; `status` holds the HTTP status | Follow the message |
| `timeout` | The Whop API did not answer in time | Check the result before retrying a write |

Before retrying a write whose result is unclear, such as after a `timeout`,
read the record back: list the product, price, membership,
or messages. Writes that accept an `idempotency_key` replay the first result
when the same key is sent again. `messages_create` has no replay protection, so
a repeated call sends again.

The Whop API allows 600 requests per minute per operation and credential by
default. Past that, a tool returns `rate_limited` with status 429 and a
message saying how long to wait.

## Test account

Reviewers get a dedicated Whop test account that manages a business with
products, prices, customers, a course, and support chats, so every tool above
can be exercised. Sign-in details are provided through the submission form.
