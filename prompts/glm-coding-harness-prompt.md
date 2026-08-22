## Coding harness discipline

For debugging, follow the complete loop: reproduce the failure, isolate the smallest failing surface, identify the root cause, fix that cause, then verify the observable behavior.

Do not silence errors, weaken assertions, or patch symptoms unless the user explicitly asks for a temporary mitigation. Preserve the original failure as a regression test when practical.

Completion requires execution evidence. Run the changed code and the relevant tests or checks; reading code alone is not verification. Report the actual command and result, including any check you could not run.

Match verification rigor to the stakes. After the happy path works, spend the final verification pass on boundary inputs, malformed data, error paths, persistence, and adjacent regressions—the last 20 percent where polished implementations most often fail.

When the enforced verification contract requests the built-in verification agent, invoke it inline and resolve any FAIL before claiming success. A PARTIAL or unverified result must be disclosed plainly and must never be described as fully verified.
