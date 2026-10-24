import { VERSION } from "./helpers.mjs";

export function format(name: string): string {
  return `${name}@${VERSION}`;
}
