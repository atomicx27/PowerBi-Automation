const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const realReportPath = 'C:\\Users\\GTXS3893\\OneDrive - orange.com\\Bureau\\sales.Report';

function runBuild() {
  console.log("Starting Profit Drilldown Dashboard build script...");
  
  const mcp = spawn('node', [path.join(__dirname, 'pbir-mcp-server', 'index.js')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let responseId = 1;
  const pendingRequests = new Map();
  let buffer = '';

  mcp.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (response.id && pendingRequests.has(response.id)) {
          const { resolve, reject } = pendingRequests.get(response.id);
          pendingRequests.delete(response.id);
          resolve(response);
        }
      } catch (err) {
        console.error("Failed to parse stdout line:", line, err);
      }
    }
  });

  function sendRequest(method, params = {}) {
    const id = responseId++;
    const request = {
      jsonrpc: "2.0",
      method,
      params,
      id
    };
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      mcp.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async function execute() {
    try {
      // 1. Initialize
      console.log("Initializing MCP connection...");
      await sendRequest('initialize');

      // 2. Connect to the project
      console.log(`Connecting to project: ${realReportPath}...`);
      await sendRequest('tools/call', {
        name: 'connect_project',
        arguments: { projectPath: realReportPath }
      });

      // 3. Apply custom Red accent theme for the Profit report
      console.log("Registering custom theme 'ProfitRedTheme'...");
      await sendRequest('tools/call', {
        name: 'apply_theme',
        arguments: {
          themeName: "ProfitRedTheme",
          colors: ['#D61A3C', '#FF4D4D', '#FF8080', '#FFEBEB']
        }
      });

      // 4. Create new report page
      console.log("Creating new page 'Profit Drilldown'...");
      const pageResp = await sendRequest('tools/call', {
        name: 'create_page',
        arguments: { pageName: "Profit Drilldown" }
      });
      const pageResult = JSON.parse(pageResp.result.content[0].text);
      const pageId = pageResult.pageId;
      console.log(`✓ Created page with ID: ${pageId}`);

      // 5. Add KPI Header Stack (KPI Header template)
      console.log("Adding KPI Stack cards...");
      const kpis = [
        { label: "Total Profit", measure: "financials.Total Profit", x: 30 },
        { label: "Profit Margin", measure: "financials.Profit Margin", x: 270 },
        { label: "Profit MTD", measure: "financials.Profit MTD", x: 510 },
        { label: "Profit YoY Growth", measure: "financials.Profit YoY Growth", x: 750 }
      ];

      for (const kpi of kpis) {
        console.log(`Adding KPI Card: ${kpi.label}...`);
        const cardResp = await sendRequest('tools/call', {
          name: 'add_visual',
          arguments: {
            pageId,
            visualType: "card",
            fields: { value: kpi.measure },
            layout: { x: kpi.x, y: 30, width: 220, height: 100 }
          }
        });
        const cardId = JSON.parse(cardResp.result.content[0].text).visualId;
        
        // Format KPI card
        await sendRequest('tools/call', {
          name: 'format_visual',
          arguments: {
            pageId,
            visualId: cardId,
            title: { text: kpi.label, fontSize: 11, alignment: "Center", fontColor: "#D61A3C" },
            containerStyle: { borderShow: true, borderColor: "#FFEBEB", backgroundShow: true, backgroundTransparency: 5 }
          }
        });
      }

      // Add Dropdown Slicer for Country
      console.log("Adding Country Slicer...");
      const slicerResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "slicer",
          fields: { field: "financials.Country", isDropdown: true },
          layout: { x: 990, y: 30, width: 260, height: 100 }
        }
      });
      const slicerId = JSON.parse(slicerResp.result.content[0].text).visualId;
      await sendRequest('tools/call', {
        name: 'format_visual',
        arguments: {
          pageId,
          visualId: slicerId,
          title: { text: "Filter by Country", fontSize: 10, alignment: "Left", fontColor: "#D61A3C" }
        }
      });

      // 6. Add Visual 1: Clustered Column Chart (Drilldown)
      console.log("Adding Drilldown Column Chart (Country -> Segment -> Product)...");
      const chartResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "clusteredColumnChart",
          fields: {
            xAxis: ["financials.Country", "financials.Segment", "financials.Product"],
            yAxis: ["financials.Total Profit"]
          },
          layout: { x: 30, y: 150, width: 600, height: 260 }
        }
      });
      const chartId = JSON.parse(chartResp.result.content[0].text).visualId;
      await sendRequest('tools/call', {
        name: 'format_visual',
        arguments: {
          pageId,
          visualId: chartId,
          title: { text: "Profit Drilldown by Country → Segment → Product", fontSize: 13, alignment: "Left", fontColor: "#D61A3C" },
          containerStyle: { borderShow: true, borderColor: "#D61A3C" }
        }
      });

      // 7. Add Visual 2: Treemap (Drilldown)
      console.log("Adding Drilldown Treemap (Year -> Month Name)...");
      const treemapResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "treemap",
          fields: {
            group: ["financials.Year", "financials.Month Name"],
            value: "financials.Profit MTD"
          },
          layout: { x: 650, y: 150, width: 600, height: 260 }
        }
      });
      const treemapId = JSON.parse(treemapResp.result.content[0].text).visualId;
      await sendRequest('tools/call', {
        name: 'format_visual',
        arguments: {
          pageId,
          visualId: treemapId,
          title: { text: "Profit MTD Drilldown by Year → Month Name", fontSize: 13, alignment: "Left", fontColor: "#D61A3C" },
          containerStyle: { borderShow: true, borderColor: "#D61A3C" }
        }
      });

      // 8. Add Visual 3: Matrix Table (Detail Grid)
      console.log("Adding Detail Matrix...");
      const matrixResp = await sendRequest('tools/call', {
        name: 'create_table',
        arguments: {
          pageId,
          isMatrix: true,
          rows: ["financials.Country", "financials.Segment"],
          columns: ["financials.Product"],
          values: ["financials.Total Profit", "financials.Profit Margin"],
          layout: { x: 30, y: 430, width: 1220, height: 260 }
        }
      });
      const matrixId = JSON.parse(matrixResp.result.content[0].text).visualId;
      await sendRequest('tools/call', {
        name: 'format_visual',
        arguments: {
          pageId,
          visualId: matrixId,
          title: { text: "Profit & Profit Margin Hierarchy Detail Grid", fontSize: 13, alignment: "Left", fontColor: "#D61A3C" },
          containerStyle: { borderShow: true, borderColor: "#D61A3C" }
        }
      });

      // 9. Run layout overlaps checks
      console.log("Checking for layout overlaps...");
      const auditResp = await sendRequest('tools/call', {
        name: 'audit_layout',
        arguments: { pageId, spacing: 20, autoFix: true }
      });
      console.log("Layout Auditing Result:", auditResp.result.content[0].text);

      console.log("\n★ PROFIT DRILLDOWN DASHBOARD CREATED SUCCESSFULLY ★\n");
      mcp.kill();
      process.exit(0);

    } catch (err) {
      console.error("Error building dashboard:", err);
      mcp.kill();
      process.exit(1);
    }
  }

  execute();
}

runBuild();
