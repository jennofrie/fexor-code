import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logMCPError } from '../utils/log.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { recursivelySanitizeUnicode } from '../utils/sanitization.js'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from '../services/mcp/client.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

// Matches MCP_FETCH_CACHE_SIZE in client.ts: keyed by server name (stable
// across reconnects), bounded so many servers can't grow the cache unbounded.
const MCP_SKILL_CACHE_SIZE = 20

// MCP skills are published as resources under the `skill://` URI scheme. Plain
// resources (file://, http://, …) are NOT skills — they're surfaced through the
// resource tools instead. This is the single distinguisher between an MCP skill
// and an ordinary MCP resource.
const SKILL_URI_SCHEME = 'skill://'

function isSkillResource(resource: ServerResource): boolean {
  return resource.uri.startsWith(SKILL_URI_SCHEME)
}

/**
 * Derives the skill name from a skill:// resource. Uses the resource's `name`
 * when present (the server-provided programmatic identifier), falling back to
 * the URI path. The final command name is mcp-prefixed and normalized to match
 * the convention used by fetchCommandsForClient for MCP prompts, so MCP skills
 * share the `mcp__<server>__<skill>` namespace.
 */
function getSkillName(serverName: string, resource: ServerResource): string {
  const rawName =
    resource.name && resource.name.length > 0
      ? resource.name
      : resource.uri.slice(SKILL_URI_SCHEME.length)
  return 'mcp__' + normalizeNameForMCP(serverName) + '__' + rawName
}

/**
 * Reads the SKILL.md body for a single skill:// resource.
 * Returns null when the resource yields no text content (e.g. binary-only).
 */
async function readSkillContent(
  client: MCPServerConnection,
  uri: string,
): Promise<string | null> {
  if (client.type !== 'connected') return null
  const connectedClient = await ensureConnectedClient(client)
  const result = (await connectedClient.client.request(
    { method: 'resources/read', params: { uri } },
    ReadResourceResultSchema,
  )) as ReadResourceResult

  for (const content of result.contents) {
    if ('text' in content && typeof content.text === 'string') {
      return content.text
    }
  }
  return null
}

/**
 * Discovers skills published by an MCP server via `skill://` resources and
 * converts them into model-invocable Command entries (loadedFrom: 'mcp').
 *
 * Each skill resource's text content is a SKILL.md document: YAML frontmatter
 * plus a markdown body. We parse it with the same frontmatter pipeline as
 * file-based skills (via the leaf registry in mcpSkillBuilders.ts to avoid an
 * import cycle through loadSkillsDir.ts), so MCP skills honor name/description/
 * when-to-use/allowed-tools/etc exactly like local ones.
 *
 * Security: skills are sourced as 'mcp', so createSkillCommand never executes
 * inline shell commands from their (remote, untrusted) markdown body.
 *
 * Memoized + keyed by server name so callers can invalidate a single server's
 * skills via `fetchMcpSkillsForClient.cache.delete(name)` on a resources
 * list_changed notification.
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities?.resources) return []

    try {
      const resources = await fetchResourcesForClient(client)
      const skillResources = resources.filter(isSkillResource)
      if (skillResources.length === 0) return []

      const { createSkillCommand, parseSkillFrontmatterFields } =
        getMCPSkillBuilders()

      const skills = await Promise.all(
        skillResources.map(async (resource): Promise<Command | null> => {
          try {
            const rawContent = await readSkillContent(client, resource.uri)
            if (rawContent === null) {
              logForDebugging(
                `[mcp-skills] ${client.name}: ${resource.uri} has no text content, skipping`,
              )
              return null
            }

            // Sanitize remote markdown before parsing, matching the treatment
            // of MCP prompts/tools in client.ts.
            const sanitized = recursivelySanitizeUnicode(rawContent)
            const { frontmatter, content: markdownContent } = parseFrontmatter(
              sanitized,
              resource.uri,
            )

            const skillName = getSkillName(client.name, resource)
            const parsed = parseSkillFrontmatterFields(
              frontmatter,
              markdownContent,
              skillName,
            )

            // Resource-level description wins when the skill body provides none.
            const description =
              parsed.hasUserSpecifiedDescription || !resource.description
                ? parsed.description
                : resource.description

            return createSkillCommand({
              ...parsed,
              description,
              skillName,
              markdownContent,
              source: 'mcp',
              baseDir: undefined,
              loadedFrom: 'mcp',
              paths: undefined,
            })
          } catch (error) {
            logMCPError(
              client.name,
              `Failed to load skill '${resource.uri}': ${errorMessage(error)}`,
            )
            return null
          }
        }),
      )

      return skills.filter((s): s is Command => s !== null)
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch skills: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_SKILL_CACHE_SIZE,
)
