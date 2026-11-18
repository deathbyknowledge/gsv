export const RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT = `# Commitments

This is the personal intelligence's compact working memory for promises that must survive the current response. Keep only open commitments. Each entry should state the promised outcome, current state, delegated task id, worker pid, deadline, and opaque reply destination when one exists.

Reconcile entries when results, failures, or timeouts arrive. A past deadline is not "in progress." Remove an entry only after GSV has closed the user-facing loop; durable history belongs elsewhere.

No open commitments.
`;
