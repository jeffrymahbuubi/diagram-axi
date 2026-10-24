import pc from "picocolors-fixture";
import { scoped } from "@fixture/scoped/sub/path";
import { join } from "path";

export const logLevel = "info";

export function log(message: string): void {
  console.log(pc.dim(scoped(join("log", message))));
}
