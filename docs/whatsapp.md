# WhatsApp Link

Chat with the SynaBun Assistant from WhatsApp. You write in a WhatsApp chat on your phone; the message reaches the Assistant running on your computer, and its answers, questions and approvals come back as WhatsApp messages. Everything is set up and controlled in **Settings → Messages → WhatsApp**.

It is free: SynaBun links to WhatsApp the way WhatsApp Web does, as a **linked device** of an account, through [Baileys](https://github.com/WhiskeySockets/Baileys) (an unofficial client). No Meta developer account, business portfolio, phone number rental or public webhook is involved, and no SynaBun server sits in between. Your computer has to be on and SynaBun running.

## Two ways to chat

| | Message yourself (default) | A second number |
|---|---|---|
| Cost | Free | Free (needs a second number) |
| Setup | One QR scan | One QR scan + a claim code |
| Where you chat | Your own "Message yourself" chat | A normal chat with the second account |
| Notifications for replies | Often silent | Normal |
| Account linked to SynaBun | Yours | The second one |
| If WhatsApp restricts it | Your own account | Only the second account |

**Message yourself** links *your* account. SynaBun reads only your own "Message yourself" chat; every other chat, group and contact is ignored. Replies start with `SynaBun:` (change it under *Reply label*). Only messages typed on the phone count: what you type into "Message yourself" from WhatsApp Web or Desktop is ignored. With *In "Message yourself" → Only messages that start with sb* you can keep using the chat for notes: only messages that start with `sb ` or `sb:` reach SynaBun (the prefix is removed; a bare `sb` works as a picture caption), plus commands (`/stop`, `/status` …), the `ALLOW` answer and replies that quote one of SynaBun's messages. Everything else is a note to self and is dropped without being logged. The service applies this filter; the connector's own prefix filter stays off (`selfTrigger: 'all'` to the host) because it would also drop commands and card answers.


**A second number** links a spare WhatsApp account (a second SIM, or WhatsApp Business on another number). You chat with it like a contact, so replies notify you, and your own account is never linked. Whoever sends the one-time **claim code** first becomes the owner; nobody else is ever answered.

## Setup

1. Open **Settings → Messages → WhatsApp** and pick a mode card.
2. Pick **Link with a QR code** (default) or **Link with a phone number instead** (WhatsApp shows an 8-character code to type on the phone; the number field accepts `+44 7911 123456`, `0044 …`, `(0)` trunk zeros, spaces and dashes, and refuses a number without a country code).
3. Press **Set up WhatsApp**. The first time, SynaBun downloads the connector (about 29 MB, `approxSizeMB` in the connector's `manifest.json`; a few seconds) into its own folder — see [What gets installed](#what-gets-installed). The steps show *Checking*, *Downloading*, *Verifying*, *Activating*; *Cancel* stops it.
4. **Link**: on the phone, WhatsApp → Settings → **Linked devices** → **Link a device**, then scan the QR (it refreshes about every 20 seconds) or type the code. The QR and the code are sent to the Settings tab that asked for them and nowhere else; closing the tab cancels the link.
5. **Confirm the owner**
   - *Message yourself*: the card shows **Linked as {name} · ••••1234**. Press **This is me — start**, or **Not me? Unlink**. Without an answer within 10 minutes the device is logged out again.
   - *A second number*: press **Show the claim code** and send the code (`SB-123456`) from your personal WhatsApp to the linked number — the card also shows a QR and a link that open that chat with the code filled in. Five wrong codes or 10 minutes end the claim.
6. **Connected.** Say hello from the phone. **Send a test message** checks the way back.

## Permission levels

Settings → Messages → WhatsApp → **Safety** decides what a message from the phone may make the Assistant do. The level applies to every WhatsApp conversation and is enforced by the Assistant runtime, its dispatcher and the brain's hooks (`lib/remote-policy.js`), not by the phone.

| Level | What happens |
|---|---|
| **Read-only** | Answers, research and plans only. Plan mode everywhere, no agents; a plan can be approved on the computer only. |
| **Ask on my phone** (default) | Before anything that would change files, run a command or start an agent, SynaBun asks on WhatsApp as a yes / no and acts only on your **yes** (once). Any other message approves nothing and the conversation carries on (see [Questions and approvals](#questions-and-approvals)). Where a task runs is asked the same way, and that answer approves exactly one agent: a second one is asked again. Agents started from WhatsApp get no computer use and run in a registered project folder. |
| **Autonomous** | Acts without asking, like the Assistant on the computer. It **stays on until you turn it off** in Settings → Messages → WhatsApp → **Safety** by choosing Ask on my phone or Read-only, and it survives restarts. Autonomous can read any file your computer account can, including SynaBun's WhatsApp login. Use it only with a locked phone, ideally on a second number. |

**Ask and Autonomous need a Claude brain.** Which model runs the conversation is set under Conversation → **Model** (see [The model](#the-model)); the default is the Assistant panel's last-used brain. On a Codex or OpenCode brain the conversation runs **Read-only**, whatever the level says: Codex cannot ask before ordinary commands, and OpenCode keeps its own permissions. Codex runs in its read-only sandbox with the network off. OpenCode runs its plan agent, with `webfetch`, `websearch` and `codesearch` refused by SynaBun's gate plugin; if that plugin does not load, the conversation does not run. The phone is told once ("This conversation runs read-only because its brain is Codex; switch the WhatsApp brain to Claude for Ask/Autonomous.") and Safety shows the same warning.

Turning on Autonomous takes two steps so that neither a stolen phone nor a local program can do it alone:

1. Click **Autonomous** in Settings, then click it again (an armed second click). Settings shows a 4-digit code, and the phone gets a message saying Autonomous was requested (without the code).
2. Within **5 minutes**, send `ALLOW 1234` (that code) from the phone. Three wrong codes cancel it. A forwarded message never counts.

There is no time limit after that: the phone's confirmation says Autonomous stays on until it is turned off in Settings → WhatsApp. `/pause` pauses acting on your messages and `/stop` stops the current task; neither changes the level. An Autonomous turned on by SynaBun 2.0.5 or earlier (which ended by itself after 8 hours) is not carried over: after the update it reads as Ask, once, and Activity says so ("Autonomous from an earlier version ended; turn it on again to keep it on without a time limit"). Turn it on again to keep it on.

Lowering the level applies at once, and so does switching the conversation's brain to Codex or OpenCode. At every level:

- Computer use (the Assistant controlling this Mac) is off unless you turned it on at this computer, and then only as the level allows: see [Computer use](#computer-use).
- Commands, paths and tools that reach credentials, the WhatsApp session itself (its folder, its runtime, `state.db`), SynaBun's own settings (`kv_config`, `claude-code-projects.json`), persistence points (shell rc files, LaunchAgents, crontab) or browser profiles are refused (`isDeniedRemoteTool`). So is a call whose arguments the brain's host did not pass.
- A prompt that contains forwarded or quoted third-party text, or a picture, is capped at Ask for that turn; the text is wrapped as untrusted data.

**The denylist is a speed bump, not a sandbox.** It matches the text of a command or a path, in its usual spellings: absolute, `~`, `$HOME`, quoted, escaped, with `..`. A shell that builds a path at run time still gets past it, for example through a variable, a glob, or a `cd` followed by a relative path. What really limits a WhatsApp conversation is the level, your answers on the phone at Ask, and what your computer account can reach.

**Pause now** (Safety) stops SynaBun acting on WhatsApp messages at once; the phone cannot undo a pause made on the computer. Agents may call `POST /api/whatsapp/pause` too — it only lowers privileges.

## Computer use

The Assistant can control this Mac (computer use: mouse, keyboard, apps) from a WhatsApp conversation. It is **off by default**. Settings → Messages → WhatsApp → **Safety** has the switch, **Computer use**. It is changed only there, on this computer: no message, command or code from the phone turns it on or off (`/computer` gets the same refusal as every other settings command).

With the switch on, the level decides:

| Level | Computer use |
|---|---|
| **Read-only** | Off. |
| **Ask on my phone** | **One yes per task.** At Ask every task is already asked where it runs; for a task done on the Mac that question is the one about the Mac too: *"For "Tidy the desktop", want me to do it on your Mac, here with Sonnet? I'll control the screen until this task is done. (yes / no)"*. A plain **yes** from your phone turns computer use on for that task; there is no approval per click and no second question. `no` drops the task. |
| **Autonomous** | Works without asking while Autonomous is enabled, **in a task your own plain message started**. Every other turn asks once on your phone, as at Ask: a turn SynaBun starts itself (an agent's result, a route decision, a follow-up on another model, background work), a turn typed into the conversation on the computer, and a message with forwarded or quoted text or a picture. What started the turn decides, not what was said before it. |

Off as well, whatever the level: while WhatsApp is paused, in a conversation whose brain is Codex or OpenCode (it runs read-only), and when computer use is not set up on this Mac (the *Computer* switch in the Assistant panel runs the one-time setup).

**One yes, and when a second question still appears.** The Assistant is told to route a task that needs the Mac as a *computer* task done here, on its own model. The route card then says in words that the Mac will be controlled, and its yes is both answers: where the task runs and the computer approval for the turn that carries it out. That turn is the one the card was asked in when you answer while the Assistant is still waiting, and otherwise the turn SynaBun starts with your decision. You are asked a second, separate question (*"Want me to control your Mac for this? I'll stop when this task is done. (yes / no)"*) at the first computer action when the card did not say the Mac would be controlled:

- the task was routed as something else (a quick task, research, browsing) and turned out to need the Mac;
- you named another model on the card instead of saying yes ("use Haiku"): the task continues on that model and asks about the Mac there;
- the task went to an agent (agents started from WhatsApp never get computer use);
- the switch, the level or a pause changed between the card and your yes, or you sent another message or `/stop` before the task started: the route may still run, without the Mac;
- more than 10 minutes passed between your yes and the task starting.

The approval is bound to the card you saw: SynaBun records on the card, when it is sent, which option also asks for the Mac, and only a yes from your phone to that option of that card counts. What the Assistant calls the task later, or a card sent again, changes nothing. A decided Mac route is carried out in a turn of its own: anything else waiting for the Assistant (another decided route, an agent's result) is read in the next turn, without the approval. In SynaBun on the computer the same card carries a line under its summary ("Asked from WhatsApp: on the phone, a yes to “Do it here with Sonnet” also lets the assistant control this Mac for the task. Approved here, it only decides where the task runs; the phone is then asked about the Mac."): approving it there approves the route alone, and the separate question then goes to your phone.

**What "task" means.** A task is the **turn that carries it out**: your message and what the Assistant does until it answers it (or, when you answer a card after that turn ended, the turn SynaBun starts with your decision). The yes covers every computer action of that turn and ends with it. It is never stored and never carried into another turn: your next message, a turn that reads an agent's result, a follow-up on another model and another conversation each ask again.

**Who can grant it.** Only you, from your phone: a plain yes you typed, aimed at that request while it is open ([Questions and approvals](#questions-and-approvals)). A reply that quotes another message, a forwarded message, a picture and anything that says more than yes grant nothing: the request closes without a grant and your message goes on as the next prompt. A request raised while a newer message of yours is already waiting closes unseen. **A request you have not received cannot be answered**: until its message is delivered to WhatsApp (a slow or throttled send, the outbox), anything you send closes it without a grant and goes on as a new prompt; this holds for every kind of request, not only this one. In SynaBun on the computer the request shows as a card you can **deny**; it has no Allow button, and an "allow" sent over the Assistant socket or the REST API is refused (`COMPUTER_PHONE_ONLY`) and leaves the request open. After 10 minutes without an answer it is declined.

**What ends it.** Computer use stops, the action in progress is aborted and the desktop is released when:

- the task (the turn) ends;
- you send **another message** from your phone while an approved task runs: the approval ends at once, before that message is queued; the task goes on without the Mac and your message is delivered after it as before. (A task that runs unasked at Autonomous holds no approval to end: it keeps running, and `/stop` stops it.)
- you send `/stop`, or press Stop in SynaBun;
- WhatsApp is paused (`/pause`, **Pause now**, an agent's pause);
- the level changes;
- the switch is turned off;
- WhatsApp is turned off on this computer (`enabled: false`, which also stops the connector); turned on again, the switch applies to new tasks as before;
- the conversation is rotated or replaced (`/new`, the daily or idle rotation): an earlier conversation never controls the Mac again;
- SynaBun shuts down;
- someone stops it at the Mac: `Esc`, the pointer in the top-left corner, or the red *Stop* button. The phone is told in one line ("Computer control was stopped on your Mac: I am no longer controlling it."), and computer use stays latched off until *Resume* is pressed on the computer, as for any other session.

**What "stopped" covers.** Every computer action is admitted once and then fenced: it is checked again when its turn in the execution queue comes and before each command it sends to the helper, and it is bound to the turn it was admitted in. When control ends, actions still waiting are answered `CONTROL_ENDED` (or `STOPPED_BY_USER`) and never reach the helper, the helper's command in flight is aborted, and held mouse buttons and keys are released before the desktop is released. What can still complete: the one helper command that was already executing at that instant, when it is past its last abort check (for example a click that was already posted, or an accessibility action after its element reads). No further command follows it.

**What does not change.** Every guard of computer use applies to a WhatsApp conversation exactly as on the computer: blocked apps (password managers, terminals, web browsers), protected windows, password fields, the locked screen, the pause while you use the mouse or keyboard, one controller at a time, the rate limit. The Assistant is told to describe what it did and what is on screen (a screenshot you ask for as a file is sent with `whatsapp_send_file`: [Sending files](#sending-files)), to stop and say so when the screen is locked or asleep, and never to unlock it or type passwords or codes. Agents started from WhatsApp never get computer use, at any level: only the Assistant's own computer tools are covered. The desktop audit log records, for every action of a WhatsApp conversation, that it came from WhatsApp and whether it ran unasked (Autonomous) or under an approved task.

**In the Assistant panel.** The *Computer* switch of a WhatsApp conversation shows what is in effect and says why in its tooltip ("Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety", "Asks on your phone once per task", "On while Autonomous is active", "Off: WhatsApp is paused"). It is not a per-conversation switch there: clicking it, the *Computer use* item of the panel's menu and `/computer` explain instead of toggling.

**How the one yes is bound.** The router (`lib/assistant-router.js`, `computerConsent`) marks a card when it is made: a WhatsApp session whose decision is "after approval", task class `computer`, and the option a plain yes approves is a direct target on the brain's own model with no continuation. The mark (`request.computer.optionId`) is stored with the card and is what the phone and the desktop render the sentence from. On an approval of that option the router tells the runtime (`computerApproved`), which takes it only when the card was bound when it was sent, the answer came from the owner's phone or the desktop (never the REST route, never the model), the decision is still "ask" and has not changed since the card went out, and no newer prompt, Stop or stop at the Mac came in between. It then approves the running turn, or keeps the yes for the one mailbox turn that executes that route (a turn that carries nothing else).

**Unlinking, pausing, a bridge that goes away.** If WhatsApp is unlinked (or its bridge is dropped for any other reason) while a task controls the Mac, control ends first: an open request closes without a grant, the action in flight is aborted, held buttons and keys are released and the desktop is freed. Only then is the bridge dropped. A pause does the same. A task that had the Mac at that moment is done with it: resuming, or linking again, does not give it back to that task and does not ask again for it. Your next message starts afresh.

**What a program running as you on this Mac can and cannot do.** SynaBun's local routes trust a caller on this machine that sends the page's headers (`lib/http-guards.js`): that is the app-wide trust model, not something this feature changes. So a local process can turn the **Computer use** switch on or off through `PUT /api/whatsapp/config`, pause WhatsApp, deny a pending request over the Assistant socket, and approve a route card there (the route only). It cannot grant computer use for a WhatsApp task: neither the request nor the Mac part of a route card is granted by a socket or REST answer, only by the bridge's match on a message from the linked owner's phone. Inside SynaBun's own process the same holds: what grants is a private capability the bridge alone holds (handed to it once, when it is built; a rebuilt bridge gets a fresh one and the old one stops working), not the label `whatsapp` on an answer, which is only what the audit records. At Ask, a switch turned on by such a process therefore still needs your yes on the phone for every task; at Autonomous (which itself needs the ALLOW code from your phone) it would let your own plain messages use the Mac unasked. A process that can already run as you can of course act on the Mac without SynaBun.

**How it is enforced.** `remoteComputerUse` in `lib/remote-policy.js` is the one place that decides (off, after approval, or allowed, with the reason), from the switch, the effective level, pause, the turn's trust, the brain and the desktop's setup. The runtime, the Claude brain's PreToolUse hook, the desktop gate, the persona and the panel all ask it. The layers stay independent: the brain is built with a desktop grant only when the decision is not "off", that grant is **held** (it resolves to nothing) except while a turn runs that may use the computer, the hook refuses, asks or allows each call, and the desktop service asks the runtime again at every action. A Codex or OpenCode host is refused at the gate.

## Commands

| Command | |
|---|---|
| `/status` | what SynaBun is doing, its spend and level |
| `/stop` | stop the current task, its agents and anything waiting for your answer |
| `/new` | start a fresh conversation |
| `/pause` | stop acting on messages until `/resume` |
| `/resume` | act on messages again (not after a pause from the computer) |
| `/cards` | ask again what is still waiting for your answer |
| `/help` | the list |
| `//text` | send text that starts with a slash |

`/status` includes session spend as `Spend: $spent of the $amount budget`, or `Spend: $spent (no limit)`. The session total includes the brain and agents; a metered brain is called out separately. The saved budget is changed in the Assistant UI.

Levels, models and settings never change from the phone (`/level`, `/model`, `/config`, `/allow` … get a fixed refusal).

## Questions and approvals

On WhatsApp the Assistant talks like a person in a chat. There are no numbered cards and no "reply 1/2/3".

**Questions.** The Assistant asks in its reply, in plain words, and ends its turn; your next message is the answer. Its persona says so for this channel (`lib/assistant-persona.js`, "Channel: WhatsApp"), over any other rule about asking, the user's own global rule "ask with AskUserQuestion, never as plain text" included. `agent_clarify` raises no card for a WhatsApp conversation: it tells the brain to ask in text (`CLARIFY_TEXT_ONLY`). If a brain still raises a question control (AskUserQuestion, the `choice` tool, a worker's question), the phone gets it as one plain message with the options inside the sentence: "Which database? Postgres or SQLite, or tell me something else." Whatever you write is the answer: an option's name becomes that option, anything else goes as typed. Several questions go out in one message and one reply settles them all. "skip" declines.

**Approvals** read like a person asking, and take a plain yes or no:

| Asked | Example | What answers it |
|---|---|---|
| A tool | "I need your OK to run this: Bash: `npm test` OK to go ahead? (yes / no)" | `yes` allows once; `no` denies (`no, use staging` denies with that note) |
| Where a task runs | "For "Fix the login test", want me to hand it to Opus? (yes / no) I could also do it here with Sonnet or use Haiku: just name it." | `yes` approves the first proposal; the name of another model it offered picks that one (`haiku`, `use haiku`, `no, use haiku`); `no` declines |
| A plan | "Here's my plan: … Shall I go ahead? (yes / no, or tell me what to change)" | `yes` approves; `no` keeps planning |
| Where a Mac task runs (Ask, with the switch on) | "For "Tidy the desktop", want me to do it on your Mac, here with Sonnet? I'll control the screen until this task is done. (yes / no) I could also use Haiku: just name it. Then I ask about the Mac separately." | `yes` approves the task here **and** computer use for it (one yes); a named model picks that model only; `no` declines. See [Computer use](#computer-use) |
| Controlling the Mac, asked on its own | "Want me to control your Mac for this? I'll stop when this task is done. (yes / no)" | `yes` turns computer use on for this task (this turn); `no` keeps it off for the rest of it. Asked only when the route question did not already cover the Mac |
| A worker's request | "One of the agents needs your OK to run this: …" | as for a tool |

**Who else can answer a worker's request.** You, in SynaBun on the computer, always. The Assistant itself (its `agent_send` reply) only for workers its own conversation started (`403 RUN_NOT_IN_SESSION` for another conversation's worker) and only when the level lets it: with *strict worker approvals* on and below Autonomous it is refused (`403 HUMAN_APPROVAL_REQUIRED`) and the answer is yours alone; with the setting off (the default) it may answer at Ask, where its `agent_send` call is itself asked on your phone first, and at Autonomous, where nothing is asked. At Read-only no worker runs.

A tool approval still shows the whole request exactly as it runs, every argument in a code span, never shortened. If it cannot be shown that way it stays on the computer, and the phone can only deny it: requests over 600 characters, multi-line ones, ones with hidden characters or a backtick, file-change approvals, input to a running command, a computer tool card (the one request to control the Mac above is the phone's to answer; a single click or keystroke never is), and everything at the Read-only level. "Always allow" and remembered routes are never offered on the phone. Below Autonomous the route question is asked for every task (`clampRouteMode`): it is the human approval of that dispatch.

**Any message carries the conversation on.** While something waits for you, a message that clearly answers it answers it. Anything else is never told to "answer first" and never waits behind it:

- A pending **question** takes your typed text as its answer, so the Assistant reads it as the reply and carries on in the same turn. A voice note does not answer it: the question closes without an answer and the transcript goes in as your next message.
- A pending **approval** (tool, route, plan, a worker's request) is closed **without being granted**: denied or cancelled, never approved. Your message then goes to the Assistant as the next prompt, and it answers that. The brain is told you wrote something else and to end its turn with no text unless it has a result to report; what it still tries to ask in that turn closes the same way, unseen.
- **The closing text of that turn is never dropped.** Whatever the brain still says when it ends the turn is sent to you as it is, whatever its length, before the answer to your new message: a short result such as "Tests passed: 48/48. Upgrade skipped." arrives. A turn that ends with nothing to say sends nothing (no "Done.").
- **A request that appears after you already sent a message.** If a message of yours is already on its way when the Assistant raises a question or an approval (it waits for the running turn to end, or it is still being gathered with other quick messages in the 1.5-second window), the request closes at once and is never shown to you: an approval is denied, a question is cancelled, and your message goes in as the next prompt as soon as that turn ends. What you wrote before a request existed is never taken as its answer, not even a `yes`. A question about where a task runs closes the same way, inside its own send: the Assistant hears at once that you wrote something else (it does not wait for a choice that will never come), and a worker that would have waited for that choice is refused instead of being left waiting (`ROUTE_CANCELLED`: nothing stays "waiting for a model choice"). A worker's own request is still shown: it holds no turn, so no message waits behind it.
- Several things pending at once: all of them close the same way. Nothing can deadlock. Only the current conversation's requests close: a late request from a worker of an earlier conversation (before `/new` or a rotation) stays open, is shown when its turn comes and is still yours to answer.
- A message sent while the Assistant is working (nothing waiting for you) goes in as soon as that turn ends; messages that wait together go in as one prompt. A turn whose end never arrives is let go after 20 seconds of silence by a queue watch, without you having to write again.

**What grants an approval, and what never does.** An approval is granted only by a deterministic match in the bridge (`lib/whatsapp/cards.js`) on a message the owner typed: `yes` (also `y`, `ok`, `okay`, `sure`, `go ahead`, `do it`, `sim`, 👍 and a few more) as the *whole* message, or for a route the name of an offered model. Never by the model, and never by a message that merely contains a yes ("yes but only the tests" approves nothing and becomes the next prompt). A forwarded message, a picture, a voice note ([its transcript](#voice-notes) is an ordinary message) and `//text` are never an answer. When more than one request is open, or right after the desktop answered one, a yes must carry the request's 3-letter code ("yes K7Q"); a no needs none.

**A reply that quotes a message is aimed at that message.** Quoting the request itself answers that request, while it is open, and needs no code. Quoting anything else never answers a request that is open: an earlier request that is closed ("use Opus" quoting an old route question does not pick Opus on a newer one), one of the Assistant's ordinary messages (a `yes` to a question it asked in plain text does not approve a tool or a worker that happens to be waiting), or a message SynaBun does not know. What is open then closes without a grant and your message goes on as the next prompt, with the quoted text as context. A reply that is nothing but an answer (`yes`, `no`, `skip`, a bare option number) and quotes a request which is already closed gets "Already answered in SynaBun." and changes nothing. A reply that says more ("1. Explain the command first", "no, use staging instead") is a new message like any other, whatever it quotes: what is open closes without a grant and it goes on as the next prompt. The `ALLOW 1234` flow for Autonomous and the permission levels are separate from all this and unchanged.

**On the desktop** the same card locks as "Answered on WhatsApp" whichever way it closed (`control_resolved` with origin `whatsapp`). If the desktop answers first, a late bare `yes` / `no` from the phone gets "Already answered in SynaBun."; a message that says more is your next message. The same holds when the two answers cross (yours was already on its way when the desktop's won): the first one decides, yours grants nothing, and if it said more than a bare answer ("use Opus") it goes on as your next message. Requests the phone never saw (a turn typed on the desktop, or one raised before the link restarted) do not hold a phone message either: they are denied and the message goes on.

## Chat while work runs

A WhatsApp conversation never sits waiting for workers. The Assistant dispatches, says in one line what it started and ends its turn; you keep chatting and get answers. When a worker finishes, asks something or fails, the result reaches the Assistant as a mailbox event after the current turn, and its report is forwarded to the phone as an *Update* (or as the reply, when you had just approved that task). Results are never merged into the reply to another message.

Two things hold this, besides the persona: `agent_wait` returns after one second for a WhatsApp conversation (`lib/assistant-api.js`), with what is already done and a note telling the brain to end its turn because the result arrives as a mailbox event; desktop sessions wait as they asked. And a message that arrives while a turn runs is delivered when that turn ends, for every brain (Claude, Codex, OpenCode). Adding a message to a turn that is still running is not done: the Claude CLI could take it, but the bridge would have to tell a merged turn from a queued one, and the route gate resets on every prompt.

**A task continued on another model answers you here.** When the router moves your task to another model in the same conversation (a route it chose by itself, a remembered route, or a model you named on a card), the Assistant first says so in one line and ends its turn; the turn that does the task on the new model follows, and its answer is the reply to your message, sent once, whether or not *Forward background results* is on. The runtime marks that turn before any of its output (`synabun.continuation`, with where the prompt it continues came from), and it stays a turn SynaBun starts itself, not a new message of yours: what it may do is decided as for any such turn (at Autonomous it asks once on your phone before it uses the Mac; its questions and approvals reach your phone and take your answer). A task you typed into the conversation on the computer keeps its continuation on the computer, as before.

## The model

Conversation → **Model** decides which brain (provider, model, effort) runs the WhatsApp conversation.

- **Same as the Assistant** (default): the brain the Assistant panel last used, read when a conversation starts and when this setting changes. The panel picking another model later does not move a conversation that is under way.
- **A model**: the picker is the Assistant panel's own: the same catalog (models you switched off in the Assistant's Models list are not offered), the same per-model effort list, the same names. A model from Codex or OpenCode is listed too, with the note that the conversation then runs Read-only (above).

The choice is stored in the WhatsApp settings (`brain`: `null` or `{ provider, model, effort }`) with the same versioned write as the other settings, and checked on the server against the Assistant's catalog before it is stored: an unknown provider, a model the catalog does not list or that is switched off, or an effort the model does not run is a `400`; without a catalog the answer is `503`. Nothing unchecked is stored.

A change applies **from your next message**, with nothing else to do: the bridge switches the session's brain before that turn (`runtime.updateSession`, what the panel's own model switch calls). Another model or effort of the same provider keeps the provider's conversation; another provider starts its own context inside the same SynaBun conversation, as on the desktop. A stored choice that is switched off or removed later falls back to **Same as the Assistant**, and the tab says why under the selector.

## Conversation settings

| Setting | Values (default first) |
|---|---|
| Model | Same as the Assistant · any model the Assistant's picker offers, with its effort ([The model](#the-model)) |
| Progress updates | Key moments · Off · Everything |
| Forward background results | On · Off (an agent's result while you are away; at most 6 an hour) |
| Reply label | `SynaBun:` in Message yourself, none for a second number; up to 24 characters |
| Long answers | Up to 3 messages · 1 · up to 5 (3,500 characters each; the rest stays in SynaBun) |
| Fresh conversation | After 6 idle hours · every day at 04:00 · never |
| In "Message yourself" | Every message · only messages that start with `sb ` / `sb:` (commands, ALLOW and replies to SynaBun always pass; a voice note when you say "sb" first: [Voice notes](#voice-notes)) |
| Transcribe voice notes | On · Off: turned into text on this computer ([Voice notes](#voice-notes)); the line under the switch says whether this computer can, or what is missing |

**Open conversation** closes Settings and opens the WhatsApp conversation in the Assistant panel; **Start a fresh conversation** is the desktop's `/new`.

Fixed limits: text, pictures (4 per message, 5 MB each) and voice notes ([transcribed on this computer](#voice-notes), up to 10 minutes and 20 MB each; video, documents and stickers are not read yet), 20 messages a minute and 300 a day. Messages that wait for a running turn are merged into one prompt (up to 12,000 characters and 4 pictures; past that, 5 prompts can wait in line).

**While SynaBun is off.** WhatsApp holds what you send while SynaBun (or the computer) is off and delivers it when SynaBun reconnects. Held messages younger than 24 hours pass the same owner checks as live ones; those sent in the last 10 minutes are answered, older ones are skipped with one note ("I was offline and skipped N older messages; resend what you still need."), and skipped messages never count against the limits above. Older than 24 hours, other chats, history sync and SynaBun's own echoes are dropped.

**Staying connected.** A linked device stays linked across drops, crashes and restarts of SynaBun: the saved credentials are reused every time, and SynaBun never gives up on its own. A dropped connection is retried after 2, 4, 8, 16, 32, 64, 128 and 256 seconds and then every 5 minutes, each wait ±20% and never above 5 minutes; 10 minutes connected start the ladder over. A connector process that exits is started again after 1, 5, 15 and 60 seconds, then every 5 minutes, and reconnects the link by itself. *Reconnect now* skips the wait. Two kinds of disconnect retry from the longest wait and say so in Settings until the connection has been stable for 10 minutes (until then any other drop waits as long too), with one Activity line per episode: another copy using the same session (`440`, *replaced*), so the two copies do not take the session from each other every few seconds, and an account WhatsApp refuses (`403`, *forbidden*). Only a logout (`401`, removed under Linked devices or too long offline), a session WhatsApp explicitly calls invalid, or a saved session WhatsApp answers with a new QR code needs pairing again (*Link again*). Turning WhatsApp off (`enabled: false`) stops the connector and every retry and ends WhatsApp computer use; turning it on resumes the saved session. A pause does neither: it only stops SynaBun acting on messages. Every disconnect leaves one line in the server log with its code, its reason and what happens next ("recovering automatically", or "link again to pair this device").

**Replies that cannot go out yet.** SynaBun sends at most 10 messages a minute, 120 an hour and 500 a day to keep traffic low; status reactions (👀 ✅ ⏳ ❌ ⏹️) stop three short of each cap, so they never hold a reply back. A reply over the cap waits and goes out when the cap frees up; a reply refused while WhatsApp is reconnecting or the connector is restarting waits for the next connection (up to 20). Two refusals drop the reply instead, and Activity says why: sending paused after an owner anomaly (`PAUSED`), and a connector process of another SynaBun version, stopped until SynaBun restarts (`HELD`: an incompatible IPC protocol, after an update installed while SynaBun ran; an ordinary crash is not `HELD`, the connector restarts and the reply waits). A question or an approval that waited this way is still the same request when it arrives: quoting it answers it. One that closed while it waited (answered on the computer, timed out) is not sent late.

## Voice notes

A voice note, or any audio message, is turned into text **on this computer** and reaches the Assistant like a message you typed, starting with `[Voice note transcript]`. Nothing goes to a transcription service or an API: FFmpeg decodes the note and [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-cli` transcribes it with a model file on this disk. **SynaBun does not ship or download FFmpeg, whisper.cpp or a model**: you install them ([below](#install-whispercpp-ffmpeg-and-a-model)). Until all three are found, the line under *Transcribe voice notes* (Settings → WhatsApp → Conversation) says what is missing and a voice note gets a reply that says why it was not read.

**How it works.** The connector process (the only one that loads Baileys) handles a voice note after the owner and duplicate checks, like any message. Before anything is downloaded it checks that transcription is on, that the engine, the model and FFmpeg are found, and that the note's declared size (20 MB) and length (10 minutes) are within the limits. Then:

1. The note is downloaded (30 s at most) and written to a scratch folder of its own.
2. FFmpeg decodes it to 16 kHz mono PCM: `-nostdin -hide_banner -loglevel error -n -protocol_whitelist file,pipe -format_whitelist ogg,mp3,mov,aac,amr,amrnb,amrwb,wav,matroska,flac -codec_whitelist opus,vorbis,mp3float,mp3,aac,aac_fixed,alac,amrnb,amrwb,flac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw -i file:<note> -vn -t 601 -ac 1 -ar 16000 -f s16le file:<pcm>`, 30 s at most. It reads local files only, only the containers WhatsApp sends audio in and only audio decoders: a forwarded note is third-party data, so playlists, `concat` lists, other formats and other decoders are refused (checked against FFmpeg 9.0.1: ogg, m4a, mp3, wav, webm, ADTS AAC and flac decode, cover art included; AIFF, a `concat` list and an HLS playlist are refused).
3. The decoded length is checked again: over 600 s is too long, whatever the message said about itself (a note without duration metadata included). The PCM gets a WAV header.
4. `whisper-cli -m <model> -f <wav> -l <language> -t <min(8, CPU threads)> -bs 1 -bo 1 -nt -otxt -of <out>` transcribes it, 3 minutes at most. There is no `-ng`: a Metal or CUDA build uses its GPU.
5. `<out>.txt` becomes one line (whitespace collapsed, whisper.cpp's `[BLANK_AUDIO]` dropped); no words is a failure.

Both programs run with `execFile` and `windowsHide`, never through a shell, with a minimal environment (where to look and where temporary files go: no keys, no proxies). A program found on PATH is never one inside SynaBun's own folder, a dependency's `node_modules` or a Windows app alias folder. One note is transcribed at a time; messages you send after a voice note wait until its transcript is ready, so they keep their order. Typed `/stop`, `/pause`, `/status`, `/help` and `/cards` do not wait: they run at once, as commands do (`/resume` and `/new` keep their place, because going ahead of what you sent before them would change what those messages do). What you sent before a `/stop` and arrives after it (the voice note still being transcribed, and what waited behind it) is not acted on, as `/stop` clears what already waits in line; one message says so. What WhatsApp held while SynaBun was offline arrives in order and is not affected. A voice note sent more than 9 minutes ago (held while SynaBun was offline) is not transcribed: the bridge skips messages older than 10 minutes, and the minute between keeps a note from going stale while it is transcribed. Whisper's small model on a recent CPU takes a few seconds for a short note (the reporter measured 4.2 s for 13 s of speech and 7.5 s for 60 s, on a Ryzen 7 5700X without a GPU).

**What the Assistant gets.** `[Voice note transcript] <transcript>`, then a line break and the caption when there is one, cut at 8,192 characters with the transcript first. A forwarded voice note stays forwarded: the Assistant reads it as untrusted data, like a forwarded text, and a reply that quotes something keeps its quote. Speech recognition gets words wrong at times ("Amanhã" came out as "Há manhã" in one report): set `transcriptionLanguage` to the language you speak, and read back anything that matters.

**A voice note approves nothing.** Its transcript is an ordinary message (`voice: true` on the inbound message), so it is never a command (a spoken "/stop" is a message), never the `ALLOW` code, never the answer to an approval or a route question (a spoken "yes" closes the request without a grant and goes on as your next message) and never the answer to a question. Approvals take a typed `yes`. A voice note you record in WhatsApp is your message like a typed one. An audio file you attach instead (`audioFile: true`: music, a meeting, someone else's recording) is treated like a picture: its words may be anyone's, so its turn runs capped at Ask.

**"Only messages that start with sb".** A voice note reaches SynaBun when you say "sb" first (Whisper writes it as "SB", "SB," or "S.B."; the prefix is removed and the marker stays), when its caption starts with `sb`, or when it replies to one of SynaBun's messages. Any other voice note in "Message yourself" is a note to self.

**Privacy.** The note, its PCM and WAV copies and the text file live in a private scratch folder (`<folder>/scratch/vn-*`: 0700, files 0600, one per note) that is removed when the note is done, whatever happened; one a crash left behind is removed when the connector starts again. The transcription folder is outside every backup. No output of FFmpeg or whisper-cli is logged, returned or kept (it can hold the transcript): the server log gets one line naming the step that failed. The transcript is message text: the Activity log keeps it only with *Keep message text in the activity log* on. Once transcribed, the text goes to the Assistant's brain like a typed message, and so to that model's provider, as typed text would.

**When a note is not transcribed** the phone hears why (once per reason every 10 minutes) and a caption still goes on as a message. The reason is `unsupported.reason` of the inbound message (`{ type: 'audio', reason }`):

| Reason | When |
|---|---|
| `transcription_disabled` | *Transcribe voice notes* is off. Nothing is downloaded |
| `transcription_unavailable` | whisper-cli, the model or FFmpeg is not found, or a path set for one does not work. Nothing is downloaded |
| `too_large` | over 20 MB, as declared (nothing downloaded) or as downloaded |
| `too_long` | over 10 minutes, as declared (nothing downloaded) or as decoded |
| `stale` | sent more than 9 minutes ago, while SynaBun was offline. Nothing is downloaded |
| `transcription_failed` | the download, FFmpeg or whisper-cli failed or timed out, a program or the model was gone when it was about to run, or no words came out |

### Install whisper.cpp, FFmpeg and a model

The transcription folder is `DATA_HOME/runtime/whatsapp-transcription/` (`~/.synabun/runtime/whatsapp-transcription` by default; `%APPDATA%\synabun\runtime\whatsapp-transcription` on Windows), next to the connector. SynaBun looks for, in this order:

- **whisper-cli**: the path in `transcriptionEnginePath`; else `<folder>/bin/whisper-cli` (`whisper-cli.exe` on Windows), `<folder>/bin/Release/whisper-cli.exe` (the layout of the official Windows zip), then `whisper-cli` on PATH and, on macOS, in `/opt/homebrew/bin` and `/usr/local/bin` (a server started from the Dock or Finder may not have them on PATH).
- **FFmpeg**: the path in `transcriptionFfmpegPath`; else `<folder>/bin/ffmpeg` (`ffmpeg.exe`), then PATH and the same Homebrew folders.
- **The model**: the path in `transcriptionModelPath`; else `<folder>/ggml-small.bin`.

A path set in the settings is used as it is or not at all: one that does not work makes that part missing and is never replaced by a search. Relative PATH entries and network folders are never searched.

- **macOS**: `brew install whisper-cpp ffmpeg` (Homebrew's whisper-cpp is built with Metal).
- **Windows**: unpack the official Windows zip of a [whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases) into `<folder>\bin`, keeping its `Release` folder with the DLLs beside `whisper-cli.exe`; put `ffmpeg.exe` of an FFmpeg build ([ffmpeg.org](https://ffmpeg.org/download.html) lists them) into `<folder>\bin`, or on PATH.
- **Linux**: your distribution's `ffmpeg` package, and its whisper.cpp package where it has one (the program must be named `whisper-cli`), or build whisper.cpp (`cmake -B build && cmake --build build --config Release`) and copy `build/bin/whisper-cli` into `<folder>/bin`.
- **The model**, on every system: download [`ggml-small.bin`](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin) (multilingual, about 466 MiB) into `<folder>/`. Another ggml model works through `transcriptionModelPath`.

Installed while SynaBun runs: the connector and Settings look again within a minute (turning the switch off and on looks at once). Nothing needs a restart.

### Settings and API

Settings → WhatsApp → Conversation has the switch (*Transcribe voice notes*) and the line under it: "Voice notes are transcribed on this computer.", or "Voice notes: not set up — missing …". The other fields are set with `PUT /api/whatsapp/config`, behind the same guards as the Settings tab (this computer only):

| Field | Default | Values |
|---|---|---|
| `transcriptionEnabled` | `true` | `true` · `false` |
| `transcriptionLanguage` | `'auto'` | `'auto'` (whisper.cpp detects it per note) or a 2-3 letter lowercase code (`en`, `pt`, `yue`) |
| `transcriptionEnginePath` | `''` | `''` (found by itself) or the absolute path of the whisper-cli program |
| `transcriptionModelPath` | `''` | `''` (`<folder>/ggml-small.bin`) or the absolute path of a ggml model |
| `transcriptionFfmpegPath` | `''` | `''` (found by itself) or the absolute path of the ffmpeg program |

A path must be the absolute path of an existing regular file on this computer (links are followed), a program executable (an `.exe` on Windows), the model readable and not empty; it is never a name looked up on PATH. Anything else is `400 CONFIG_INVALID` with `field`. The connector checks the file again right before it runs it. Only the person at this computer sets a path: a service write may clear one but never set it, no phone command touches them, and remote sessions are refused the transcription folder (`lib/remote-policy.js`), so nothing but you chooses what the connector runs. A `PUT` that changes any of these fields re-configures the connector at once. `GET /status` reports `transcription { enabled, available, missing, invalid, language, home }` (`missing` / `invalid`: `engine`, `model`, `ffmpeg`).

## Sending files

Ask for a file and the Assistant sends it to this chat as a real WhatsApp attachment: a document, a photo, a video or an audio file, including images and videos it had a worker generate. It uses the assistant-only MCP tool `whatsapp_send_file({ path, caption?, as? })`, and only when you asked for a file. For generated media it takes the local path from the worker's result (SynaBun keeps those copies in `DATA_HOME/data/media/`). There is no recipient and no session parameter: the file goes to the bound owner, in the WhatsApp conversation whose brain called the tool, and to nobody else.

**Forms.** `as` is `auto` (the default), `document`, `image`, `video` or `audio`:

| Extension | `auto` sends it as | MIME type |
|---|---|---|
| `.jpg` `.jpeg` · `.png` · `.webp` | a photo | `image/jpeg` · `image/png` · `image/webp` |
| `.mp4` | a video | `video/mp4` |
| `.ogg` `.opus` · `.mp3` · `.m4a` | audio (an audio file, not a voice note) | `audio/ogg` · `audio/mpeg` · `audio/mp4` |
| `.pdf` `.md` `.txt` `.csv` `.json` `.patch` `.diff` `.zip` `.7z` `.gz` `.doc` `.docx` `.xls` `.xlsx` `.pptx` `.gif` `.svg` `.wav` `.webm`, anything else | a document, with its name | its type (`application/pdf`, `text/markdown`, …), else `application/octet-stream` |

`document` sends the original file untouched, whatever it is. A native form that does not match the extension (`as: 'image'` for a PDF) is refused: use `auto` or `document`. Photos and videos go without a preview thumbnail: SynaBun never decodes the file it sends (building a video preview would mean running FFmpeg).

**Limits.** A photo, video or audio file over 16 MiB goes as a document instead (`fallback: true` in the answer); nothing over 100 MiB is sent, and that is refused before the file is read. Native audio has no caption: a caption with it is refused, so leave it out or send the file as a document. A caption holds up to 1,024 characters, a path up to 2,048. A file counts against the send limits like a reply (10 a minute, 120 an hour, 500 a day).

**What is refused** (`FILE_FORBIDDEN`), on the path as written **and** on the real file it leads to (links are followed and checked too), on macOS, Linux and Windows:

- the WhatsApp session itself (`DATA_HOME/whatsapp/auth`, wherever `SYNABUN_WHATSAPP_HOME` puts it) and SynaBun's data home (`DATA_HOME` and `~/.synabun`: `data/`, `mcp-data/`, `runtime/`, backups, `.env`, the memory database, the Claude and Codex account folders), except `data/media/`, where the generated images and videos and saved browser screenshots are;
- browser profiles: Chrome, Chromium, Brave, Edge (`Microsoft Edge` on macOS too), Firefox profiles on every system (`logins.json` and `key4.db` are its saved passwords), Safari, Arc, Opera, Vivaldi and anti-detect profiles (MoreLogin), plus their password, cookie and key files by name wherever they are;
- app sign-in stores: Discord, Slack, Telegram Desktop (`tdata`), Signal, WhatsApp Desktop;
- password managers (1Password, Bitwarden, KeePass `*.kdbx`), `~/Library/Keychains`, GNOME Keyring and KWallet, Windows Credential Manager (with its DPAPI keys and the Vault), the Mail and Messages stores and Thunderbird;
- shell histories (`.zsh_history`, `.bash_history`, fish's history, PowerShell's), `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials` and git's `~/.config/git/credentials`, `.vault-token`, the `.docker`, `.kube`, `.aws`, `.azure`, gcloud, `gh`, `.gnupg` and `.ssh` folders, and CLI token stores (cargo, gem, Pulumi, Hugging Face, Kaggle, rclone, hub, glab, doctl, Stripe, Fly, cloudflared, OCI, Databricks);
- key and certificate files anywhere (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `*.p8`, SSH `id_*` keys), `.env` files and their variants, terraform state;
- AI tool configuration and credentials: `~/.claude.json`, `~/.claude*`, `~/.codex*`, OpenCode's configuration, its database (`opencode.db`, where OpenCode 2 keeps credentials) and the `auth.json` OpenCode 1 kept, GitHub Copilot's tokens, `.cursor/mcp.json`, `claude_desktop_config.json`, `mcp-api-key` and `.synabun-api-key` files;
- copies of those places' secret parts wherever they are (a backup disk, Time Machine): `.synabun/whatsapp`, `mcp-data`, `runtime` and `backups`, `sidepanel-configs`, `.claude/settings*.json` and `.claude/projects`, `.codex*/config.toml`, `sessions` and `history.jsonl`; and SynaBun's own backup archives (`synabun-<kind>-<timestamp>.zip`, `synabun-auto-backup.zip`) by their name, in whatever folder the backups go to.

The list is explicit (`neural-interface/lib/whatsapp/local-file.js`, `DENYLIST`) and matched without regard to letter case. The protected folders (the session, the data home, `~/.claude*`, `~/.codex*`) are also recognized by what they are on disk, their device and inode, so another spelling of the same folder is refused like the usual one: macOS reaches every folder of the data volume under `/System/Volumes/Data/…` too, which `realpath` keeps. On Windows a name is also checked as Windows opens it, without trailing dots and spaces (`.ssh.\id_rsa` is `.ssh\id_rsa`). **The content of a file is never inspected**: a secret inside an ordinary file with an ordinary name is sent like any other file, so ask only for what you mean to receive. Keynote presentations share the `.key` extension with private keys and are refused too: export them to PDF first.

Also refused: a URL, a network share or device path (`\\server\share`, `//server`, `\\?\…`), the system's own namespaces (`/dev`, where `/dev/fd/3` would be the connector's own open file, `/proc`, `/sys`, and macOS's `/.vol`, `/.nofollow`, `/.resolve`, which open any file under another name), a link or a mapped drive that leads to a share or to one of them, and, on Windows, an alternate data stream (`file.txt:stream`), all `FILE_FORBIDDEN`; a relative path or one with a control character (`BAD_REQUEST`); a folder, a missing or unreadable file, an empty file, anything but a regular file (a FIFO, a device) and a file that changes while it is read (`FILE_INVALID`); a file with more than one hard link (`FILE_FORBIDDEN`: its other names cannot be checked against the list).

**How it is read.** In the connector process, in the file's turn of the send queue, right before it goes out: the request is checked, the path resolved, both checked against the list and the protected folders by device and inode, the file opened without following a link (`O_NOFOLLOW` where the system has it, `O_NONBLOCK` so a FIFO swapped in cannot hang it) and compared with what the checks saw (device, inode, size; its real path unchanged and still naming that very file, so a parent folder swapped for a link and back is caught; on Linux the open file's own name is checked against the list too), read to its end and not one byte further, and checked again when the read ends. The owner the request was accepted for must still be the owner before the read (`NO_OWNER`), and the connection must not change while the file is read (`NOT_CONNECTED`): a disconnect, another owner or a pause while the file is read sends nothing. A reconnect while the file waits its turn is no change of owner: like a text reply, it goes on the new link.

**When it is refused.** The answer names the file and the reason (`…/.ssh/id_ed25519 is protected (credentials (SSH, GnuPG, cloud, registry and git logins)): SynaBun never sends it from WhatsApp`), so the Assistant can tell you why; numbers, JIDs and credentials in the path are redacted.

**Who may send.** Only the active WhatsApp conversation's own Assistant brain, at any level (Read-only included) and on any brain (Claude, Codex or OpenCode). Delivering a file you asked for is a reply, like the final text: it needs no route of its own, is never asked on the phone at Ask, and works in plan mode and on the read-only Codex and OpenCode brains. It grants nothing else: no file edits, no computer use, no worker permissions. The brain proves who it is with a credential SynaBun makes for each brain launch of a WhatsApp conversation and gives only to that brain's SynaBun MCP server, through the environment of the brain's own process, never a command line or a file: the Claude CLI expands it into its MCP header, Codex forwards it to its MCP child by name, OpenCode's serve fills it into its MCP entry. The `X-Synabun-Role` and `X-Synabun-Terminal` headers, which any local program can send, prove nothing here. A worker, a desktop chat and an earlier WhatsApp conversation are refused (`403`), and so is any request while WhatsApp is off, paused or not connected (`409`). See [SECURITY.md](../SECURITY.md).

**When the answer is uncertain.** The send is exactly one request, never retried by SynaBun or by the Assistant. A success (`{ ok, id, type, mimetype, size, fileName, path, fallback }`, `path` the canonical one) means WhatsApp took the file. A timeout (the connector gives a file 120 seconds, the tool 130; each brain's MCP client waits longer: Codex and OpenCode 180 seconds), a connector that stops during the send, or an answer lost on the way back (a reset connection) answers with `uncertain: true`: the file may or may not have arrived, and the Assistant says so instead of sending it again. Ask again if it did not arrive. `UNREACHABLE` (nothing listening for the request) means nothing was sent.

**What is kept.** Every real send attempt leaves one line in the server log with the canonical path, the size, the form and the masked chat (`[whatsapp] file send {"path":…,"size":…,"chat":"••••1234","type":"document"}`), never the bytes or the caption; numbers and JIDs in the path are redacted. Activity records each outcome with the path and the size, or the refusal's code; for a refusal the path is the Assistant's own text, so long key-like runs in it are masked too (`[key]`).

## Security model

**Transport.** Baileys runs only in a forked child process (`lib/whatsapp/host.js`) with an allow-listed environment (no API keys) and redacted output. The main process never loads Baileys and never sees a phone number or JID: events carry masked numbers (`••••1234`) at most. The host's only send call addresses the bound owner; no operation takes an address.

**Owner binding.** Only the owner is answered: in Message yourself, your own chat after you confirmed the account; in second-number mode, the account that sent the claim code. Everything else is dropped by the host and only counted (*Ignored* in Activity).

**Sending files.** `POST /api/assistant/whatsapp/send-file` sits outside `/api/whatsapp` and has its own guards: no invite guests, no tunnel or proxy headers, a loopback socket, a localhost `Host` on SynaBun's port, a JSON body of `path`, `caption` and `as` only, and the calling brain's credential (`X-Synabun-Brain-Token`), compared in constant time ([Sending files](#sending-files)).

**The HTTP API** (`/api/whatsapp`, `lib/http-guards.js`):

- every route: no invite guests (`GUEST_FORBIDDEN`), no tunnel or proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-*`, `forwarded`, `x-real-ip`, `via` → `REMOTE_FORBIDDEN`), a loopback socket only (`LOCAL_ONLY`, read from `req.socket.remoteAddress`, never `X-Forwarded-For`), a `Host` of `localhost` / `127.0.0.1` / `[::1]` on SynaBun's port (`BAD_HOST`, DNS rebinding), `Cache-Control: no-store`;
- every state-changing route: an `Origin` of exactly that host and port (`BAD_ORIGIN`; `null` refused), `Sec-Fetch-Site: same-origin` when present (`CROSS_SITE`), a JSON body (`415`), `X-SynaBun-UI: 1` (`UI_HEADER_REQUIRED`), and no agent header (`X-Synabun-Desktop-Grant`, `-Terminal`, `-Role`, `-Assistant` → `UI_ONLY`) — except `POST /pause`;
- no CORS headers, ever: a cross-site page can't send JSON or the custom header without a preflight that is never answered.

App-wide, every WebSocket upgrade (`/ws/*`) must carry no `Origin` or this server's own one (`isAllowedWebSocketOrigin`), and "its own" counts only for a Host that is one of SynaBun's names (`isAllowedHost`: `localhost`, `*.localhost`, loopback and other IP addresses, this machine's name and `<name>.local`, the tunnel and invite-proxy hosts). So neither a page on another site nor a DNS-rebound page can open SynaBun's sockets. See SECURITY.md.

**Secrets travel one path each.** The link QR and pairing code go only down the NDJSON response of the tab that started linking; the claim code and its wa.me link only down the claim stream; the ALLOW code only in the `PUT /config` answer. Sync broadcasts (`whatsapp:status`) carry the state machine and counters, never a QR, SVG, code, number, name or message text — tabs re-read the masked `GET /status`.

**What stays on this computer**

| What | Where |
|---|---|
| WhatsApp session keys | `DATA_HOME/whatsapp/auth/` (`%LOCALAPPDATA%\synabun\whatsapp` on Windows; `SYNABUN_WHATSAPP_HOME` overrides): outside every folder a backup copies (`data/`, `mcp-data/`, the skills / agents / skins roots), so backups never copy a live session. On macOS and Linux the folder must be yours at 0700 and its files at 0600, or the store does not open (`AUTH_PERMS`) |
| The connector | `DATA_HOME/runtime/whatsapp/` |
| Voice notes | `DATA_HOME/runtime/whatsapp-transcription/`: whisper.cpp, FFmpeg and the model you put there, and `scratch/`, which holds a note only while it is transcribed |
| Activity log | `DATA_HOME/data/logs/whatsapp-YYYYMMDD.log`, mode 0600, deleted after 7 days |
| Settings | kv_config row `whatsapp_config` in the SynaBun database |
| The conversation | an ordinary Assistant session ("WhatsApp · Sep 28") |

**Never stored:** phone numbers (settings and logs hold the last four digits at most), other chats, QR payloads, pairing or claim codes, the `ALLOW` code, and message text, unless you turn on *Keep message text in the activity log*. An `ALLOW 1234` answer is consumed before anything is logged, even with that setting on. Every log line passes through `redactWa`, which covers numbers, JIDs, QR payloads, codes (`ALLOW <code>` too), key material and credentials.

**What gets installed.** `baileys` (MIT) pinned to 7.0.0-rc14 (older versions are deprecated for CVE-2026-48063), installed on demand with `npm ci --omit=dev --omit=optional --ignore-scripts --legacy-peer-deps` from the integrity-pinned lockfile in `neural-interface/lib/whatsapp/connector/` into its own folder. The lockfile ships as `npm-shrinkwrap.json` (npm never publishes a file named `package-lock.json` inside a package) and is copied into the install folder as `package-lock.json`, which `npm ci` reads. Its dependencies include `libsignal` (GPL-3.0). None of it is in a SynaBun `package.json`, it is never bundled, and it runs as a separate process that SynaBun talks to over IPC — the GPL boundary. **Remove connector** deletes it (only after unlinking).

**Unofficial.** WhatsApp's Help Center warns that unofficial apps "may result in a temporary or permanent account ban". SynaBun keeps traffic low (no online presence on connect, no delivery receipts, one reply stream to one person), but the risk is not zero; the second-number mode keeps it off your own account. A linked device can see every chat of the account: SynaBun receives them from WhatsApp and ignores them.

## Unlink and remove

- **Unlink** logs SynaBun out of WhatsApp (the device disappears from Linked devices), deletes the session keys and resets the conversation pointer, owner, pause and autonomous mode (Autonomous goes back to Ask).
- **Remove WhatsApp from SynaBun** also removes the connector and the activity log and resets every WhatsApp setting; tick *Also delete the WhatsApp conversation* to delete the Assistant conversation too.
- **Lost your phone?** Press **Pause now**, or on any device open WhatsApp → Settings → Linked devices → SynaBun → **Log out**.
- Uninstalling SynaBun does **not** unlink WhatsApp: unlink first, or log it out from the phone.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Linking fails at once | WhatsApp allows 4 linked devices; remove one under Linked devices. |
| "The code expired" | The QR changes every ~20 s and the whole link gives up after 5 minutes. Keep the Linked devices screen open, press *Show a new code*. |
| No notification for replies | Normal in Message yourself; use a second number for notifications. |
| Messages from WhatsApp Web / Desktop get no answer | In Message yourself only messages typed on the phone count. |
| "Logged out from the phone" | Removed under Linked devices, or the phone was offline for 14 days (WhatsApp then logs out every linked device). *Link again*. |
| "WhatsApp refused this account" | WhatsApp blocked linking for that account; check the WhatsApp app. |
| "The saved WhatsApp session is invalid" | WhatsApp rejected this device's session (`badSession`), or answered the saved session with a new QR code. Automatic retries cannot repair the credentials: *Link again* to pair the device. |
| Stuck on "Reconnecting" | SynaBun retries indefinitely with exponential backoff and jitter, capped at 5 minutes, also after connector crashes; *Reconnect now* skips the wait. Saved credentials are reused after a restart. Only a logout (401), an explicitly invalid session, or a rejected saved session needs pairing again. Disabling WhatsApp (`enabled: false`) stops the recovery. Check the computer's internet if it never comes back. |
| "Another copy is using this WhatsApp session" (while reconnecting) | Another SynaBun, or another program with a copy of the same session, connected with it (`440`). SynaBun retries every 5 minutes so the two copies do not keep taking the session from each other; close the other copy, or unlink and link again. The note goes once the connection has been stable for 10 minutes. |
| "WhatsApp refused this account; it may be restricted or banned" (while reconnecting) | WhatsApp refuses the account (`403`). The link stays and SynaBun retries every 5 minutes; check WhatsApp on the phone. The note goes once the connection has been stable for 10 minutes. |
| "The WhatsApp connector does not match this SynaBun version" (`HOST_HELD`) | The connector process speaks another IPC protocol than the running server, after an update installed while SynaBun ran. Restart SynaBun. A connector that merely crashes is restarted by itself and never shows this. |
| Install failed | The message names the cause (`NPM_NOT_FOUND`, `OFFLINE`, `REGISTRY_REFUSED`, `DISK_FULL`, `NO_PERMISSION`, `FILE_IN_USE`, `TIMEOUT`, `VERIFY_FAILED`); *Try again*. |
| "SynaBun could not make the WhatsApp session files private" (`AUTH_PERMS`) | The session folder or its files are not yours, or cannot be set to 700 / 600 (a shared or network drive, another user's files). Fix the permissions of the folder shown under Data & privacy, then *Reconnect*. |
| Replies say the conversation "runs read-only because its brain is Codex / OpenCode" | Ask and Autonomous need a Claude brain: pick a Claude model under Conversation → Model. It applies from your next message. |
| "…is switched off in the Assistant's Models list, so WhatsApp runs on the same brain as the Assistant" | The model chosen for WhatsApp was disabled (or its provider no longer lists it). Pick another under Conversation → Model, or switch it back on in the Assistant's Models list. |
| I answered something else and the approval was denied | By design: only a plain `yes` approves. Ask again, or say what you want; the Assistant asks again when it needs the approval. |
| I replied `yes` to an older message and the approval was denied | A reply that quotes a message answers only that message. Quote the request itself, or send `yes` without quoting anything. |
| The Assistant never asked, but says it could not run something | You had already sent another message when it wanted to ask, so the request was closed without a grant and your message went first. Ask again when you want it. |
| The tab says WhatsApp is turned off | `SYNABUN_WHATSAPP=off` is set in SynaBun's environment. |
| Voice notes get "I can't transcribe voice notes yet" | This computer lacks whisper.cpp, its model or FFmpeg; the line under *Transcribe voice notes* says which. Install them ([Voice notes](#install-whispercpp-ffmpeg-and-a-model)); SynaBun notices within a minute. A path set in the settings that stopped working counts as missing. |
| A voice note "was not transcribed" | Over 10 minutes or 20 MB, or FFmpeg / whisper-cli failed (the server log names the step, never the words). Try a shorter note, or type it. |
| I said "yes" in a voice note and the approval was denied | By design: a voice note is an ordinary message and approves nothing. Type `yes`. |
| Voice notes in "Message yourself" get no answer | With *Only messages that start with sb*, say "sb" first, give the note an `sb` caption, or reply to one of SynaBun's messages. |
| "…is protected: SynaBun never sends it from WhatsApp" (`FILE_FORBIDDEN`) | The file is in a place SynaBun never sends from, or links to one ([Sending files](#sending-files)). Copy what you want to share into an ordinary folder, or send it from the computer. |
| "The file may or may not have arrived" | The send timed out or the connector stopped during it. SynaBun does not send it again by itself; check the chat and ask again if it is missing. |
| "SynaBun is not reachable: nothing was sent" (`UNREACHABLE`) | The brain's MCP server could not reach SynaBun at all, so the file was not sent. Check that SynaBun is running, then ask again. |
| Transcripts get words wrong | Set `transcriptionLanguage` to the language you speak (`auto` guesses per note), or point `transcriptionModelPath` at a larger ggml model. |

**Not the same as the WhatsApp browser tools.** The `browser_whatsapp` tool group (`browser_extract_wa_chats`, `browser_extract_wa_messages`) lets agents read WhatsApp Web in SynaBun's browser. The WhatsApp Link is you chatting with SynaBun from your phone. They share nothing.

## Environment

| Variable | Effect |
|---|---|
| `SYNABUN_WHATSAPP=off` | Kill switch: the tab reports `unavailable`, nothing is built or started. |
| `SYNABUN_WHATSAPP_FAKE=1` | Fake transport for tests and demos (below). |
| `SYNABUN_WHATSAPP_HOME` | Where the session keys live. Refused, with a warning in the server log, inside any folder a backup copies (`data/`, `mcp-data/`, the skills / agents / skins roots). |
| `SYNABUN_WHATSAPP_HOST=inproc` | Run the host inside the server process (tests / kill switch for the fork). |

## API reference

`POST /api/assistant/whatsapp/send-file` is the `whatsapp_send_file` tool's route (see [Sending files](#sending-files)).

Base path `/api/whatsapp`. Errors are `{ ok: false, code, error, field? }` with the status shown; `429` adds `retryAfterMs` and `Retry-After`, `409 VERSION_CONFLICT` adds `version`.

| Route | Body | Answer |
|---|---|---|
| `GET /status` | — | The state machine and masked data: `state` (`unavailable` +`reason` (`env`: `SYNABUN_WHATSAPP=off`; `starting`: the server is still starting the Assistant; `error`: the WhatsApp Link failed to load), `not_installed`, `installing` +`stage`, `install_failed` +`code`, `ready`, `linking` +`method` `phase` (`starting`/`waiting`/`scanned`), `link_expired`, `confirm_owner` +`kind` (`self`/`code`), `connected`, `reconnecting`, `paused`, `logged_out` +`reason` (`removed`/`inactive`/`banned`/`invalid_session`), `error` +`code`), `warning` (`replaced` (440) / `forbidden` (403) while the link retries one of them, until 10 minutes connected; else `null`), `mode`, `level`, `levelExpiresAt` (always `null`: Autonomous has no time limit; kept for older readers), `paused`, `pausedBy`, `computerUse` (the [Computer use](#computer-use) switch), `connector {installed, version, pinned, outdated, stage, errorCode}`, `account {masked, name}`, `owner {masked, boundAt}`, `confirm {kind, expiresAt, attemptsLeft}`, `session {id, title}`, `brainLimit {provider, label, text}` (the conversation's brain makes it read-only), `brainChoice {choice, source: 'assistant'\|'choice', effective {provider, providerLabel, model, modelLabel, effort}, fallback {reason: 'disabled'\|'unknown', provider, model}, readOnly {provider, label}, checked}` (the model selector), `connection {attempt, nextRetryAt}` (the next reconnect, or the next connector start while it is down), `host {state, restarts, retryInMs}`, `transcription {enabled, available, missing, invalid, language, home}` ([Voice notes](#voice-notes)), `counters`, `config`, `version`, `escalation`, `manualCommand`, `paths`. The `whatsapp:status` broadcast carries states, counters, `warning`, `brain` (the stored choice: ids only) and `transcription {enabled, available}` |
| `POST /setup` | `{ mode: 'self'\|'dedicated', method: 'qr'\|'code', phone? }` | Records the intent (never the number), installs if needed. `{ ok, next: 'install'\|'link'\|'none', status }` — the tab then opens `/link` |
| `POST /connector/install` | `{ update?, reinstall? }` | Starts an install (`409 INSTALL_BUSY`); progress in `/status` |
| `DELETE /connector/install` | `{}` | Cancels a running install |
| `DELETE /connector` | `{}` | Removes the connector (`409 STILL_LINKED` while linked) |
| `GET /connector/log` | `?limit=` | `{ lines }` (redacted) |
| `POST /link` | `{ method, phone? }` | **NDJSON** to this client only: `{type:'state', state:'linking', phase, method}`, `{type:'qr', svg, expiresAt}`, `{type:'pairing_code', code, expiresAt}`, `{type:'linked', mode}`, `{type:'error', code}`, `{type:'state', state:'link_expired'}`. Closing it cancels linking. One at a time (`409 LINK_BUSY`); `400 BAD_PHONE` with `field:'phone'`; `409 ALREADY_LINKED`, `NOT_INSTALLED` |
| `POST /owner/confirm` | `{ accept: boolean }` | Self mode: confirm the linked account, or log it out |
| `POST /owner/claim` | `{}` | **NDJSON**: `{type:'claim', code, sendTo (masked), waMeUrl, qrSvg, expiresAt, attemptsLeft}`, then `{type:'claim', attemptsLeft}` updates, `{type:'bound', masked}` or `{type:'expired'}`. Closing it cancels the claim |
| `DELETE /owner` | `{}` | Second-number mode: forget the owner, then claim again (`409 WRONG_MODE` in Message yourself) |
| `POST /test` | `{}` | Sends "SynaBun test message. If you can read this, WhatsApp is working." (`429 RATE_LIMITED`, `409 NOT_CONNECTED`) |
| `POST /pause` | `{}` | Pause (agents allowed: JSON body required, no Origin/UI header) |
| `POST /resume`, `/reconnect`, `/unlink` | `{}` | |
| `POST /remove` | `{ deleteConversation? }` | Unlink, uninstall, clear the log and every setting |
| `GET /config` · `PUT /config` | `{ config: {…}, expectedVersion, confirmEscalation? }` | User fields: `enabled`, `level`, `progress`, `forwardBackground`, `replyLabel`, `maxMessages`, `rotation`, `selfTrigger`, `activityText`, `strictWorkerApprovals`, `computerUse` (a boolean, off by default: [Computer use](#computer-use)), `brain` (`null` = same as the Assistant, or `{ provider, model, effort }`: checked against the Assistant's catalog, `400 CONFIG_INVALID {field:'brain'}` for an unknown or disabled model or an effort it does not run, `503 CATALOG_UNAVAILABLE` when it cannot be checked), `transcriptionEnabled`, `transcriptionLanguage`, `transcriptionEnginePath`, `transcriptionModelPath`, `transcriptionFfmpegPath` ([Voice notes](#settings-and-api): a path is checked on disk, a change re-configures the connector at once). `400 CONFIG_INVALID {field}` (service-owned fields included), `409 VERSION_CONFLICT`, `400 CONFIRM_REQUIRED`, `409 PHONE_REQUIRED`; raising to Autonomous answers `pending: { code, expiresAt, attemptsLeft }` |
| `GET /activity` · `DELETE /activity` | `?limit=` | The latest rows (`{at, kind, detail, text?}`) and counters; clear |
| `POST /session/new` | `{}` | A fresh WhatsApp conversation |
| `POST /__fake` | `{ action, … }` | Only with `SYNABUN_WHATSAPP_FAKE=1` (404 otherwise) |

## Fake mode (testing)

`SYNABUN_WHATSAPP_FAKE=1` replaces Baileys with `lib/whatsapp/fake-baileys.js`: the connector reports installed without downloading anything, and Settings shows a **Simulated phone** section. `POST /api/whatsapp/__fake` (same guards as the UI) plays the phone:

| action | |
|---|---|
| `scan` | the phone scans the QR / accepts the code |
| `inbound` | `{ from: 'owner'\|'stranger', text, forwarded?, offline?, ageMs? }` — a message from you (your own chat in self mode) or from a stranger (ignored); `offline: true` delivers it the way WhatsApp hands over what it held while SynaBun was off, sent `ageMs` ago |
| `drop` | the connection drops (reconnect) |
| `logout` | the phone logs SynaBun out |
| `ban` | WhatsApp refuses the account (`403`: the link retries every 5 minutes and Settings shows the warning) |
| `crash` | the connector process crashes (it is started again and reconnects, however often it crashes) |
| `state` | nothing; every answer includes `sent` (what SynaBun sent, without addresses) and `status` |

The `inbound` action sends text. Voice notes are played in process: `fake.inbound({ audio: { data, seconds, fileLength, fail, hang } })` of `fake-baileys.js`, with a stand-in transcriber in the host (`hostOptions.transcriber` of the inproc manager).

Tests use fakes throughout, a temporary data home and `SYNABUN_TYPESAFE=off`; they are not published with this repository.

## Integration (server.js)

The feature modules are self-contained; `neural-interface/server.js` wires them:

- `app.use('/api/whatsapp', …)` is mounted synchronously, before the Assistant boots: until the service exists, `GET /status` answers `{ state: 'unavailable', reason: 'starting' }` (or `env` with the kill switch, `error` after a failed load) and every other route `503`. No compression middleware runs on the app, so the NDJSON streams flush as written.
- `startWhatsAppLink()` runs at the end of the Assistant block: a guarded dynamic import of `lib/whatsapp/service.js`, then `createWhatsAppService({ dataHome, port, getRuntime, getDispatcher, getKvConfig, setKvConfig, broadcastSync, isGuestRequest, log, getDefaultBrain, getCatalog })` (`getDefaultBrain`: the panel's last-used brain; `getCatalog`: the Assistant's model catalog, which the WhatsApp model choice is checked against) and `start()`. `getDefaultBrain` reads the Assistant panel's last-used brain (`neural-assistant-brain` in `ui-state.json`). A failure leaves the tab `unavailable`; it never takes the server down. The bridge, the runtime, the dispatcher and the API share the process-wide remote-policy registry (`defaultRemotePolicyRegistry`).
- `'/api/whatsapp'` is on the admin-only prefixes; `'whatsapp:'` broadcasts go to owner sockets only.
- `await whatsapp.shutdown({ timeoutMs: 1500 })` in graceful shutdown (before the terminal host and the database close); `whatsapp.killNow()` in the synchronous exit handler.
- The WebSocket upgrade Origin check (`lib/http-guards.js`), app-wide.
- Project Nayuki's QR Code generator (MIT, `neural-interface/lib/whatsapp/vendor/qrcodegen.js`) is listed in THIRD-PARTY-LICENSES.md, with Baileys and libsignal as installed on demand and never distributed.

End to end, the tests run the real service, manager, host core, bridge and Assistant runtime over the fake socket, and check the cross-codebase rules: one send call site, Baileys only through the adapter, the npm tarball, the wiring above.
