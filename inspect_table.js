const { spawn } = require('child_process');

const exePath = "C:\\Users\\GTXS3893\\AppData\\Local\\npm-cache\\_npx\\deea81b821a9ed55\\node_modules\\@microsoft\\powerbi-modeling-mcp-win32-x64\\dist\\powerbi-modeling-mcp.exe";

const mcp = spawn(exePath, ['--start'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

let output = '';
let currentRequestId = 1;

function sendRequest(method, params) {
  const request = {
    jsonrpc: "2.0",
    method: method,
    params: params,
    id: currentRequestId++
  };
  mcp.stdin.write(JSON.stringify(request) + "\n");
}

mcp.stdout.on('data', (data) => {
  output += data.toString();
  const lines = output.split('\n');
  output = lines.pop();

  for (const line of lines) {
    if (line.trim().startsWith('{')) {
      try {
        const json = JSON.parse(line.trim());
        console.log(`\n<<< Received Response #${json.id}`);
        console.dir(json, { depth: null });

        if (json.id === 1) {
          sendRequest("tools/call", {
            name: "table_operations",
            arguments: {
              request: {
                operation: "GetSchema",
                references: [
                  {
                    name: "financials"
                  }
                ]
              }
            }
          });
        } else if (json.id === 2) {
          mcp.kill();
          process.exit(0);
        }
      } catch (e) {
      }
    }
  }
});

setTimeout(() => {
  sendRequest("tools/call", {
    name: "connection_operations",
    arguments: {
      request: {
        operation: "Connect",
        connectionString: "Provider=MSOLAP;Data Source=localhost:52332"
      }
    }
  });
}, 2000);
