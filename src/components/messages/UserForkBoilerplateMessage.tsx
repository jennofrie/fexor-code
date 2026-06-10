import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { FORK_GLYPH } from '../../constants/figures.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

// Renders a fork child's first message. buildChildMessage (forkSubagent.ts)
// emits the rules/format rules wrapped in <fork-boilerplate>…</fork-boilerplate>
// followed by `${FORK_DIRECTIVE_PREFIX}${directive}`. We collapse the
// boilerplate and show only the directive so the transcript stays readable.
export function UserForkBoilerplateMessage({
  addMargin,
  param: { text },
}: Props): React.ReactNode {
  // Strip the boilerplate block; everything after the closing tag is the
  // directive trailer (prefixed by FORK_DIRECTIVE_PREFIX).
  const closeTag = `</${FORK_BOILERPLATE_TAG}>`
  const closeIndex = text.indexOf(closeTag)
  const trailer =
    closeIndex === -1 ? text : text.slice(closeIndex + closeTag.length)

  const directive = trailer
    .replace(FORK_DIRECTIVE_PREFIX, '')
    .trim()

  if (!directive) return null

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="subtle">{FORK_GLYPH} fork </Text>
        {directive}
      </Text>
    </Box>
  )
}
