---
name: "safe-task-exploration"
description: "Plan and begin bounded exploration when a task has no confirmed specialist procedure and can start with authorized read-only checks."
---

# Explore an unfamiliar task safely

## Scope

This provisional workflow starts with observation and supports an isolated experiment. Use the authorization already granted. Stop before any action outside that scope and identify the authorization it requires. Keep production targets, customer data, and credentials outside the experiment.

## Procedure

### Establish what can be checked

Read the accompanying task and extract the target, intended result, constraints, and one observable success condition. Inspect available version manifests, configuration, and environment metadata using read-only access. Write down each confirmed value with its source and mark unknown values. If the target or authorized observation scope cannot be identified, ask for the missing fact and stop before interacting with the system.

### Check the versioned primary sources

Find the upstream manual, release notes, or maintained source for the actual component and version. Look up the exact behavior named in the task, including prerequisites, limits, failure modes, and supported recovery. Record the source, version and the passage that supports each proposed action. Keep a discrepancy open until you can reproduce it or find an authoritative explanation. Stop before any action that depends on an unresolved discrepancy.

### Design one bounded experiment

Use synthetic inputs and a disposable copy, fixture, emulator or other authorized isolated target. Record the baseline first. Vary one task-specific condition and compare its observable result against that baseline. Include one failure or interruption that should prevent the result from being trusted. Before the experiment, record the input, the variable, the observation, the expected result for each case, and the cleanup or recovery step. Confirm the copy can be discarded or restored before changing it. For a planning request, describe the experiment and leave execution pending.

### Record the decision

Record the target and version, source passages, input, baseline, changed result, elapsed time or other relevant metric, and any effect outside the test boundary. Use redacted summaries where records could include private data. Compare each observed result with its expected value. Stop if the target differs from the plan, isolation or recovery cannot be verified, an unexpected side effect occurs, or the result is ambiguous. Report the first unresolved condition and the next read-only check. Advance to a broader test only after the bounded results and authorization support it.

## Completion checks

1. Record the exact target, version, authorized scope, and primary sources before proposing changes.
2. Distinguish the planned experiment from observed results. Leave the outcome unverified until actual evidence supports it.
