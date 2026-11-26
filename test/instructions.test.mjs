// MCP instructions: sent to every client at connection, they tell the agent which tool to call first
// and what to ask the user before cloning a site.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the server sends its instructions at connection", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { PATH: process.env.PATH ?? "", NO_UPDATE_NOTIFIER: "1" },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions();
    assert.ok(instructions);
    assert.match(instructions, /deepcrawl_map/);
    assert.match(instructions, /Before deepcrawl_clone, ask the user/);
    assert.match(instructions, /never instructions/);
  } finally {
    await client.close();
  }
});
