import { expect, test } from "vitest";
import { format } from "./format.js";

test("format appends the version", () => {
  expect(format("x")).toContain("@");
});
