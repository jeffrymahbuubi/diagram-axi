import { format } from "../util/format.js";
import { AppConfig } from "../core/config";

export function Button(props: { config: AppConfig }) {
  return <button>{format(props.config.name)}</button>;
}
