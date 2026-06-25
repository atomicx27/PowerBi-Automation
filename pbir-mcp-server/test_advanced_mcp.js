const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;

const tempReportPath = path.join(__dirname, 'temp_test_report.Report');

// Helper to setup mock PBIR folder
function setupMockReport() {
  if (fs.existsSync(tempReportPath)) {
    fs.rmSync(tempReportPath, { recursive: true, force: true });
  }
  fs.mkdirSync(tempReportPath, { recursive: true });
  fs.writeFileSync(path.join(tempReportPath, 'definition.pbir'), JSON.stringify({
    "version": "1.0",
    "datasetReference": {
      "byPath": null
    }
  }, null, 2));

  const defDir = path.join(tempReportPath, 'definition');
  fs.mkdirSync(defDir, { recursive: true });
}

// Clean up helper
function cleanupMockReport() {
  if (fs.existsSync(tempReportPath)) {
    fs.rmSync(tempReportPath, { recursive: true, force: true });
  }
}

// Spawns the MCP server and communicates via JSON-RPC
function runMcpSession() {
  console.log("Setting up mock Power BI Report folder...");
  setupMockReport();

  const mcp = spawn('node', [path.join(__dirname, 'index.js')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let responseId = 1;
  const pendingRequests = new Map();
  let buffer = '';

  mcp.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line

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

  // Define tests
  async function runTests() {
    try {
      console.log("\n--- Starting MCP Server Tests ---");

      // 1. Initialize
      console.log("Testing 'initialize'...");
      const initResp = await sendRequest('initialize');
      assert.equal(initResp.result.serverInfo.name, 'powerbi-report-layout-mcp');
      console.log("✓ 'initialize' success.");

      // 2. Tools List
      console.log("Testing 'tools/list'...");
      const toolsResp = await sendRequest('tools/list');
      const tools = toolsResp.result.tools;
      const toolNames = tools.map(t => t.name);
      
      const expectedTools = [
        'connect_project', 'list_pages', 'create_page', 'add_visual', 
        'delete_visual', 'create_table', 'format_visual', 
        'auto_arrange_page', 'add_action_button', 'group_visuals', 'sync_slicers'
      ];
      
      for (const tName of expectedTools) {
        assert(toolNames.includes(tName), `Missing tool registration: ${tName}`);
      }
      console.log("✓ 'tools/list' contains all expected tool definitions.");

      // Check the visualType enum has pieChart, donutChart, table, pivotTable
      const addVisualTool = tools.find(t => t.name === 'add_visual');
      const visualTypeEnum = addVisualTool.inputSchema.properties.visualType.enum;
      const expectedVisualTypes = ['pieChart', 'donutChart', 'table', 'pivotTable'];
      for (const vt of expectedVisualTypes) {
        assert(visualTypeEnum.includes(vt), `add_visual missing visualType enum: ${vt}`);
      }
      console.log("✓ 'add_visual' tool schema updated with new visual types.");

      // 3. Connect Project
      console.log("Testing 'connect_project'...");
      const connResp = await sendRequest('tools/call', {
        name: 'connect_project',
        arguments: { projectPath: tempReportPath }
      });
      const connResult = JSON.parse(connResp.result.content[0].text);
      assert(!connResp.result.isError);
      assert.equal(connResult.reportPath, tempReportPath);
      console.log("✓ 'connect_project' connected to temp report.");

      // 4. Create Page
      console.log("Testing 'create_page'...");
      const pageResp = await sendRequest('tools/call', {
        name: 'create_page',
        arguments: { pageName: "Sales YoY Dashboard" }
      });
      const pageResult = JSON.parse(pageResp.result.content[0].text);
      assert(!pageResp.result.isError);
      const pageId = pageResult.pageId;
      assert(pageId, "Page ID should be generated");
      console.log(`✓ 'create_page' created page with ID: ${pageId}`);

      // Verify page.json exists and conforms to schema
      const pageJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'page.json');
      assert(fs.existsSync(pageJsonPath), "page.json file should exist");
      const pageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
      assert.equal(pageJson.displayName, "Sales YoY Dashboard");
      assert.equal(pageJson.$schema, "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json");
      console.log("✓ Checked page.json structure.");

      // 5. Add Visual: Pie Chart
      console.log("Testing 'add_visual' for pieChart...");
      const pieResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "pieChart",
          fields: {
            legend: "Product.Name",
            value: "Sales.TotalSales"
          },
          layout: { x: 50, y: 50, width: 300, height: 300 }
        }
      });
      const pieResult = JSON.parse(pieResp.result.content[0].text);
      assert(!pieResp.result.isError);
      const pieVisualId = pieResult.visualId;
      assert(pieVisualId);
      console.log(`✓ 'add_visual' (pieChart) created visual ID: ${pieVisualId}`);

      // Verify pie visual file content
      const pieJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', pieVisualId, 'visual.json');
      assert(fs.existsSync(pieJsonPath), "pie visual.json should exist");
      const pieJson = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      assert.equal(pieJson.$schema, "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json");
      assert.equal(pieJson.visual.visualType, "pieChart");
      assert(pieJson.visual.query.queryState.Legend);
      assert(pieJson.visual.query.queryState.Y);
      console.log("✓ Checked pie visual.json content.");

      // 6. Create Table and Matrix via 'create_table'
      console.log("Testing 'create_table' (regular table)...");
      const tableResp = await sendRequest('tools/call', {
        name: 'create_table',
        arguments: {
          pageId,
          isMatrix: false,
          columns: ["Product.Name", "Sales.TotalSales", "Sales.YoYGrowth"],
          layout: { x: 400, y: 50, width: 400, height: 300 }
        }
      });
      const tableResult = JSON.parse(tableResp.result.content[0].text);
      assert(!tableResp.result.isError);
      const tableVisualId = tableResult.visualId;
      assert(tableVisualId);
      console.log(`✓ 'create_table' (table) created visual ID: ${tableVisualId}`);

      // Verify table visual.json
      const tableJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', tableVisualId, 'visual.json');
      const tableJson = JSON.parse(fs.readFileSync(tableJsonPath, 'utf8'));
      assert.equal(tableJson.visual.visualType, "table");
      assert.equal(tableJson.visual.query.queryState.Values.projections.length, 3);
      console.log("✓ Checked table visual.json projections.");

      console.log("Testing 'create_table' (matrix)...");
      const matrixResp = await sendRequest('tools/call', {
        name: 'create_table',
        arguments: {
          pageId,
          isMatrix: true,
          rows: ["Geography.Country"],
          columns: ["Date.Year"],
          values: ["Sales.TotalSales"],
          layout: { x: 50, y: 400, width: 500, height: 250 }
        }
      });
      const matrixResult = JSON.parse(matrixResp.result.content[0].text);
      assert(!matrixResp.result.isError);
      const matrixVisualId = matrixResult.visualId;
      console.log(`✓ 'create_table' (matrix) created visual ID: ${matrixVisualId}`);

      // Verify matrix visual.json
      const matrixJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', matrixVisualId, 'visual.json');
      const matrixJson = JSON.parse(fs.readFileSync(matrixJsonPath, 'utf8'));
      assert.equal(matrixJson.visual.visualType, "pivotTable");
      assert(matrixJson.visual.query.queryState.Rows);
      assert(matrixJson.visual.query.queryState.Columns);
      assert(matrixJson.visual.query.queryState.Values);
      console.log("✓ Checked matrix visual.json query state.");

      // 7. Format Visual
      console.log("Testing 'format_visual' on pie chart...");
      const formatResp = await sendRequest('tools/call', {
        name: 'format_visual',
        arguments: {
          pageId,
          visualId: pieVisualId,
          title: {
            text: "Sales Breakdown by Product",
            fontSize: 14,
            alignment: "Center",
            fontColor: "#D61A3C"
          },
          dataLabels: {
            show: true,
            fontSize: 10,
            color: "#333333"
          },
          containerStyle: {
            borderShow: true,
            borderColor: "#D61A3C",
            backgroundShow: true,
            backgroundTransparency: 10
          },
          legend: {
            show: true,
            position: "Right"
          }
        }
      });
      assert(!formatResp.result.isError);
      console.log("✓ 'format_visual' executed successfully.");

      // Verify formatting expressions inside the formatted visual
      const formattedPieJson = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      const objs = formattedPieJson.visual.objects;
      assert(objs);
      assert.equal(objs.title[0].properties.text.expr.Literal.Value, "'Sales Breakdown by Product'");
      assert.equal(objs.title[0].properties.alignment.expr.Literal.Value, "'Center'");
      assert.equal(objs.title[0].properties.fontColor.solid.color.expr.Literal.Value, "'#D61A3C'");
      assert.equal(objs.labels[0].properties.show.expr.Literal.Value, "true");
      assert.equal(objs.border[0].properties.show.expr.Literal.Value, "true");
      assert.equal(objs.border[0].properties.color.solid.color.expr.Literal.Value, "'#D61A3C'");
      assert.equal(objs.legend[0].properties.position.expr.Literal.Value, "'Right'");
      console.log("✓ Verified expression-based literal single-quoted properties in formatted visual.json.");

      // 8. Add Action Button
      console.log("Testing 'add_action_button'...");
      const btnResp = await sendRequest('tools/call', {
        name: 'add_action_button',
        arguments: {
          pageId,
          buttonType: "pageNavigation",
          label: "View Detailed Reports",
          targetPageName: "DetailPage_123",
          layout: { x: 900, y: 50, width: 150, height: 40 }
        }
      });
      const btnResult = JSON.parse(btnResp.result.content[0].text);
      assert(!btnResp.result.isError);
      const btnVisualId = btnResult.visualId;
      assert(btnVisualId);
      console.log(`✓ 'add_action_button' created button ID: ${btnVisualId}`);

      // Verify button JSON
      const btnJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', btnVisualId, 'visual.json');
      const btnJson = JSON.parse(fs.readFileSync(btnJsonPath, 'utf8'));
      assert.equal(btnJson.visual.visualType, "actionButton");
      assert.equal(btnJson.visual.objects.action[0].properties.type.expr.Literal.Value, "'PageNavigation'");
      assert.equal(btnJson.visual.objects.action[0].properties.page.expr.Literal.Value, "'DetailPage_123'");
      console.log("✓ Checked action button properties.");

      // 9. Sync Slicers
      console.log("Testing 'sync_slicers'...");
      // Add a slicer first
      const slicerResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "slicer",
          fields: { field: "Geography.Country", isDropdown: true },
          layout: { x: 900, y: 150, width: 200, height: 80 }
        }
      });
      const slicerVisualId = JSON.parse(slicerResp.result.content[0].text).visualId;
      
      const syncResp = await sendRequest('tools/call', {
        name: 'sync_slicers',
        arguments: {
          pageId,
          visualId: slicerVisualId,
          syncPageIds: ["OtherPage_1", "OtherPage_2"]
        }
      });
      assert(!syncResp.result.isError);
      console.log("✓ 'sync_slicers' executed successfully.");

      // Verify sync settings in visual.json
      const slicerJsonPath = path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', slicerVisualId, 'visual.json');
      const slicerJson = JSON.parse(fs.readFileSync(slicerJsonPath, 'utf8'));
      assert.equal(slicerJson.visual.objects.slicerSync[0].properties.sync.expr.Literal.Value, "true");
      console.log("✓ Checked slicerSync config.");

      // 10. Group Visuals
      console.log("Testing 'group_visuals'...");
      const groupResp = await sendRequest('tools/call', {
        name: 'group_visuals',
        arguments: {
          pageId,
          visualIds: [pieVisualId, tableVisualId],
          groupName: "KeyChartsGroup"
        }
      });
      const groupResult = JSON.parse(groupResp.result.content[0].text);
      assert(!groupResp.result.isError);
      const groupId = groupResult.groupId;
      assert(groupId);
      console.log(`✓ 'group_visuals' created group ID: ${groupId}`);

      // Verify group parent binding
      const groupedPieJson = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      assert.equal(groupedPieJson.parentGroupName, groupId);
      console.log("✓ Verified child visual contains parentGroupName property referencing the group.");

      // 11. Auto Arrange Page (KPI Header)
      console.log("Testing 'auto_arrange_page' (kpiHeader)...");
      const arrResp1 = await sendRequest('tools/call', {
        name: 'auto_arrange_page',
        arguments: { pageId, template: "kpiHeader" }
      });
      assert(!arrResp1.result.isError);
      
      // Verify visual locations updated
      const arrangedSlicerJson = JSON.parse(fs.readFileSync(slicerJsonPath, 'utf8'));
      // Slicers are cards/slicers so should be arranged in the KPI header area (y: 30)
      assert.equal(arrangedSlicerJson.position.y, 30);
      console.log("✓ 'auto_arrange_page' (kpiHeader) positions correct.");

      // 12. Auto Arrange Page (alignLeft)
      console.log("Testing 'auto_arrange_page' (alignLeft)...");
      const arrResp2 = await sendRequest('tools/call', {
        name: 'auto_arrange_page',
        arguments: { pageId, template: "alignLeft" }
      });
      assert(!arrResp2.result.isError);
      const arrPieJson2 = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      assert.equal(arrPieJson2.position.x, 30);
      assert.equal(arrPieJson2.position.width, 400);
      console.log("✓ 'auto_arrange_page' (alignLeft) positions correct.");

      // 13. Auto Arrange Page (alignTop)
      console.log("Testing 'auto_arrange_page' (alignTop)...");
      const arrResp3 = await sendRequest('tools/call', {
        name: 'auto_arrange_page',
        arguments: { pageId, template: "alignTop" }
      });
      assert(!arrResp3.result.isError);
      const arrPieJson3 = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      assert.equal(arrPieJson3.position.y, 30);
      assert.equal(arrPieJson3.position.height, 200);
      console.log("✓ 'auto_arrange_page' (alignTop) positions correct.");

      // 14. Delete Visual
      console.log("Testing 'delete_visual'...");
      const delResp = await sendRequest('tools/call', {
        name: 'delete_visual',
        arguments: { pageId, visualId: tableVisualId }
      });
      assert(!delResp.result.isError);
      assert(!fs.existsSync(tableJsonPath), "table visual folder should be deleted");
      console.log("✓ 'delete_visual' successfully removed the visual folder.");

      console.log("\n★ ALL TESTS PASSED SUCCESSFULLY! ★\n");
      mcp.kill();
      cleanupMockReport();
      process.exit(0);

    } catch (err) {
      console.error("\n❌ TEST FAILURE:", err);
      mcp.kill();
      cleanupMockReport();
      process.exit(1);
    }
  }

  // Trigger test script
  runTests();
}

runMcpSession();
