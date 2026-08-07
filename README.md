# pi-plan-mode

A pi extension that adds a structured plan mode with two distinct phases:

1. **Exploration** — Read-only, xhigh thinking. Agent explores code and produces a numbered plan.
2. **Execution** — Full write access, low thinking. Agent implements the plan step-by-step with progress tracking.

By default, plan mode only changes the thinking effort level (xhigh ↔ low) and keeps your session's current model. Use `/plan-settings` to customize per-phase model and effort.

## Quick Start

```bash
# Toggle plan mode during a session
/plan
```

> **Note:** The `--plan` CLI flag is intentionally not registered by this
> extension — it belongs to `@plannotator/pi-extension`, and registering it
> here would conflict at startup.

## Usage

```
/plan          → Enter exploration mode (read-only, xhigh thinking)
                 Ask the agent to analyze code and create a plan.
                 The agent will output a numbered plan under a "Plan:" header.

                 Plan:
                 1. Read config module to understand structure
                 2. Add state machine types
                 3. Implement transition function

/plan again    → Plannotator review (see below), or fallback prompt:
                 Execute / Refine / Stay

  "Execute"     → Switches to execution mode (full tools, low thinking).
                   Agent implements each step, marking progress with [DONE:n] tags.
                   Progress widget shows ☑/☐ completion.

  "Refine"      → Opens an editor. Type feedback, agent re-plans.

  "Stay"        → Keeps exploring. Nothing changes.

Ctrl+Alt+P     → Toggle plan mode (shortcut)
```

## Plannotator integration

When the official [Plannotator](https://github.com/backnotprop/plannotator)
extension is installed alongside this one:

```bash
pi install npm:@plannotator/pi-extension
```

…a drafted plan automatically opens in Plannotator's browser review instead
of the terminal prompt. There you can:

- **Approve** — the plan executes here with the usual progress tracking
- **Approve with notes** — execution begins and your notes are passed to the
  implementing agent
- **Deny with annotations** — your inline comments are sent back to the agent,
  which revises the plan and resubmits it for another review round

If Plannotator is not installed (or fails to respond within 5 seconds), the
classic **Execute / Refine / Stay** TUI prompt appears instead — nothing
changes for users without it.

The integration communicates over pi's shared extension event bus
(`plannotator:request` / `plannotator:review-result`), so there is no npm
dependency on Plannotator itself.

### Disabling the browser review

- Toggle "Plannotator review" off in `/plan-settings`, or
- Set `PI_PLAN_MODE_PLANNOTATOR_REVIEW=0` in your environment.

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
- **Presets** — Save, load, replace, and delete named combinations of the four model/thinking settings

Model selection uses a fuzzy-searchable list — type characters to narrow results. Open **Presets** inside `/plan-settings` to save the current draft under a name, load a saved combination, or delete one. Escape cancels the settings draft; choose **Save and close** to persist changes. Reusing a name asks for confirmation before replacement. If a saved model is no longer available, loading the preset warns you and keeps the current model for that phase while applying the other values. Settings and presets are persisted across all sessions in `~/.pi/agent/extensions/pi-plan-mode/config.json`.

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