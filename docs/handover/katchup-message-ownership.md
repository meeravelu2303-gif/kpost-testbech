# P0 — Any signed-in user can rewrite and then erase any message on the platform

**Found 2026-09-11 on `192.168.0.66`. Reproducible on demand.**

## Read this part first

There are two bugs here and **fixing only the obvious one leaves the platform open.**

1. **`sendMessage` does not check ownership when a `msgID` is supplied.** Any signed-in account
   can overwrite any message by id — and `msgID` is not even a documented field for this route.
2. **Recall and delete DO check ownership — and the check is defeated by bug 1.** They decide
   "is this yours?" by reading the message's `sender` field. Edit lets the attacker *set* that
   field. So the check runs, passes, and authorises the attacker.

Bug 2 is not a missing check. It is a correct-looking check reading an input the attacker
controls. It will not show up in a code review of `recallMessage`, because nothing is wrong with
`recallMessage`.

**The risk if this is patched in the obvious order:** a developer fixes Edit, opens
`recallMessage` and `deleteKatchUpMessage`, sees an ownership check already present in both, and
ships. The escalation is closed by accident, and it reopens the moment anything else lets a
caller influence `sender`.

**What the fix has to be:** ownership must be decided from the message's **original creator** —
a value written once at insert and never settable by a caller — not from a mutable `sender` field
on the current row. That applies to all five actions, including the two that look correct today.

## End to end, what an attacker can do

Given nothing but a signed-in account:

1. Count to a message id they were never shown.
2. Rewrite that message's **text**.
3. Rewrite its **author**, so it now reads as sent by them.
4. Recall it.
5. Delete it.

Afterwards the person who actually wrote the message cannot see it, cannot see what it was
changed to, and cannot see that anything happened. **No copy of the original survives on any read
we could find.**

## Why this is P0

KPost is sold on traceable, referenceable messaging — a durable record of who said what, which is
the reason a business chooses it over a chat app. This defeats that end to end: an attacker can
put words into another person's mouth inside that person's own conversation, and then remove the
evidence. Every downstream promise built on the message record — reference messages, read
receipts, audit trails, forwarding with thread — inherits a record that any user can author on
someone else's behalf.

It is not a data-exposure bug, so it will not look like one on a security dashboard. It is an
integrity bug in the thing the product is for.

## The escalation, measured in order

One message, three calls, timestamps in sequence. `A` and `B` hold a conversation; `C` is a
signed-in stranger with no relationship to either.

| # | Who | Action | Result |
| - | --- | ------ | ------ |
| 0 | A | sends B a message | msgID **850794**, `sender: A` |
| 1 | C | edit (`sendMessage`, `messageType: 6`, `msgID: 850794`) | **200** — row now reads `sender: C` |
| 2 | C | `recallMessage` on 850794 | **200** — *was 400 one call earlier* |
| 3 | C | `deleteKatchUpMessage` on 850794 | **200** — *was 400 one call earlier* |

Steps 2 and 3 were verified to return **400 Refused** for `C` against an untouched message of A's.
The only thing that changed between the refusal and the acceptance is that step 1 rewrote
`sender`.

## How to reproduce

**Step 1 — A sends B a message.**

```http
POST /v2/katchup/sendMessage
Authorization: Bearer <A's token>

{ "receiver": "B", "subject": "Q3 numbers", "actualMessage": "ORIGINAL TEXT", "messageType": 0 }
```

```json
{ "data": [ { "msgID": 850794, "sender": "A", "receiver": "B", "actualMessage": "ORIGINAL TEXT" } ] }
```

**Step 2 — C, neither sender nor recipient, edits it by id.**

```http
POST /v2/katchup/sendMessage
Authorization: Bearer <C's token>

{ "receiver": "A", "subject": "Q3 numbers", "messageType": 6,
  "msgID": 850794, "referenceMsgID": 850794, "actualMessage": "HIJACKED TEXT" }
```

**HTTP 200, accepted:**

```json
{ "data": [ { "msgID": 850794, "sender": "C", "receiver": "A",
              "messageType": 6, "actualMessage": "HIJACKED TEXT" } ] }
```

**Step 3 — read it back as A, the person who wrote it.**

```http
POST /v2/katchup/katchupMessagesForSelectedContactID
Authorization: Bearer <A's token>

{ "selectedContact": "B", "receiver": "B", "groupFlag": false, "msgID": 0 }
```

A's conversation with B returns **no row for msgID 850794 at all.** Reading as C shows the same id
as C's own message. Both content and author were replaced; the original is not recoverable.

**Step 4 — C now recalls and deletes it.** Both answer **200**, as in the table above.

## The ids are guessable

Two consecutive sends, different senders, different recipients:

| call | from | to | msgID |
| --- | --- | --- | --- |
| 1 | A | B | 850786 |
| 2 | B | D | 850787 |

One global counter, increment of 1. An attacker does not need to have been shown a message to
reach it; they only need to count.

We did **not** test against ids belonging to accounts we do not own. Everything above uses our own
QA accounts with the attacker deliberately made a non-participant — the same proof without
touching anyone's real data.

## The root cause: an undocumented `msgID` field

The affected set is not "Edit, Note and Reminder". It is **any call to `sendMessage` carrying a
`msgID`.** Measured with a separately seeded message per case:

| request | effect |
| --- | --- |
| `messageType: 6` (edit), `referenceMsgID` only | new message created, **owner keeps theirs** |
| `messageType: 1` (reply), `referenceMsgID` only | new message created, **owner keeps theirs** |
| `messageType: 6`, `msgID` present | **owner's row overwritten** |
| `messageType: 1`, `msgID` present | **owner's row overwritten** |
| `messageType: 0` — a plain new message — `msgID` present | **owner's row overwritten** |

A plain send with no action semantics at all takes the message over. So the message type is
irrelevant; the presence of `msgID` is the whole vector.

**`msgID` is not a documented request field for this route.** The API workbook for
`POST /v2/katchup/sendMessage` lists `referenceMsgID` and does not list `msgID` at all. An
undocumented input silently converts a create into an unauthorised update. `referenceMsgID` — the
field that *is* documented — behaves correctly in every case above.

That makes the smallest correct fix straightforward: **stop honouring `msgID` on this route.**
The ownership check is still needed for the paths that legitimately update a message, but the
undocumented field is what turns every send into a potential takeover.

## Which actions are affected

Caller is neither sender nor recipient. Each row is a **separately seeded message**, so the
results are independent.

| Action | Request | Result | Owner's message afterwards |
| --- | --- | --- | --- |
| **Edit** | `sendMessage`, `messageType: 6` + `msgID` | **200 accepted** | gone from their conversation |
| **Note** | `sendMessage`, `messageType: 5` + `msgID` | **200 accepted** | gone |
| **Reminder** | `sendMessage`, `messageType: 3` + `msgID` | **200 accepted** | gone |
| **Reply** | `sendMessage`, `messageType: 1` + `msgID` | **200 accepted** | gone |
| **Plain send** | `sendMessage`, `messageType: 0` + `msgID` | **200 accepted** | gone |
| Recall | `recallMessage` | 400 refused | intact |
| Delete | `deleteKatchUpMessage` | 400 refused | intact |

Recall and delete have an ownership check. Every `sendMessage` variant carrying `msgID` does not.

## A second, separate defect on the same route

While confirming the above we found that **a reply is not linked to the message it replies to.**
Sent with the documented `referenceMsgID` and no `msgID`, the reply is stored with
`referenceMessageIDList: []` and `referenceMessage: null`. Nothing points at the original.

This is not a security issue, but it undermines the same product promise: reference lookups,
thread forwarding and clarification chains have no link to follow. Raised here because it is the
same endpoint and the same field family; it can be ticketed separately if that is easier.

## Suggested fix

**1. Authorise every one of the five actions against the original creator.** Load the message by
`msgID`, compare the caller's token identity against a creator value that was written at insert
and is not settable through any request body. If today's `sender` column is that value, it must
stop being writable by Edit; if it is not, the creator needs to be recorded separately.

**2. Do not take `sender` from the caller on an edit.** Even with the check added, an edit should
preserve the original author on the record.

**3. Treat Recall and Delete as in scope even though they refuse a non-owner today.** Their check
is only as trustworthy as the field it reads.

Worth deciding at the same time: **should message ids be guessable?** The ownership check is the
fix for this report, but non-sequential or non-global ids would remove the ability to enumerate
other people's messages at all, which limits the blast radius of any future gap of this kind.

## How we will know it is fixed

Five automated checks now cover this family — Edit, Note, Reminder, Recall and Delete. Each seeds
its own message between two accounts and attempts the action as a third, then asserts two things:
the action is refused, **and** the owner's message is still theirs afterwards.

Three fail today (Edit, Note, Reminder); two pass (Recall, Delete). The two that pass are kept
deliberately — they are the guard that the escalation does not reopen from the other end. All five
will pass when ownership is decided from a value the caller cannot set, and they run on every
build after that.

## Contact

Raised by QA automation, 2026-09-11. Request and response captures for every step above are
available on request.

---

## Related P1 — a Note/Reply leaks the Confidential Copy list through its snapshot

Confirmed live 2026-09-11, and likely the same root cause as the production Confidential Copy leak.

A Confidential Copy (`messageType 14`, people in `sharedMessageDetails.hiddenContactList`) is
delivered correctly: the server strips `hiddenContactList` from every recipient's copy but the
sender's. But when someone adds a **Note** (`sharedType 5`), **Reminder** (3) or **Reply** to that
message, the web client embeds a `referenceMessage` **snapshot** of the original — built from the
sender's view, which holds the full hidden list — and the server serves that snapshot to every
recipient **unchanged**.

Result, measured from each recipient's own inbox on a message hidden-copied to two people:

| reads the note as | top-level hiddenContactList | the note's referenceMessage snapshot |
| --- | --- | --- |
| primary (not hidden) | `[]` (correct) | **both hidden recipients** |
| hidden recipient A | just themselves | A **and** B |
| hidden recipient B | just themselves | A **and** B |

So the confidentiality holds on the message itself and is defeated the moment anyone annotates it.

**Fix (server-side, durable):** whenever a `referenceMessage` snapshot is served to a caller who is
not the message's sender, strip `hiddenContactList` from it — the same per-recipient rule already
applied to the top-level field. The client should also stop embedding the list, but the client
cannot be trusted (other clients exist), so the server strip is the real fix.

**Note:** if a note is sent with only `temporaryMsgID` and no client-built snapshot, the server
attaches nothing and there is no leak — so the server is not building the snapshot, only passing the
client's through. Both ends contribute; fix the server.
