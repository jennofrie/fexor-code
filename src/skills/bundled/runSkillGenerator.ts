import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_GENERATOR_PROMPT = `# Skill Generator {{userDescriptionBlock}}

You are scaffolding a new reusable skill from the user's description.

## Your Task

### Step 1: Understand the Request

Identify from the user's description (and ask via AskUserQuestion if anything is unclear):
- The skill's purpose and the repeatable process it automates
- A short kebab-case name and one-line description
- The inputs/arguments it needs (if any)
- When it should be invoked (trigger phrases and example user messages)
- Where it should be saved:
  - **This repo** (\`.claude/skills/<name>/SKILL.md\`) — for project-specific workflows
  - **Personal** (\`~/.claude/skills/<name>/SKILL.md\`) — follows the user across all repos

Don't over-ask for simple skills.

### Step 2: Write the SKILL.md

Create the skill directory and file at the chosen location.

Use this format:

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{list of tool permission patterns the skill needs}}
when_to_use: {{when Claude should auto-invoke this skill, including trigger phrases and example user messages}}
argument-hint: "{{hint showing argument placeholders}}"
arguments:
  {{list of argument names}}
context: {{inline or fork -- omit for inline}}
---

# {{Skill Title}}
Description of skill

## Inputs
- \`$arg_name\`: Description of this input

## Goal
Clearly stated goal for this workflow, with defined artifacts or criteria for completion.

## Steps

### 1. Step Name
What to do in this step. Be specific and actionable. Include commands when appropriate.

**Success criteria**: ALWAYS include this — it shows the step is done and we can move on.
\`\`\`

**Frontmatter rules:**
- \`allowed-tools\`: Minimum permissions needed (use patterns like \`Bash(gh:*)\` not \`Bash\`)
- \`context\`: Only set \`context: fork\` for self-contained skills that don't need mid-process user input.
- \`when_to_use\` is CRITICAL — tells the model when to auto-invoke. Start with "Use when..." and include trigger phrases.
- \`arguments\` and \`argument-hint\`: Only include if the skill takes parameters. Use \`$name\` in the body for substitution.

### Step 3: Confirm and Save

Before writing the file, output the complete SKILL.md content as a yaml code block so the user can review it. Then ask for confirmation with AskUserQuestion: "Does this SKILL.md look good to save?"

After writing, tell the user:
- Where the skill was saved
- How to invoke it: \`/{{skill-name}} [arguments]\`
- That they can edit the SKILL.md directly to refine it
`

export function registerRunSkillGeneratorSkill(): void {
  registerBundledSkill({
    name: 'run-skill-generator',
    description:
      'Scaffold a new reusable skill from a prompt describing what you want it to do.',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'AskUserQuestion',
      'Bash(mkdir:*)',
    ],
    userInvocable: true,
    argumentHint: '[description of the skill you want to generate]',
    async getPromptForCommand(args) {
      const userDescriptionBlock = args
        ? `The user described the skill they want as: "${args}"`
        : ''

      const prompt = SKILL_GENERATOR_PROMPT.replace(
        '{{userDescriptionBlock}}',
        userDescriptionBlock,
      )

      return [{ type: 'text', text: prompt }]
    },
  })
}
