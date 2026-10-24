// Scene -> .excalidraw file text. Key order comes from the element factories, so the
// output is byte-deterministic: 2-space JSON plus a trailing newline.

import type { SceneData } from "../render/outputs.js";

export function serialize(scene: SceneData): string {
  return JSON.stringify(scene, null, 2) + "\n";
}
