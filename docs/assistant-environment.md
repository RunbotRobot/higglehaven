# Assistant session environment (#3458, part of #3444)

An assistant session talks to shoppers, so it is locked down: it has no repository
and runs only two reviewed programs. This page says how that environment is built.

## What is installed

`scripts/assistant-environment.mjs setup --commit <sha>` prints a bash setup script.
It downloads `assistant-lib.mjs`, `assistant-shift.mjs` and `assistant-reply.mjs`
from the pinned commit on `raw.githubusercontent.com`, checks each against a SHA-256
computed from that commit, and installs them read-only in `/opt/assistant`.
Any download or checksum failure exits non-zero and installs nothing, so the session
does not start. Running it again at the same commit is a no-op. It fits the
environment setup-script field (at most 100 lines of 200 bytes).

The environment's network must allow the host `raw.githubusercontent.com` (plus the
live site). Nothing else is fetched.

To move to a new version: merge the change, run `node scripts/assistant-environment.mjs
setup --commit <merged sha>`, paste the output over the environment's setup script.

## Permission rules

`node scripts/assistant-environment.mjs rules --name <assistant>` prints the settings:
permission mode `default`, with only these commands pre-approved:

- `node /opt/assistant/assistant-shift.mjs --name <name>`
- `node /opt/assistant/assistant-reply.mjs --name <name> <action>:*` for each of
  `reply`, `end`, `escalate`, `handover`, `answer-question`, `escalate-question`.

Everything else asks, and nobody is there to answer, so it does not run.

## The briefing

`node scripts/assistant-environment.mjs briefing --name <assistant>` prints the text the
session is started with: `docs/assistant-runbook.md` from "Who you are" onward, with the
`{{YOUR_COMMANDS}}` marker replaced by that assistant's commands (the shift command and
every reply command, with the path and name fixed exactly as the permission rules have
them, the background time limit for the shift command, what each JSON result means and
the rule for `--text`). Nobody types the commands by hand, and a test checks that the
briefing prints exactly the commands `rules --name <assistant>` pre-approves.

The briefing tells the assistant that the other tools its session shows (files, web,
scheduling, connectors) are locked and must never be called. It does not say it has none:
every cloud session is shown them, and the permission rules above are what stops a call
(the owner accepted the lock in place of "no connectors").

`assistant-reply.mjs` also refuses a `--text` that is not one plain line (letters, digits,
spaces and `. , ; : ! ? ' ( ) / -`, at most 1000 characters), so a stranger's words cannot
become part of a command line even if the session is fooled into copying them.

## Known limits

- A prefix rule lets later flags through. The programs refuse any `--url` other than
  the live site or a local server (`resolveBaseUrl`), so a flag cannot redirect requests.
- Cloud sessions can write files without asking, so a fooled session running as root
  could overwrite its own programs. The setup script restores the pinned files at every
  fresh container, and the files are read-only, but this is not a sandbox.
- The exact rule syntax must be confirmed by higglehaven1's lock probe on #3458 before
  an assistant goes live.
