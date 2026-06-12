// graphify OpenCode plugin
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
import { existsSync } from "fs";
import { join } from "path";

export const GraphifyPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (input.tool === "bash") {
        let lines = [];
        if (existsSync(join(directory, "graphify-out", "graph.json"))) {
          lines.push("[graphify] Knowledge graph available. Read graphify-out/GRAPH_REPORT.md for god nodes and architecture context.");
        }
        lines.push("[echovault] Run 'memory context --project' at start to load past decisions, bugs, and learning context.");
        lines.push("[continuity] Check .codebase-memory/adr.md for decisions and .remember/now.md for active tasks.");

        let echoCmd = lines.map(line => `echo "${line}"`).join(" && ");
        output.args.command = `${echoCmd} && ${output.args.command}`;
        reminded = true;
      }
    },
  };
};
