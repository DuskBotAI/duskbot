import { expect, it } from "vitest";

import { bulkRetryDelay } from "./use-selected-transcript";

it("backs off after a failed bulk read instead of asking again every three seconds", () => {
  expect([1, 2, 3, 4, 5, 9].map(bulkRetryDelay)).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
});