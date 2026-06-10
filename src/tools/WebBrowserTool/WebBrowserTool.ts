import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getURLMarkdownContent } from '../WebFetchTool/utils.js'

const WEB_BROWSER_TOOL_NAME = 'WebBrowser'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to open'),
    action: z
      .enum(['read', 'links'])
      .default('read')
      .describe(
        "'read' returns the page text as markdown; 'links' extracts the markdown links found on the page",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string(),
    action: z.enum(['read', 'links']),
    result: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g

function extractLinks(markdown: string): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const m of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const href = m[2]!
    if (seen.has(href)) continue
    seen.add(href)
    const text = m[1]!.trim()
    lines.push(text ? `${text} — ${href}` : href)
  }
  return lines.length > 0 ? lines.join('\n') : 'No links found.'
}

export const WebBrowserTool = buildTool({
  name: WEB_BROWSER_TOOL_NAME,
  searchHint: 'open a web page and read its text or links',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input: Input) {
    return `WebBrowser ${input.action} ${input.url}`
  },
  async description(input) {
    const { url } = input as { url: string }
    try {
      return `Claude wants to open ${new URL(url).hostname}`
    } catch {
      return 'Claude wants to open a web page'
    }
  },
  async prompt() {
    return `Open a web page and read its content. With action 'read' (default) it returns the page rendered as markdown text; with action 'links' it lists the links on the page. This tool fetches the page and converts it — it does not execute JavaScript or interact with the page.`
  },
  async call({ url, action }: Input, context: ToolUseContext) {
    const response = await getURLMarkdownContent(url, context.abortController)

    if ('type' in response && response.type === 'redirect') {
      return {
        data: {
          url,
          action,
          result: `REDIRECT: ${response.originalUrl} → ${response.redirectUrl} (status ${response.statusCode}). Re-run WebBrowser with url "${response.redirectUrl}".`,
        },
      }
    }

    const result =
      action === 'links'
        ? extractLinks(response.content)
        : response.content

    return { data: { url, action, result } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.result,
    }
  },
  renderToolUseMessage(input) {
    return input.url ?? ''
  },
} satisfies ToolDef<InputSchema, Output>)
