# pi-plan-mode

A pi extension that adds a structured plan mode with two distinct phases:

1. **Exploration** — Read-only, xhigh thinking. Agent explores code and produces a numbered plan.
2. **Execution** — Full write access, low thinking. Agent implements the plan step-by-step with progress tracking.

By default, plan mode only changes the thinking effort level (xhigh ↔ low) and keeps your session's current model. Use `/plan-settings` to customize per-phase model and effort.

## Quick Start

```bash
# Start pi in plan mode
pi --plan

# Or toggle plan mode during a session
/plan
```

## Usage

```
/plan          → Enter exploration mode (read-only, xhigh thinking)
                 Ask the agent to analyze code and create a plan.
                 The agent will output a numbered plan under a "Plan:" header.

                 Plan:
                 1. Read config module to understand structure
                 2. Add state machine types
                 3. Implement transition function

/plan again    → Choose: Execute / Refine / Stay

  "Execute"     → Switches to execution mode (full tools, low thinking).
                   Agent implements each step, marking progress with [DONE:n] tags.
                   Progress widget shows ☑/☐ completion.

  "Refine"      → Opens an editor. Type feedback, agent re-plans.

  "Stay"        → Keeps exploring. Nothing changes.

Ctrl+Alt+P     → Toggle plan mode (shortcut)
```

Progress widget during execution:

```
☑ 1. Read config module to understand structure
☑ 2. Add state machine types
☐ 3. Implement transition function
```

Footer: `📋 2/3` while executing, `⏸ plan` while exploring.

## Configuration

Use the `/plan-settings` command to interactively configure plan mode. This opens a menu where you can choose:

- **Plan thinking effort** — Defaults to `xhigh`
- **Plan model** — Defaults to your session's current model
- **Implementation thinking effort** — Defaults to `low`
- **Implementation model** — Defaults to your session's current model

Model selection uses a fuzzy-searchable list — type characters to narrow results. Settings are persisted across all sessions in `~/.pi/extensions/pi-plan-mode/config.json`.

```
/plan-settings
```

## Read-Only Tools

During exploration, only these tools are available:

`read`, `bash`, `grep`, `find`, `ls`, `questionnaire`

Bash is restricted to an allowlist of read-only commands (cat, grep, ls, git status, npm list, etc.). Destructive commands (rm, git push, npm install, etc.) are blocked.

## Installation

```bash
# Local to a project
mkdir -p .pi/extensions/pi-plan-mode
cp -r ./* .pi/extensions/pi-plan-mode/

# Or global
mkdir -p ~/.pi/agent/extensions/pi-plan-mode
cp -r ./* ~/.pi/agent/extensions/pi-plan-mode/
```

## License

MIT