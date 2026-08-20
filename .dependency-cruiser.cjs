/**
 * dependency-cruiser config for Fexor Code (v17 — pinned for Node 25 compat).
 *
 * Phase 0 status: machinery installed + no-cycles rule active (report-only).
 * The four deep-module boundary rules from setup-ts-deep-modules are STUBBED
 * below — they get filled in during Phase 1, after /improve-codebase-architecture
 * identifies the real module seams. Fexor Code currently has a flat src/ layout
 * (no src/packages/), so freezing boundary rules before designing them would
 * do violence to the codebase. Run: `bun run lint:boundaries`.
 *
 * Note: pinned to dependency-cruiser@17 because the system Node is 25 (non-LTS)
 * and v18 gates on Node LTS versions (^22||^24||>=26). Upgrade to v18 when the
 * runtime moves to a supported Node LTS.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "No circular dependencies — cycles are a classic deep-module violation.",
      from: {},
      to: { circular: true },
    },

    // ─── Boundary rules (Phase 1 — to be filled in) ────────────────────────
    // After /improve-codebase-architecture identifies the module seams, add
    // the four deep-module rules from setup-ts-deep-modules targeting the
    // agreed package boundaries. The skill lives at
    // ~/.claude/skills/setup-ts-deep-modules/SKILL.md.
    // ───────────────────────────────────────────────────────────────────────
  ],
  options: {
    doNotFollow: "node_modules",
    exclude: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
