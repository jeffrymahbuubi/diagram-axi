import {
  loadConfig,
  log,
} from "../core/index.js";
import { logLevel } from "@core/logger.js";
import { route } from "./router.js";
import type { Router } from "./router";
import { pingA } from "./cycle-a.js";
import { leaf } from "../deep/a/b/c/leaf.js";

export function createApp(path: string) {
  const config = loadConfig(path);
  log(config.name);
  pingA(1);
  return { config, leaf, route: (r: Router) => route(r) };
}

export async function loadPlugin(name: string) {
  const loader = await import("./plugins/loader.js");
  const dynamicByName = await import(name);
  return { loader, dynamicByName, logLevel };
}
