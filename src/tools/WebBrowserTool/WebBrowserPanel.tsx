import type * as React from 'react'

// The dependency-light WebBrowserTool fetches and reads pages rather than driving
// a live embedded browser, so there is no persistent panel UI to show. Returning
// null satisfies the feature('WEB_BROWSER_TOOL') render slot in REPL.tsx while
// keeping the interface clean. (Swap in a live view here if a browser backend is
// added later.)
export function WebBrowserPanel(): React.ReactNode {
  return null
}
