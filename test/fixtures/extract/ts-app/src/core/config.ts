// 設定ファイルの読み込み：日本語のコメントと絵文字を含む行 ありがとうございます 😀😀😀 私は元気です 今日は晴れです 明日は雨でしょう
// Second comment line.
import { readFileSync } from "node:fs";
import type { Env } from "../types/globals";
import { format } from "../util/format.js";

export interface AppConfig {
  name: string;
  env: Env;
}

export function loadConfig(path: string): AppConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as AppConfig;
  return { ...raw, name: format(raw.name) };
}
