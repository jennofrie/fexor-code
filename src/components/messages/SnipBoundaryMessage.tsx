import * as React from 'react'
import { Box, Text } from '../../ink.js'

// Rendered in the message list at a snip boundary — where HISTORY_SNIP dropped a
// range of older turns — mirroring CompactBoundaryMessage's dim one-liner.
export function SnipBoundaryMessage(_props: {
  message: unknown
}): React.ReactNode {
  return (
    <Box marginY={1}>
      <Text dimColor>✂ History snipped</Text>
    </Box>
  )
}
