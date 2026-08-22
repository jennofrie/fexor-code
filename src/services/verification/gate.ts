import { feature } from "bun:bundle";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { isCodingHarnessEnabled } from "../codingHarness/gate.js";

export type VerificationGateInput = {
  featureEnabled: boolean;
  legacyEnabled: boolean;
  master: boolean;
  override?: string;
};

/**
 * Resolve whether the verification agent and its legacy prompt nudges are
 * visible. With the harness disabled this deliberately preserves the original
 * GrowthBook behavior. With the harness enabled the narrow Fexor override is
 * default-on and can still be explicitly disabled.
 */
export function resolveVerificationGate({
  featureEnabled,
  legacyEnabled,
  master,
  override,
}: VerificationGateInput): boolean {
  if (!featureEnabled) return false;
  if (!master) return legacyEnabled;
  if (override === undefined) return true;
  return isEnvTruthy(override);
}

export function isVerificationAgentVisible(
  getLegacyEnabled: () => boolean
): boolean {
  // Keep this direct branch so Bun can eliminate the complete verification
  // surface from builds where VERIFICATION_AGENT is not compiled. The legacy
  // value is a thunk so a disabled build never evaluates GrowthBook, while the
  // gate module itself stays independent of analytics/query infrastructure.
  if (!feature("VERIFICATION_AGENT")) return false;

  return resolveVerificationGate({
    featureEnabled: true,
    legacyEnabled: getLegacyEnabled(),
    master: isCodingHarnessEnabled(),
    override: process.env.FEXOR_ENABLE_VERIFICATION_AGENT,
  });
}

/**
 * Runtime enforcement is intentionally narrower than agent visibility.
 * A remotely-enabled legacy experiment must never silently opt users into the
 * Fexor stop gate, snapshot, or failure semantics.
 */
export function isVerificationContractEnabled(): boolean {
  if (!feature("VERIFICATION_AGENT")) return false;
  if (!isCodingHarnessEnabled()) return false;

  const override = process.env.FEXOR_ENABLE_VERIFICATION_AGENT;
  return override === undefined || isEnvTruthy(override);
}

export function shouldEnforceVerificationStopGate(
  contractEnabled: boolean,
  agentId: unknown
): boolean {
  return contractEnabled && !agentId;
}
