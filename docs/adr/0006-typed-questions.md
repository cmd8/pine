# 0006: Typed questions on routes, and decision models as sources

Status: proposed. Prompted by pull request 102 ("a route can ask Jev, TypeSafe's decision model,
typed questions about an event").

## Context

A route's `call` asks a model one question and publishes its text. A second route can only match
that text with a pattern (`"regex": "^(PERSON|VEHICLE)"`), which breaks as soon as the model adds a
word, and the text it matches is whatever the model said, which can repeat what the event said.

"Decision models" answer typed questions instead: a probability of yes, one of named options, a
level on a scale. A filter reads such an answer as it is (`payload.answers.urgent.yes >= 0.8`).
Pull request 102 brings that to pine through one vendor, TypeSafe's Jev: a `jev` block on a route,
`TYPESAFE_API_KEY` in `.env`, a `jev` block in `pine.json` (`model`, `baseUrl`), a Settings section,
`pine login typesafe` and a case of `sign_in`. The idea fills a real gap. Its shape has four
problems:

1. **One paid vendor is wired into core**: a module, a key name, a configuration block, a Settings
   section and a CLI login. Rule 7 says there is one way to connect pine to something outside, a
   source type with a schema; model servers are generic already (`add_model_server`).
2. **The trust claim is not enforced.** The pull request publishes Jev's answers with the event's
   trust because they are "only a number or one of the owner's names", but `askJev` returns
   `answers` unchecked, and `{{jev.<name>}}` carries any string on into a payload and a prompt.
3. **An event can steer what is asked**: the questions are rendered with the event's values
   (`renderDeep(route.jev.questions, ctx)`).
4. **The key goes by plain `fetch` to a `baseUrl` that `pine.json` can change**, and every matching
   event's whole payload goes to a third party, with nothing in a route's dialog that says so.

## Options weighed

**(a) A typed-question step on routes that runs on any model.** `ask` beside `call`: the owner's
questions, the event's data, one call without tools to a model the owner configured (llama.cpp
included), the answer held to a JSON schema where the server can hold it to one, and checked
against the questions' types before anything is published. Cheap (one small call, no agent turn),
works offline, and the check is what makes publishing with the event's trust true. On its own it
leaves out services whose API is not a chat completion, such as Jev's.

**(b) A decision model as a source type.** Rule 7's one way out, and it already has everything a
vendor needs: a schema, a secret option kept in `.env` and asked of the owner in the dialog
(`ApprovalDecision.values`), a plan the owner confirms, a fixed address in the type's code, a status
line. But a source receives and reports; it does not take events in. A source that subscribed to
the bus and emitted judged events would be a second router, outside `when`, `throttle`, `debounce`
and the hop limit, with `capped` limits meant for devices. Wrong shape for the step, right shape
for the connection.

**(c) An MCP server the agent calls.** Works today without any change: `add_mcp_server` with a
remote URL and the key in `headers`, and the agent calls `jev_ask` when it wants. It costs an agent
turn per event, which is what a typed filter is meant to save, and its answer lands in a
conversation as tool output rather than in a filter. Good for an agent that wants a second opinion
inside its work, but no substitute for a route.

**(d) What pine has.** The goal judge (`src/goals.ts`) and the swarm's checker already make a model
call without tools on a model the owner picked (`defaults.judge`, `defaults.checker`), frame what
they read as data, and read the answer strictly (`parseJudgement`: no verdict is never "go on").
Typed questions are the same move, made general and moved onto routes.

## Decision

**(a) for the step, (b) for the vendor.** A route gets `ask`; whoever answers is a model, by
default, or a source whose type says it `decides`.

```json
{ "name": "mail-judge", "on": "source/inbox/mail",
  "ask": { "data": "{{payload.subject}}\n{{payload.text}}",
           "questions": { "urgent": { "type": "yesno", "question": "Does this need an answer today?" } } },
  "publish": { "topic": "mail/judged" } }
```

- **Questions** (`src/ask.ts`): `yesno` (answered `{ "yes": 0.87 }`), `choice` (`options`, two or
  more names with when each applies; `{ "choice": "invoice" }`), `score` (`levels`, two to ten,
  lowest first; `{ "level": "annoyed", "score": 1 }`). A decision model of a service may also give a
  score between levels (Jev's is the probability-weighted level, `1.7`: `level` is then the nearest)
  and, for a choice or a score, a `confidence` from 0 to 1; both are kept only as numbers in range. Pine's own names, in plain words; a vendor's
  adapter maps them to its API (Jev: `yesno` is `noul`, `question` is `instructions`, `options` and
  `levels` are `criteria`). A `{{...}}` anywhere in a question, option or level is refused when the
  route is loaded and when it is proposed: the questions are fixed text, the event's values go only
  into `data`.
- **The step** (`Router.ask` in `src/router.ts`): runs after `call`, before `publish`, and stands
  with `publish` alone (no `agent`, no `call`), as the pull request had it. `data` defaults to the
  payload and is cut at `limits.maxEventChars`. All questions go in one call
  (`askPrompt`: the data in a `<data>` frame it cannot close, a system prompt that says it is not
  the owner's). On an OpenAI-compatible server the call carries `response_format` with the
  questions' JSON schema (`answerSchema`, enums for option names and levels), which llama.cpp turns
  into a grammar; elsewhere the model is told the format. Either way `checkAnswers` keeps only what
  fits the types and drops everything else the answerer said. A model that answers otherwise is
  asked once more; then the route fails with `pine/route-failed` and publishes nothing. There is no
  default answer.
- **Decision models of a service** are source types with `decides` (one line for the owner: where
  what it is asked about goes) and `onDecide(handler)`, called with `{ questions, data, signal }`
  (`SourceHost.decide`). Only a source of all agents, since routes are pine's. Its answers pass the
  same `checkAnswers`. TypeSafe is the built-in type `typesafe` (`src/sources/typesafe.ts`), a
  vendor's type like `slack` or `zulip`: its key a secret option, its address
  `https://api.typesafe.ai/v1/systemone` fixed in the type (`service`, which only a test moves),
  its requests through `publicOnlyAgent` and never along a redirect, `plan()` saying where the data
  goes and refusing an agent's own source, retries on 429 and 529, and errors and the status line
  in pine's words with TypeSafe's status code, never TypeSafe's text. No `jev` block, no `baseUrl`,
  no key name in core, no login command. It could as well be a type of the owner's own
  (`sourceTypes`, `add_source_type`): nothing in core names it but `SOURCE_TYPES`.
- A decision model on a server of the owner's own is the same type with `url`: TypeSafe's API is
  the format, so the type is named after it, and any model behind it (Pinecone serving
  pplx-decider, another vendor, an open model) is `model`. The address is then the one the owner
  confirmed (`local` for a name on their own network that does not say so, a key if the server
  wants one), with a longer wait (120 s) for a server that loads the model first. The request and
  the reading of the answers are `src/sources/systemone.ts`.
- If TypeSafe offers an OpenAI-compatible endpoint that honours `response_format`, it is simply a
  model server (`add_model_server`) and `ask.model` names it: no source type at all.

## Trust and the outside-content mark

The answers are a number from 0 to 1, one of the owner's option names or one of the owner's
levels, checked in pine's code whoever answered. No text of the event reaches them, so publishing
them with the event's trust (`route.trust ?? e.trust`, as `call` does) is true. The published
payload's `of` is the original payload with its original trust. A second route that wakes an agent
for an answer about an untrusted mail wakes it as for the mail itself: `untrusted`, `safe`,
the reduced profile. An event can still steer the answer (a mail that says "this is urgent"); that
picks which of the owner's routes fires, never what they do or with what trust. That is the same
power as writing to the topic, and the docs say so.

## What leaves the machine, and where the owner is told

With a model: the `data` goes to that model, as `call`'s prompt does; with a local model nothing
leaves. With a decider source: the owner confirms the source (its `plan()` says where data goes)
and every route that asks it (`checkRoute` adds the line "what it is asked about leaves this
computer: <decides>"). `pine check` names a route whose `ask.source` is not a source of all agents.

## How the owner configures it

- **pine.json**: `ask` on a route (docs/references/events.md, "Typed questions").
- **The main agent**: `add_route` takes `ask_questions` (JSON), `ask_data`, `ask_model` or
  `ask_source`; the owner sees who answers and what goes where, line by line, and confirms. A
  decider source is set up with `add_source` like any other.
- **The `sources` tool** marks a source of all agents that decides ("answers typed questions of
  routes"), so the main agent finds it without the manual.
- **Settings** (not built here): the route form's Then gets "Ask" beside "Call a model", with the
  question editor of pull request 102 and a picker of the models and the decider sources. The key
  of a vendor is asked in the dialog of the source, not in Settings > Models.

## Tests

`test/ask.test.ts`, on the scripted mock without network: the question rules (no templates, types,
options, levels); `checkAnswers` refusing free text in place of an option (also a name every
object has), a probability out of range, a missing answer; a route asked through the mock's
`withoutTools`, its answers published with the event's trust and filtered by a second route, the
request carrying the schema; a model that answers outside the types twice, so that the route fails
and publishes nothing; a stand-in source type that decides, held to the same check; and
`checkRoute`'s lines and refusals. `test/typesafe.test.ts` runs the `typesafe` type against a
stand-in for TypeSafe's API on a loopback port, answering as its documentation says: pine's
questions in TypeSafe's words, a continuous score and confidences kept, the rest dropped, a 529
tried again, an option outside the owner's refused, a refused key said in pine's words and not
TypeSafe's, no redirect followed, and `plan()`'s refusals. `test/manual.test.ts` asks for the
sections in a newcomer's words.

## What of pull request 102 is kept

Its idea and its two-route shape (`ask` with `publish`, then `when` on `payload.answers`), its
question schema with pine's names, its validation messages (`questionsProblem`), its tests' cases
moved onto the mock, its docs in `events.md` (rewritten as "Typed questions"), its route form and
question editor (relabelled "Ask"), and its stories. Its `jev.ts` request code becomes the body of
the TypeSafe source type's `onDecide`, with the address fixed and the fetch guarded. What goes:
the `jev` block in `pine.json`, `TYPESAFE_API_KEY` as a name core knows, `pine login typesafe`, the
`sign_in` case, and the Decision models section of Settings > Models.

## Open for the owner

- Whether the `typesafe` type ships with pine (as built here) or stays the contributor's own
  module (`sourceTypes` in `pine.json`, or `add_source_type`).
- Whether a type for local classifiers that are not chat models (zero-shot and NLI models,
  sequence classifiers behind Hugging Face's text-embeddings-inference) is worth having. A chat
  model on llama.cpp needs none: `ask.model` names it.
- Whether a `yesno` on a llama.cpp server should be read from the token probabilities of "yes" and
  "no" (`logprobs`) instead of the number the model states: calibrated, and the thing a decision
  model is bought for.
- Whether `ask` should get a default model of its own (`defaults.ask`, like `defaults.judge`) so
  that a small local model answers while agents run on a large one.
