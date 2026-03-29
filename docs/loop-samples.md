# Loop Prompt Samples

Practical examples for SynaBun Automation Studio loops. Copy any sample into a new loop, fill in the blanks, and adjust to your needs.

---

## Social Media Engagement

```
Task:

Navigate to [PLATFORM] and interact with posts about [TOPIC].
Find recent threads (last 24-48h) with real engagement.

Rules:

- Do NOT double post. Check if you already replied before commenting
- Reply in the thread's language
- Keep replies short: 2-3 sentences max
- Do not use em-dashes in text
- Like posts you interact with
- Do not interact with your own posts
- [ADD YOUR OWN RULES]

Persona:

- Tone: [casual / professional / witty / technical]
- Language: [English / Portuguese / match thread language]
- When relevant, mention [YOUR PRODUCT/PROJECT] naturally. Do not force it
```

**Settings:** Browser: ON | Iterations: 50 | Max minutes: 120

---

## Web Research

```
Task:

Research [TOPIC] using the browser.
Search for [SPECIFIC QUERIES OR URLS].
Prioritize [blogs / docs / academic papers / forums].

Output: Summarize findings as bullet points per source.
Depth: [surface scan / moderate / deep dive]

MEMORY STORAGE (MANDATORY):
After each iteration, store findings using the SynaBun `remember` tool:
- category: "[YOUR CATEGORY]"
- tags: ["research", "[TOPIC TAG]"]
- importance: 7
- Content: Include the research topic as a header, then findings for that iteration
If the category does not exist, first call `category` with action "create".
Do NOT skip the memory storage step.
```

**Settings:** Browser: ON | Iterations: 8 | Max minutes: 30

---

## Code Maintenance

```
Task:

Scan [DIRECTORY OR FILE PATH] for [bugs / security issues / dead code / TODO comments].
Tech stack: [LANGUAGE / FRAMEWORK].

Focus on:
- [SPECIFIC CONCERN 1]
- [SPECIFIC CONCERN 2]

For each issue found:
1. Describe the problem
2. Show the file and line
3. Suggest a fix

Do NOT apply fixes automatically. Report only.
```

**Settings:** Browser: OFF | Iterations: 10 | Max minutes: 45

---

## Content Posting

```
Task:

Post [CONTENT TYPE] to [PLATFORM] groups/pages about [TOPIC].

Content to share:
[YOUR URL OR MESSAGE]

Rules:

- Post in the group's native language
- Do not double post. Check recent posts before posting
- Join relevant groups if not already a member
- Do not over-use emojis
- [ADD YOUR OWN RULES]
```

**Settings:** Browser: ON | Iterations: 50 | Max minutes: 120

---

## Data Collection

```
Task:

Navigate to [WEBSITE/PLATFORM] and collect [WHAT DATA].
Start at: [STARTING URL]

For each item found, extract:
- [FIELD 1]
- [FIELD 2]
- [FIELD 3]

MEMORY STORAGE (MANDATORY):
After each iteration, store collected data using the SynaBun `remember` tool:
- category: "[YOUR CATEGORY]"
- tags: ["data-collection", "[TAG]"]
- importance: 6
- Content: Structured list of collected items
```

**Settings:** Browser: ON | Iterations: 20 | Max minutes: 60

---

## Monitoring / Health Check

```
Task:

Check [SERVICE/URL/SYSTEM] for [status / errors / changes / new content].

Steps:
1. Navigate to [URL]
2. Check for [CONDITION]
3. If [CONDITION MET]: report details
4. If everything is normal: report OK and move to next check

Alert criteria:
- [WHAT COUNTS AS A PROBLEM]

MEMORY STORAGE:
Only store findings when something noteworthy is detected.
- category: "[YOUR CATEGORY]"
- tags: ["monitoring", "[SERVICE TAG]"]
- importance: 7 for warnings, 9 for critical issues
```

**Settings:** Browser: ON | Iterations: 100 | Max minutes: 480

---

## Tips

- **Browser toggle:** Turn ON for any task that needs to visit websites. Turn OFF for code-only tasks.
- **Iterations:** How many times the loop repeats. Each iteration is one cycle of the task.
- **Max minutes:** Safety limit. The loop stops after this time even if iterations remain.
- **Memory storage:** Adding a `remember` block ensures findings survive across sessions.
- **Rules section:** Higher up = higher priority. Be explicit about what NOT to do.
