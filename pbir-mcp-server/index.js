const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Global server state
let activeReportPath = null; // Path to the active MyProject.Report directory
let workspacePath = "C:\\Users\\GTXS3893\\.gemini\\antigravity\\scratch"; // Default scan path

// Logging helper for debugging (stderr goes to host logs, stdout is JSON-RPC)
function log(msg) {
  process.stderr.write(`[INFO] ${msg}\n`);
}

function logError(msg) {
  process.stderr.write(`[ERROR] ${msg}\n`);
}

// Find a report directory in the workspace
function findReportInWorkspace(dir) {
  try {
    const files = fs.readdirSync(dir);
    
    // Check if current directory is a .Report folder
    if (files.includes('definition.pbir') && fs.existsSync(path.join(dir, 'definition'))) {
      return dir;
    }

    // Look in subdirectories
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        // Skip hidden folders or node_modules
        if (file.startsWith('.') || file === 'node_modules') continue;
        
        if (file.endsWith('.Report')) {
          return fullPath;
        }
        
        const found = findReportInWorkspace(fullPath);
        if (found) return found;
      }
    }
  } catch (e) {
    logError(`Error scanning workspace: ${e.message}`);
  }
  return null;
}

const knownMeasures = ['Total Sales', 'Sales YoY Growth'];
function getFieldProjection(queryRef) {
  const parts = queryRef.split('.');
  const entity = parts[0];
  const property = parts.slice(1).join('.');
  
  if (knownMeasures.includes(property)) {
    return {
      "field": {
        "Measure": {
          "Expression": { "SourceRef": { "Entity": entity } },
          "Property": property
        }
      },
      "queryRef": queryRef
    };
  } else {
    return {
      "field": {
        "Column": {
          "Expression": { "SourceRef": { "Entity": entity } },
          "Property": property
        }
      },
      "queryRef": queryRef
    };
  }
}

// Helper to generate visual configuration
function buildVisualJson(visualType, fields, layout) {
  const visualName = `Visual_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  
  // Base visual structure
  const visualObj = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
    "name": visualName,
    "position": {
      "x": layout.x || 0,
      "y": layout.y || 0,
      "width": layout.width || 300,
      "height": layout.height || 250
    },
    "visual": {
      "visualType": visualType,
      "query": {
        "queryState": {}
      }
    }
  };

  // Configure projections based on visual type and fields
  if (visualType === 'card') {
    visualObj.visual.query.queryState.Values = {
      "projections": [
        getFieldProjection(fields.value)
      ]
    };
  } else if (visualType === 'lineChart' || visualType === 'clusteredColumnChart' || visualType === 'clusteredBarChart') {
    visualObj.visual.query.queryState.Category = {
      "projections": [
        getFieldProjection(fields.xAxis)
      ]
    };
    visualObj.visual.query.queryState.Y = {
      "projections": (Array.isArray(fields.yAxis) ? fields.yAxis : [fields.yAxis]).map(y => getFieldProjection(y))
    };
  } else if (visualType === 'slicer') {
    visualObj.visual.query.queryState.Values = {
      "projections": [
        getFieldProjection(fields.field)
      ]
    };
    // Set visual type specific format if dropdown requested
    visualObj.visual.objects = {
      "slicerSettings": [
        {
          "properties": {
            "slicerType": {
              "expr": {
                "Literal": {
                  "Value": fields.isDropdown ? "'Dropdown'" : "'List'"
                }
              }
            }
          }
        }
      ]
    };
  }

  return { visualName, visualObj };
}

// Core Tool implementations
const tools = {
  connect_project: (args) => {
    let projectPath = args.projectPath;
    
    if (!projectPath) {
      log("No project path provided. Scanning workspace...");
      projectPath = findReportInWorkspace(workspacePath);
      if (!projectPath) {
        throw new Error(`Could not automatically find a Power BI Report folder (.Report) in ${workspacePath}. Please specify 'projectPath' explicitly.`);
      }
    }

    // Resolve if user gave root folder containing MyProject.Report
    if (fs.existsSync(projectPath)) {
      const stats = fs.statSync(projectPath);
      if (stats.isDirectory()) {
        const files = fs.readdirSync(projectPath);
        if (!files.includes('definition.pbir')) {
          // Check subfolders for a .Report directory
          const subReport = files.find(f => f.endsWith('.Report') && fs.statSync(path.join(projectPath, f)).isDirectory());
          if (subReport) {
            projectPath = path.join(projectPath, subReport);
          } else {
            throw new Error(`The folder at ${projectPath} is not a valid Power BI Report folder (missing definition.pbir).`);
          }
        }
      }
    } else {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    activeReportPath = projectPath;
    log(`Successfully connected to Power BI report folder: ${activeReportPath}`);
    return {
      message: `Connected successfully to report project.`,
      reportPath: activeReportPath
    };
  },

  list_pages: () => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }

    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    if (!fs.existsSync(pagesDir)) {
      return { pages: [] };
    }

    const pages = [];
    const items = fs.readdirSync(pagesDir);
    for (const item of items) {
      const pagePath = path.join(pagesDir, item);
      if (fs.statSync(pagePath).isDirectory()) {
        const jsonPath = path.join(pagePath, 'page.json');
        if (fs.existsSync(jsonPath)) {
          try {
            const pageJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            pages.push({
              pageId: item,
              displayName: pageJson.displayName || item,
              visualCount: fs.existsSync(path.join(pagePath, 'visuals')) ? 
                fs.readdirSync(path.join(pagePath, 'visuals')).length : 0
            });
          } catch (e) {
            logError(`Error parsing page.json in ${item}: ${e.message}`);
          }
        }
      }
    }

    return { pages };
  },

  create_page: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }

    const pageName = args.pageName;
    if (!pageName) {
      throw new Error("Parameter 'pageName' is required.");
    }

    // Generate a safe unique section ID: 20-character hex string (10 bytes)
    const pageId = Array.from({length: 20}, () => Math.floor(Math.random()*16).toString(16)).join('');
    
    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    if (!fs.existsSync(pagesDir)) {
      fs.mkdirSync(pagesDir, { recursive: true });
    }

    const pageFolder = path.join(pagesDir, pageId);
    fs.mkdirSync(pageFolder);

    const pageJson = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json",
      "name": pageId,
      "displayName": pageName,
      "displayOption": "FitToPage",
      "height": 720,
      "width": 1280
    };

    fs.writeFileSync(path.join(pageFolder, 'page.json'), JSON.stringify(pageJson, null, 2), 'utf8');

    // Update pages.json (page order manifest)
    const pagesJsonPath = path.join(pagesDir, 'pages.json');
    let pagesData = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json",
      "pageOrder": [],
      "activePageName": ""
    };
    if (fs.existsSync(pagesJsonPath)) {
      try {
        const fileContent = fs.readFileSync(pagesJsonPath, 'utf8');
        if (fileContent.trim()) {
          pagesData = JSON.parse(fileContent);
        }
      } catch (e) {
        logError(`Error parsing pages.json order file: ${e.message}`);
      }
    }
    if (!Array.isArray(pagesData.pageOrder)) {
      pagesData.pageOrder = [];
    }
    pagesData.pageOrder.push(pageId);
    pagesData.activePageName = pageId;
    fs.writeFileSync(pagesJsonPath, JSON.stringify(pagesData, null, 2), 'utf8');

    log(`Created report page: ${pageName} (ID: ${pageId})`);
    return {
      message: `Page '${pageName}' created successfully.`,
      pageId: pageId
    };
  },

  add_visual: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }

    const { pageId, visualType, fields, layout = {} } = args;
    if (!pageId || !visualType || !fields) {
      throw new Error("Parameters 'pageId', 'visualType', and 'fields' are required.");
    }

    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    const pageFolder = path.join(pagesDir, pageId);
    if (!fs.existsSync(pageFolder)) {
      throw new Error(`Report page with ID '${pageId}' does not exist.`);
    }

    // Build the visual configuration
    const { visualName, visualObj } = buildVisualJson(visualType, fields, layout);

    const visualsDir = path.join(pageFolder, 'visuals');
    if (!fs.existsSync(visualsDir)) {
      fs.mkdirSync(visualsDir);
    }

    const visualFolder = path.join(visualsDir, visualName);
    fs.mkdirSync(visualFolder);

    fs.writeFileSync(path.join(visualFolder, 'visual.json'), JSON.stringify(visualObj, null, 2), 'utf8');

    log(`Added visual ${visualName} (${visualType}) to page ${pageId}`);
    return {
      message: `Visual '${visualName}' of type '${visualType}' added successfully.`,
      visualId: visualName
    };
  },

  delete_visual: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }

    const { pageId, visualId } = args;
    if (!pageId || !visualId) {
      throw new Error("Parameters 'pageId' and 'visualId' are required.");
    }

    const visualFolder = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualId);
    if (!fs.existsSync(visualFolder)) {
      throw new Error(`Visual '${visualId}' on page '${pageId}' not found.`);
    }

    // Delete folder contents and folder itself
    fs.rmSync(visualFolder, { recursive: true, force: true });
    
    log(`Deleted visual ${visualId} from page ${pageId}`);
    return {
      message: `Visual '${visualId}' deleted successfully.`
    };
  }
};

// StdIn reader loop for JSON-RPC messages
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    
    // Validate JSON-RPC structure
    if (request.jsonrpc !== "2.0") {
      return;
    }

    if (request.method === 'initialize') {
      const response = {
        jsonrpc: "2.0",
        result: {
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "powerbi-report-layout-mcp",
            version: "1.0.0"
          }
        },
        id: request.id
      };
      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    }

    if (request.method === 'tools/list') {
      const response = {
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              name: "connect_project",
              description: "Connect to a Power BI Project folder containing a report (.Report). Auto-scans workspace if projectPath is omitted.",
              inputSchema: {
                type: "object",
                properties: {
                  projectPath: {
                    type: "string",
                    description: "Absolute path to the Power BI Report folder (.Report) or the root project folder containing it."
                  }
                }
              }
            },
            {
              name: "list_pages",
              description: "List all report pages currently in the connected project.",
              inputSchema: {
                type: "object",
                properties: {}
              }
            },
            {
              name: "create_page",
              description: "Create a new visual report page inside the connected project.",
              inputSchema: {
                type: "object",
                properties: {
                  pageName: {
                    type: "string",
                    description: "Display name of the new report page (e.g. Sales YoY Overview)."
                  }
                },
                required: ["pageName"]
              }
            },
            {
              name: "add_visual",
              description: "Add a visual chart (Card, Line Chart, Column Chart, or Slicer) to an existing report page.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: {
                    type: "string",
                    description: "The folder/ID name of the page to add the visual to."
                  },
                  visualType: {
                    type: "string",
                    enum: ["card", "lineChart", "clusteredColumnChart", "clusteredBarChart", "slicer"],
                    description: "The visual type chart."
                  },
                  fields: {
                    type: "object",
                    description: "Field bindings. For card: {value: 'table.column'}. For chart: {xAxis: 'table.col', yAxis: ['table.col']}. For slicer: {field: 'table.col', isDropdown: true/false}."
                  },
                  layout: {
                    type: "object",
                    properties: {
                      x: { type: "integer" },
                      y: { type: "integer" },
                      width: { type: "integer" },
                      height: { type: "integer" },
                      zIndex: { type: "integer" }
                    }
                  }
                },
                required: ["pageId", "visualType", "fields"]
              }
            },
            {
              name: "delete_visual",
              description: "Delete an existing visual from a page.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string" },
                  visualId: { type: "string" }
                },
                required: ["pageId", "visualId"]
              }
            }
          ]
        },
        id: request.id
      };
      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    }

    if (request.method === 'tools/call') {
      const toolName = request.params.name;
      const toolArgs = request.params.arguments || {};
      
      const response = {
        jsonrpc: "2.0",
        id: request.id
      };

      if (tools[toolName]) {
        try {
          const result = tools[toolName](toolArgs);
          response.result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(result)
              }
            ],
            isError: false
          };
        } catch (err) {
          response.result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err.message })
              }
            ],
            isError: true
          };
        }
      } else {
        response.result = {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' not found.`
            }
          ],
          isError: true
        };
      }
      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    }

  } catch (err) {
    logError(`Error parsing JSON-RPC line: ${err.message}`);
  }
});
