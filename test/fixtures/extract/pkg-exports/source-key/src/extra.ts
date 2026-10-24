import { impl } from "./impl.js";

export const extra = (): number => impl() + 1;
