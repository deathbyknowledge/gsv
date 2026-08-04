import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_V4_FLASH_0731_PRICE,
  maximumRequestCostMicrounits,
  tokenCostMicrounits,
} from "./price-book";

describe("managed inference price book", () => {
  it("represents DeepSeek 0731 cache-hit, cache-miss, and output prices exactly", () => {
    expect(tokenCostMicrounits({
      cacheHitInputTokens: 1_000_000,
      cacheMissInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, DEEPSEEK_V4_FLASH_0731_PRICE)).toBe(422_800);
  });

  it("reserves all input as a cache miss and the full controlled output ceiling", () => {
    expect(maximumRequestCostMicrounits(
      DEEPSEEK_V4_FLASH_0731_PRICE,
      1_000,
      8_192,
    )).toBe(2_434);
  });
});
