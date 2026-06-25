const { spawn } = require('child_process');

function runMcpTool(toolName, args) {
  return new Promise((resolve, reject) => {
    console.log(`Spawning MCP server and calling tool: ${toolName}...`);
    
    // Path to the executable we verified
    const exePath = "C:\\Users\\GTXS3893\\AppData\\Local\\npm-cache\\_npx\\deea81b821a9ed55\\node_modules\\@microsoft\\powerbi-modeling-mcp-win32-x64\\dist\\powerbi-modeling-mcp.exe";
    
    const mcp = spawn(exePath, ['--start'], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let output = '';

    mcp.stdout.on('data', (data) => {
      output += data.toString();
      
      // Look for JSON lines from the server
      const lines = output.split('\n');
      // Keep only the last incomplete line in the buffer
      output = lines.pop();

      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const json = JSON.parse(line.trim());
            // Check if this is the response to our request (id: 1)
            if (json.id === 1) {
              resolve(json);
              mcp.kill();
              return;
            }
          } catch (e) {
            // Ignore parse errors for intermediate lines
          }
        }
      }
    });

    mcp.on('error', (err) => {
      reject(err);
    });

    mcp.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`MCP server exited with code ${code}`));
      }
    });

    // Wait a brief moment for the server to initialize
    setTimeout(() => {
      const request = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        },
        id: 1
      };
      mcp.stdin.write(JSON.stringify(request) + "\n");
    }, 1500);
  });
}

// Read tool and arguments from command-line args passed to this script
const toolName = process.argv[2];
const argsStr = process.argv[3];

if (!toolName || !argsStr) {
  console.error("Usage: node run_mcp_tool.js <toolName> '<arguments_json>'");
  process.exit(1);
}

try {
  const args = JSON.parse(argsStr);
  runMcpTool(toolName, args)
    .then((result) => {
      console.log("\n--- TOOL RESPONSE ---");
      console.dir(result, { depth: null });
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error executing tool:", err);
      process.exit(1);
    });
} catch (e) {
  console.error("Invalid arguments JSON:", e.message);
  process.exit(1);
}
