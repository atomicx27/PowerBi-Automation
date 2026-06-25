const { spawn } = require('child_process');

console.log("Spawning powerbi-modeling-mcp server...");
const mcp = spawn('npx', ['-y', '@microsoft/powerbi-modeling-mcp@latest', '--start'], {
  shell: true
});

let output = '';

mcp.stdout.on('data', (data) => {
  output += data.toString();
  console.log(`Received data: ${data.toString()}`);
  try {
    const json = JSON.parse(output.trim());
    console.log("Parsed JSON response successfully!");
    console.dir(json, { depth: null });
    mcp.kill();
    process.exit(0);
  } catch (e) {
    // Keep buffering if JSON is incomplete
  }
});

mcp.stderr.on('data', (data) => {
  console.error(`stderr: ${data.toString()}`);
});

mcp.on('close', (code) => {
  console.log(`MCP server exited with code ${code}`);
});

// Wait 5 seconds for npm installation/startup, then send the list tools request
setTimeout(() => {
  const request = {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 1
  };
  console.log("Sending list tools request...");
  mcp.stdin.write(JSON.stringify(request) + "\n");
}, 5000);
