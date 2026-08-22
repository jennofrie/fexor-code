/**
 * The coding harness is deliberately narrower than the repository's normal
 * truthy environment parsing. Only the documented master value `1` activates
 * behavior; values such as `true` retain default-off parity.
 */
export function isCodingHarnessEnabled(
  value: string | undefined = process.env.FEXOR_CODING_HARNESS
): boolean {
  return value === "1";
}
