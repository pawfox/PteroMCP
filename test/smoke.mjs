// Smoke test: starts this MCP over stdio and calls tools like an MCP client would.
//
//   node test/smoke.mjs --config ~/.config/Claude/claude_desktop_config.json --server plasma-panel \
//       [--call tool_name '{"json":"args"}']...
//
// Panel credentials come from the named mcpServers entry's env (never printed).
// With no --call, it only lists the tools.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const calls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--call") calls.push([args[i + 1], JSON.parse(args[i + 2] ?? "{}")]);
}

let env = {};
if (opt("--config")) {
  const cfg = JSON.parse(readFileSync(opt("--config"), "utf8"));
  const entry = cfg.mcpServers?.[opt("--server")];
  if (!entry) throw new Error(`No mcpServers entry named ${opt("--server")}`);
  env = entry.env ?? {};
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/index.js")],
  env: { ...process.env, ...env },
  stderr: "pipe",
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).sort().join(" ")}`);

let failed = false;
for (const [name, params] of calls) {
  const res = await client.callTool({ name, arguments: params });
  const text = res.content?.map((c) => c.text).join("\n") ?? "";
  console.log(`\n=== ${name} ${res.isError ? "(ERROR)" : ""}\n${text.slice(0, Number(process.env.SMOKE_MAX_CHARS ?? 2500))}`);
  failed ||= !!res.isError && !process.argv.includes("--allow-errors");
}
await client.close();
process.exit(failed ? 1 : 0);
