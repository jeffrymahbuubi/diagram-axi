import { dispatch, type Registry } from "./cli/router.js";
import { homeCommand, rootHelp } from "./commands/home.js";
import { drawCommand } from "./commands/draw.js";
import { renderCommand } from "./commands/render.js";
import { inspectCommand } from "./commands/inspect.js";
import { checkCommand } from "./commands/check.js";
import { extractCommand } from "./commands/extract.js";
import { syntaxCommand } from "./commands/syntax.js";
import { enginesCommand, enginesInstallCommand } from "./commands/engines.js";
import { releaseEngines } from "./commands/engine-io.js";

const registry: Registry = {
  tool: "diagram-axi",
  root: homeCommand,
  rootHelp,
  commands: {
    draw: drawCommand,
    render: renderCommand,
    inspect: inspectCommand,
    check: checkCommand,
    extract: extractCommand,
    syntax: syntaxCommand,
    engines: enginesCommand,
    "engines install": enginesInstallCommand,
  },
  aliases: {},
};

const code = await dispatch(registry, process.argv.slice(2));
await releaseEngines();
process.exit(code);
