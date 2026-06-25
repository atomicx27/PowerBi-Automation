# PowerBI-Automation

A workspace and custom Model Context Protocol (MCP) server for automated, programmatic Power BI report layout generation, modeling, and dashboard syncing using Microsoft Fabric's new folder-based PBIR/TMDL formats.

## 🚀 Key Features

### 1. Custom Power BI Report Layout MCP Server (`pbir-mcp-server`)
A standalone Node.js MCP server that allows AI coding assistants to programmatically manage pages and visual layouts on local Power BI Projects (`.pbip`).
* **Tools Exposed:**
  * `connect_project`: Connects to a local `.Report` folder.
  * `list_pages`: Lists all report pages.
  * `create_page`: Creates a new report page with standard metadata.
  * `add_visual`: Generates and adds visual containers (supporting column/bar/line charts, cards, and slicers) to any report page using Fabric visual container schemas.
  * `delete_visual`: Safe deletion of visuals.

### 2. YoY Sales Growth HTML Dashboard (`dashboard.html`)
An interactive, responsive HTML5 dashboard mirroring the Power BI project's metrics:
* Visualized using **Chart.js**.
* Styled following a premium dark/light layout that supports corporate color themes.
* Features responsive metrics, double-line monthly trend series, and interactive YoY KPI widgets.

### 3. Inspection & Modeling Scripts
Utility scripts for semantic model discovery, querying dynamic ports, and generating layout assets:
* `inspect_model.js`: Queries local Power BI Desktop Analysis Services instances to discover dataset measures, tables, and relationships.
* `inspect_table.js`: Retrieves column schemas.
* `add_discount_visual.js`: Example script generating new visual JSON containers programmatically.
* `run_mcp_tool.js`: Helper tool to run modeling queries.

---

## 🛠️ Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v16+)
* [Power BI Desktop](https://powerbi.microsoft.com/desktop/) (with Developer mode enabled for `.pbip` saves).

### Running the Custom Layout MCP Server
1. Navigate to the server folder:
   ```bash
   cd pbir-mcp-server
   ```
2. Install dependencies (none required, standard Node.js libraries only):
   ```bash
   npm install
   ```
3. Start the server (runs via stdin/stdout JSON-RPC protocol):
   ```bash
   node index.js
   ```

### Registering with Claude/Claude Desktop
Add the following configuration to your global `mcp_config.json` or Claude desktop config:
```json
{
  "mcpServers": {
    "powerbi-report-layout-mcp": {
      "command": "node",
      "args": [
        "/path/to/PowerBi-Automation/pbir-mcp-server/index.js"
      ]
    }
  }
}
```

---

## 📁 Repository Structure

* `pbir-mcp-server/`: Custom layout automation server codebase.
* `dashboard.html`: Interactive web replica of the dashboard.
* `add_discount_visual.js`: Code sample programmatically injecting visuals into the PBIR folder structure.
* `inspect_model.js` & `inspect_table.js`: Model diagnostics.
