export type AgentAsyncForcingInputs = {
  mustCompleteBeforeParentContinues: boolean;
  backgroundTasksDisabled: boolean;
  requestedBackground: boolean;
  definitionBackground: boolean;
  coordinator: boolean;
  forkSubagent: boolean;
  assistantMode: boolean;
  proactive: boolean;
};

export function shouldRunAgentAsynchronously({
  mustCompleteBeforeParentContinues,
  backgroundTasksDisabled,
  requestedBackground,
  definitionBackground,
  coordinator,
  forkSubagent,
  assistantMode,
  proactive,
}: AgentAsyncForcingInputs): boolean {
  if (mustCompleteBeforeParentContinues || backgroundTasksDisabled)
    return false;
  return (
    requestedBackground ||
    definitionBackground ||
    coordinator ||
    forkSubagent ||
    assistantMode ||
    proactive
  );
}
