/**
 * Weighted token matching for tool discovery.
 *
 * Follows the executor-style scoring approach: normalize text (expand
 * camelCase, split on separators), tokenize the query, then score each
 * tool field with different weights. Exact matches score higher than
 * prefix matches, which score higher than substring matches.
 */

import type { ToolDefinition } from "../protocol/tools";

// Field weights — name and source ID matter more than description
const FIELD_WEIGHTS = {
  name: 10,
  sourceId: 8,
  description: 5,
  schemaKeys: 3,
};

// Scoring tiers per field
const EXACT_MATCH = 14;
const STARTS_WITH = 9;
const PHRASE_SUBSTRING = 6;
const TOKEN_MATCH = 4;
const TOKEN_PREFIX = 2;
const TOKEN_SUBSTRING = 1;

// Coverage bonuses
const FULL_COVERAGE_BONUS = 25;
const PARTIAL_COVERAGE_BONUS = 10;

/** Normalize text: expand camelCase, replace separators with spaces, lowercase. */
function normalize(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → spaces
    .replace(/[_.\-/:]+/g, " ")            // separators → spaces
    .toLowerCase()
    .trim();
}

/** Split normalized text into tokens. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Score how well a field matches a set of query tokens. Returns weighted score. */
function scoreField(
  queryTokens: string[],
  fieldText: string,
  weight: number,
): { score: number; matchedTokens: Set<string> } {
  const normalized = normalize(fieldText);
  const fieldTokens = normalized.split(/\s+/).filter((t) => t.length > 0);
  const query = queryTokens.join(" ");
  let score = 0;
  const matchedTokens = new Set<string>();

  // Exact full match
  if (normalized === query) {
    score += weight * EXACT_MATCH;
    for (const t of queryTokens) matchedTokens.add(t);
    return { score, matchedTokens };
  }

  // Field starts with query
  if (normalized.startsWith(query)) {
    score += weight * STARTS_WITH;
    for (const t of queryTokens) matchedTokens.add(t);
    return { score, matchedTokens };
  }

  // Exact phrase substring
  if (normalized.includes(query)) {
    score += weight * PHRASE_SUBSTRING;
    for (const t of queryTokens) matchedTokens.add(t);
    return { score, matchedTokens };
  }

  // Per-token matching
  for (const qt of queryTokens) {
    let tokenBestScore = 0;
    for (const ft of fieldTokens) {
      if (ft === qt) {
        tokenBestScore = Math.max(tokenBestScore, TOKEN_MATCH);
      } else if (ft.startsWith(qt)) {
        tokenBestScore = Math.max(tokenBestScore, TOKEN_PREFIX);
      } else if (ft.includes(qt)) {
        tokenBestScore = Math.max(tokenBestScore, TOKEN_SUBSTRING);
      }
    }
    if (tokenBestScore > 0) {
      score += weight * tokenBestScore;
      matchedTokens.add(qt);
    }
  }

  return { score, matchedTokens };
}

/** Score a tool against query tokens across all searchable fields. */
export function scoreToolMatch(
  queryTokens: string[],
  tool: ToolDefinition,
): number {
  const allMatched = new Set<string>();
  let totalScore = 0;

  // Parse sourceId from namespaced tool name
  const sepIdx = tool.name.indexOf("__");
  const sourceId = sepIdx > 0 ? tool.name.slice(0, sepIdx) : "";
  const toolName = sepIdx > 0 ? tool.name.slice(sepIdx + 2) : tool.name;

  // Score each field
  const fields: Array<[string, number]> = [
    [toolName, FIELD_WEIGHTS.name],
    [sourceId, FIELD_WEIGHTS.sourceId],
    [tool.description || "", FIELD_WEIGHTS.description],
    [
      Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
      ).join(" "),
      FIELD_WEIGHTS.schemaKeys,
    ],
  ];

  for (const [text, weight] of fields) {
    if (!text) continue;
    const { score, matchedTokens } = scoreField(queryTokens, text, weight);
    totalScore += score;
    for (const t of matchedTokens) allMatched.add(t);
  }

  // Coverage bonuses
  if (allMatched.size === queryTokens.length) {
    totalScore += FULL_COVERAGE_BONUS;
  } else if (allMatched.size > 0) {
    totalScore += Math.round(
      PARTIAL_COVERAGE_BONUS * (allMatched.size / queryTokens.length),
    );
  }

  return totalScore;
}
