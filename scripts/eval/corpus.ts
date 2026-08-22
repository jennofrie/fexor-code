import type { EvalTask } from "./types.js";

const packageJson = `${JSON.stringify(
  {
    name: "fexor-eval-task",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  },
  null,
  2
)}\n`;

const rustGitignore = "/target\nCargo.lock\n";

function task(
  definition: Omit<EvalTask, "allowedPathPrefixes"> & {
    allowedPathPrefixes?: string[];
  }
): EvalTask {
  return {
    ...definition,
    allowedPathPrefixes: definition.allowedPathPrefixes ?? [
      "src/",
      "test/",
      "tests/",
      "package.json",
      "Cargo.toml",
      "Cargo.lock",
    ],
  };
}

export const EVAL_CORPUS: EvalTask[] = [
  task({
    id: "backend-pagination-boundary",
    family: "backend",
    complexity: "simple",
    prompt:
      "Fix the pagination helper. The public API is 1-indexed and must reject invalid page inputs without regressing normal pages.",
    files: {
      "package.json": packageJson,
      "src/server/pagination.ts": `export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize
  return items.slice(start, start + pageSize)
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/pagination.ts",
        exportName: "paginate",
        cases: [
          { args: [[1, 2, 3, 4, 5], 1, 2], expected: [1, 2] },
          { args: [[1, 2, 3, 4, 5], 3, 2], expected: [5] },
          { args: [[1, 2], 0, 2], throwsIncludes: "page" },
          { args: [[1, 2], 1, 0], throwsIncludes: "pageSize" },
        ],
      },
    ],
  }),
  task({
    id: "backend-response-shape",
    family: "backend",
    complexity: "simple",
    prompt:
      "Repair the API success envelope so consumers receive the documented stable response shape, including request correlation.",
    files: {
      "package.json": packageJson,
      "src/server/response.ts": `export function success<T>(data: T, requestId: string) {
  return { ok: true, data }
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/response.ts",
        exportName: "success",
        cases: [
          {
            args: [{ id: 7 }, "req-123"],
            expected: { ok: true, data: { id: 7 }, requestId: "req-123" },
          },
        ],
      },
    ],
  }),
  task({
    id: "backend-idempotent-create",
    family: "backend",
    complexity: "medium",
    prompt:
      "Make createUser idempotent by normalized email. Repeating the same logical request must not create a duplicate or change the original ID.",
    files: {
      "package.json": packageJson,
      "src/server/users.ts": `type User = { id: number; email: string }
const users: User[] = []

export function resetUsers(): void { users.length = 0 }

export function createUser(email: string): { created: boolean; user: User } {
  const user = { id: users.length + 1, email }
  users.push(user)
  return { created: true, user }
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/users.ts",
        exportName: "createUser",
        cases: [
          {
            args: [" Person@Example.com "],
            expected: {
              created: true,
              user: { id: 1, email: "person@example.com" },
            },
          },
          {
            args: ["person@example.com"],
            expected: {
              created: false,
              user: { id: 1, email: "person@example.com" },
            },
          },
        ],
      },
    ],
  }),
  task({
    id: "backend-query-limit",
    family: "backend",
    complexity: "medium",
    prompt:
      "Fix parseLimit for an HTTP query parameter. Accept integers 1..100, default only when absent, and reject malformed or out-of-range values.",
    files: {
      "package.json": packageJson,
      "src/server/query.ts": `export function parseLimit(raw?: string): number {
  return Math.min(100, Number(raw) || 20)
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/query.ts",
        exportName: "parseLimit",
        cases: [
          { args: [], expected: 20 },
          { args: ["1"], expected: 1 },
          { args: ["100"], expected: 100 },
          { args: ["0"], throwsIncludes: "limit" },
          { args: ["2.5"], throwsIncludes: "limit" },
          { args: ["wat"], throwsIncludes: "limit" },
          { args: ["101"], throwsIncludes: "limit" },
        ],
      },
    ],
  }),
  task({
    id: "backend-expiry-boundary",
    family: "backend",
    complexity: "medium",
    prompt:
      "Correct the cache expiry boundary. An entry is fresh strictly before expiresAt and expired at or after that instant.",
    files: {
      "package.json": packageJson,
      "src/server/cache.ts": `export function isFresh(now: number, expiresAt: number): boolean {
  return now <= expiresAt
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/cache.ts",
        exportName: "isFresh",
        cases: [
          { args: [99, 100], expected: true },
          { args: [100, 100], expected: false },
          { args: [101, 100], expected: false },
        ],
      },
    ],
  }),
  task({
    id: "backend-error-mapping",
    family: "backend",
    complexity: "complex",
    prompt:
      "Fix HTTP error mapping without leaking internal messages: JSON syntax errors are 400, explicitly coded errors retain safe status, and unknown errors are generic 500.",
    files: {
      "package.json": packageJson,
      "src/server/errors.ts": `export function toHttpError(error: unknown): { status: number; body: { error: string } } {
  return { status: 500, body: { error: String(error) } }
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/server/errors.ts",
        exportName: "toHttpError",
        cases: [
          {
            args: [new SyntaxError("Unexpected token secret-data")],
            expected: { status: 400, body: { error: "Invalid JSON" } },
          },
          {
            args: [{ status: 404, message: "Not found" }],
            expected: { status: 404, body: { error: "Not found" } },
          },
          {
            args: [new Error("database password leaked")],
            expected: { status: 500, body: { error: "Internal server error" } },
          },
        ],
      },
    ],
  }),
  task({
    id: "frontend-menu-state",
    family: "frontend",
    complexity: "simple",
    prompt:
      "Fix the mobile menu state transition and its accessibility attribute. The returned ariaExpanded string must describe the new state.",
    files: {
      "package.json": packageJson,
      "index.html":
        '<button id="menu" aria-expanded="false">Menu</button><script type="module" src="/src/menu.ts"></script>\n',
      "src/menu.ts": `export function toggleMenu(open: boolean) {
  return { open: !open, ariaExpanded: String(open) }
}
`,
    },
    judge: [
      {
        kind: "file-contains",
        path: "index.html",
        values: ['aria-expanded="false"', 'src="/src/menu.ts"'],
      },
      {
        kind: "module-cases",
        modulePath: "src/menu.ts",
        exportName: "toggleMenu",
        cases: [
          { args: [false], expected: { open: true, ariaExpanded: "true" } },
          { args: [true], expected: { open: false, ariaExpanded: "false" } },
        ],
      },
    ],
  }),
  task({
    id: "frontend-form-normalization",
    family: "frontend",
    complexity: "medium",
    prompt:
      "Repair contact-form normalization. Trim name/email, lowercase email, and reject blank names or invalid email forms before submission.",
    files: {
      "package.json": packageJson,
      "index.html":
        '<form id="contact"><input name="name"><input name="email" type="email"></form>\n',
      "src/form.ts": `export function normalizeContact(name: string, email: string) {
  return { name, email, valid: name.length > 0 && email.includes('@') }
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/form.ts",
        exportName: "normalizeContact",
        cases: [
          {
            args: [" Ada ", " ADA@EXAMPLE.COM "],
            expected: { name: "Ada", email: "ada@example.com", valid: true },
          },
          {
            args: ["   ", "a@example.com"],
            expected: { name: "", email: "a@example.com", valid: false },
          },
          {
            args: ["Ada", "@bad"],
            expected: { name: "Ada", email: "@bad", valid: false },
          },
          {
            args: ["Ada", "bad@"],
            expected: { name: "Ada", email: "bad@", valid: false },
          },
        ],
      },
    ],
  }),
  task({
    id: "frontend-theme-fallback",
    family: "frontend",
    complexity: "medium",
    prompt:
      "Fix theme resolution. Only persisted light/dark values are valid; otherwise use the system preference and always return light or dark.",
    files: {
      "package.json": packageJson,
      "src/theme.ts": `export function resolveTheme(saved: string | null, systemDark: boolean): string {
  return saved || (systemDark ? 'dark' : 'light')
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/theme.ts",
        exportName: "resolveTheme",
        cases: [
          { args: ["light", true], expected: "light" },
          { args: ["dark", false], expected: "dark" },
          { args: ["sepia", true], expected: "dark" },
          { args: ["", false], expected: "light" },
          { args: [null, true], expected: "dark" },
        ],
      },
    ],
  }),
  task({
    id: "frontend-search-url",
    family: "frontend",
    complexity: "simple",
    prompt:
      "Fix search URL construction so arbitrary Unicode and reserved characters round-trip as one q query parameter.",
    files: {
      "package.json": packageJson,
      "src/search.ts": `export function searchHref(query: string): string {
  return '/search?q=' + query
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/search.ts",
        exportName: "searchHref",
        cases: [
          { args: ["hello world"], expected: "/search?q=hello%20world" },
          { args: ["a&admin=true"], expected: "/search?q=a%26admin%3Dtrue" },
          { args: ["雪"], expected: "/search?q=%E9%9B%AA" },
        ],
      },
    ],
  }),
  task({
    id: "frontend-base-path-assets",
    family: "frontend",
    complexity: "medium",
    prompt:
      "Fix assetUrl for sites deployed below a base path. Normalize duplicate slashes but never discard the configured base segment.",
    files: {
      "package.json": packageJson,
      "src/assets.ts": `export function assetUrl(base: string, asset: string): string {
  return '/' + asset.replace(/^\\/+/, '')
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/assets.ts",
        exportName: "assetUrl",
        cases: [
          {
            args: ["/docs/", "/images/logo.svg"],
            expected: "/docs/images/logo.svg",
          },
          { args: ["/", "app.js"], expected: "/app.js" },
          {
            args: ["/portal", "css/site.css"],
            expected: "/portal/css/site.css",
          },
        ],
      },
    ],
  }),
  task({
    id: "frontend-active-navigation",
    family: "frontend",
    complexity: "complex",
    prompt:
      "Correct active-navigation matching. A section matches its exact path or a slash-delimited descendant, never a lookalike prefix.",
    files: {
      "package.json": packageJson,
      "src/navigation.ts": `export function isActive(current: string, href: string): boolean {
  return current.startsWith(href)
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/navigation.ts",
        exportName: "isActive",
        cases: [
          { args: ["/docs", "/docs"], expected: true },
          { args: ["/docs/api", "/docs"], expected: true },
          { args: ["/docs2", "/docs"], expected: false },
          { args: ["/documentation", "/docs"], expected: false },
          { args: ["/", "/"], expected: true },
          { args: ["/about", "/"], expected: false },
        ],
      },
    ],
  }),
  task({
    id: "cli-invalid-exit-code",
    family: "cli",
    complexity: "medium",
    prompt:
      "Fix the CLI contract: --help exits 0 on stdout; unknown flags exit 2 with a concise stderr diagnostic.",
    files: {
      "package.json": packageJson,
      "src/cli.ts": `const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.error('usage: widget [--help]')
  process.exit(1)
}
if (args.some(arg => arg.startsWith('-'))) {
  console.log('unknown option')
  process.exit(1)
}
console.log('ok')
`,
    },
    judge: [
      {
        kind: "cli-cases",
        entryPath: "src/cli.ts",
        cases: [
          { args: ["--help"], exitCode: 0, stdout: "usage: widget [--help]" },
          { args: ["--wat"], exitCode: 2, stderrIncludes: "unknown option" },
        ],
      },
    ],
  }),
  task({
    id: "cli-zero-boundary",
    family: "cli",
    complexity: "simple",
    prompt:
      "Fix --count parsing. Zero is valid, positive integers are valid, and missing values default to one; malformed or negative values must fail.",
    files: {
      "package.json": packageJson,
      "src/count.ts": `export function parseCount(value?: string): number {
  return Number(value) || 1
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/count.ts",
        exportName: "parseCount",
        cases: [
          { args: [], expected: 1 },
          { args: ["0"], expected: 0 },
          { args: ["12"], expected: 12 },
          { args: ["-1"], throwsIncludes: "count" },
          { args: ["2.2"], throwsIncludes: "count" },
          { args: ["nope"], throwsIncludes: "count" },
        ],
      },
    ],
  }),
  task({
    id: "cli-unicode-width",
    family: "cli",
    complexity: "medium",
    prompt:
      "Fix displayWidth so CLI truncation counts Unicode code points rather than UTF-8 bytes. Combining behavior is out of scope.",
    files: {
      "package.json": packageJson,
      "src/width.ts": `export function displayWidth(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/width.ts",
        exportName: "displayWidth",
        cases: [
          { args: ["abc"], expected: 3 },
          { args: ["雪"], expected: 1 },
          { args: ["A🙂B"], expected: 3 },
          { args: [""], expected: 0 },
        ],
      },
    ],
  }),
  task({
    id: "refactor-stable-unique",
    family: "refactor",
    complexity: "medium",
    prompt:
      "Refactor uniqueNames without changing its public API. Remove duplicates while preserving first-seen order and exact casing.",
    files: {
      "package.json": packageJson,
      "src/names.ts": `export function uniqueNames(values: string[]): string[] {
  return [...new Set(values)].sort()
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/names.ts",
        exportName: "uniqueNames",
        cases: [
          { args: [["b", "a", "b", "C", "a"]], expected: ["b", "a", "C"] },
          { args: [[]], expected: [] },
        ],
      },
    ],
  }),
  task({
    id: "refactor-order-contract",
    family: "refactor",
    complexity: "complex",
    prompt:
      "Refactor formatUsers for clarity while preserving caller order. Do not sort or mutate the input array.",
    files: {
      "package.json": packageJson,
      "src/formatUsers.ts": `type User = { id: number; name: string }
export function formatUsers(users: User[]): string[] {
  return users.sort((a, b) => a.id - b.id).map(user => user.name.trim())
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/formatUsers.ts",
        exportName: "formatUsers",
        cases: [
          {
            args: [
              [
                { id: 2, name: " second " },
                { id: 1, name: " first " },
              ],
            ],
            expected: ["second", "first"],
            expectedArgsAfter: [
              [
                { id: 2, name: " second " },
                { id: 1, name: " first " },
              ],
            ],
          },
        ],
      },
    ],
  }),
  task({
    id: "refactor-export-surface",
    family: "refactor",
    complexity: "complex",
    prompt:
      "Complete the parser refactor without breaking the documented parseAccountId named export. It must trim and accept only positive integer IDs.",
    files: {
      "package.json": packageJson,
      "src/account.ts": `export function parseAccountIdV2(raw: string): number {
  return Number.parseInt(raw, 10)
}
`,
    },
    judge: [
      {
        kind: "module-exports",
        modulePath: "src/account.ts",
        exports: ["parseAccountId"],
      },
      {
        kind: "module-cases",
        modulePath: "src/account.ts",
        exportName: "parseAccountId",
        cases: [
          { args: [" 42 "], expected: 42 },
          { args: ["0"], throwsIncludes: "account" },
          { args: ["12x"], throwsIncludes: "account" },
        ],
      },
    ],
  }),
  task({
    id: "malformed-json-object",
    family: "malformed-input",
    complexity: "medium",
    prompt:
      "Harden parseObjectBody. It must accept a JSON object only and reject malformed JSON, null, arrays, and primitive values with a stable Invalid JSON body error.",
    files: {
      "package.json": packageJson,
      "src/body.ts": `export function parseObjectBody(raw: string): Record<string, unknown> {
  return JSON.parse(raw)
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/body.ts",
        exportName: "parseObjectBody",
        cases: [
          { args: ['{"a":1}'], expected: { a: 1 } },
          { args: ["null"], throwsIncludes: "Invalid JSON body" },
          { args: ["[]"], throwsIncludes: "Invalid JSON body" },
          { args: ['"x"'], throwsIncludes: "Invalid JSON body" },
          { args: ["{"], throwsIncludes: "Invalid JSON body" },
        ],
      },
    ],
  }),
  task({
    id: "malformed-csv-quotes",
    family: "malformed-input",
    complexity: "complex",
    prompt:
      "Fix parseCsvLine for one RFC4180-style row: quoted commas and doubled quotes must parse; an unclosed quote must throw.",
    files: {
      "package.json": packageJson,
      "src/csv.ts": `export function parseCsvLine(line: string): string[] {
  return line.split(',')
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/csv.ts",
        exportName: "parseCsvLine",
        cases: [
          { args: ["a,b,c"], expected: ["a", "b", "c"] },
          { args: ['a,"b,c",d'], expected: ["a", "b,c", "d"] },
          { args: ['"say ""hi""",x'], expected: ['say "hi"', "x"] },
          { args: ['a,"broken'], throwsIncludes: "quote" },
        ],
      },
    ],
  }),
  task({
    id: "malformed-port",
    family: "malformed-input",
    complexity: "simple",
    prompt:
      "Harden parsePort. Accept decimal integers 1..65535 only; reject whitespace-only, fractions, Infinity, trailing text, zero, and overflow.",
    files: {
      "package.json": packageJson,
      "src/port.ts": `export function parsePort(raw: string): number {
  return Number(raw)
}
`,
    },
    judge: [
      {
        kind: "module-cases",
        modulePath: "src/port.ts",
        exportName: "parsePort",
        cases: [
          { args: ["1"], expected: 1 },
          { args: ["65535"], expected: 65535 },
          { args: ["0"], throwsIncludes: "port" },
          { args: ["65536"], throwsIncludes: "port" },
          { args: ["2.5"], throwsIncludes: "port" },
          { args: ["Infinity"], throwsIncludes: "port" },
          { args: ["12x"], throwsIncludes: "port" },
          { args: ["   "], throwsIncludes: "port" },
        ],
      },
    ],
  }),
  task({
    id: "rust-rename-all-references",
    family: "rust-lsp",
    complexity: "medium",
    prompt:
      "Fix rename_symbol so every exact identifier reference is renamed while longer identifiers and string contents are left alone. Use code intelligence if available.",
    files: {
      ".gitignore": rustGitignore,
      "Cargo.toml":
        '[package]\nname = "rename_eval"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": `pub fn rename_symbol(source: &str, from: &str, to: &str) -> String {
    source.replacen(from, to, 1)
}
`,
    },
    judge: [
      {
        kind: "rust-tests",
        modulePath: "src/lib.rs",
        testSource: `
#[test]
fn renames_identifier_references_only() {
    let source = "let item = 1; let item_count = item + 1; println!(\\\"item\\\");";
    assert_eq!(candidate::rename_symbol(source, "item", "value"), "let value = 1; let item_count = value + 1; println!(\\\"item\\\");");
}
`,
      },
    ],
  }),
  task({
    id: "rust-utf8-prefix",
    family: "rust-lsp",
    complexity: "complex",
    prompt:
      "Fix safe_prefix so max_chars is a character count, Unicode never panics, and requesting more characters returns the whole string. Use LSP navigation if available.",
    files: {
      ".gitignore": rustGitignore,
      "Cargo.toml":
        '[package]\nname = "prefix_eval"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": `pub fn safe_prefix(value: &str, max_chars: usize) -> &str {
    &value[..max_chars.min(value.len())]
}
`,
    },
    judge: [
      {
        kind: "rust-tests",
        modulePath: "src/lib.rs",
        testSource: `
#[test]
fn handles_unicode_boundaries() {
    assert_eq!(candidate::safe_prefix("a雪🙂z", 0), "");
    assert_eq!(candidate::safe_prefix("a雪🙂z", 2), "a雪");
    assert_eq!(candidate::safe_prefix("a雪🙂z", 99), "a雪🙂z");
}
`,
      },
    ],
  }),
  task({
    id: "rust-saturating-decrement",
    family: "rust-lsp",
    complexity: "simple",
    prompt:
      "Fix decrement_retry so it never underflows and otherwise decrements exactly once. Use find-references before changing the public function if LSP is available.",
    files: {
      ".gitignore": rustGitignore,
      "Cargo.toml":
        '[package]\nname = "retry_eval"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": `pub fn decrement_retry(remaining: u32) -> u32 {
    remaining - 1
}
`,
    },
    judge: [
      {
        kind: "rust-tests",
        modulePath: "src/lib.rs",
        testSource: `
#[test]
fn saturates_at_zero() {
    assert_eq!(candidate::decrement_retry(0), 0);
    assert_eq!(candidate::decrement_retry(1), 0);
    assert_eq!(candidate::decrement_retry(u32::MAX), u32::MAX - 1);
}
`,
      },
    ],
  }),
];

export function getEvalTask(taskId: string): EvalTask {
  const result = EVAL_CORPUS.find((task) => task.id === taskId);
  if (!result) throw new Error(`Unknown evaluation task: ${taskId}`);
  return result;
}
