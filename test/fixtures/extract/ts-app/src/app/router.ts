import type { App } from "./app.js";

export interface Router {
  app: App;
}

export function route(r: Router): string {
  return String(r);
}
