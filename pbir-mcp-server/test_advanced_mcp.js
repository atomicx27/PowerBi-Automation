const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;

const tempReportPath = path.join(__dirname, 'temp_test_report.Report');
const tempModelPath = path.join(__dirname, 'temp_test_report.SemanticModel');

// Helper to setup mock PBIR folder
function setupMockReport() {
  if (fs.existsSync(tempReportPath)) {
    fs.rmSync(tempReportPath, { recursive: true, force: true });
  }
  if (fs.existsSync(tempModelPath)) {
    fs.rmSync(tempModelPath, { recursive: true, force: true });
  }

  // Create report folder
  fs.mkdirSync(tempReportPath, { recursive: true });
  fs.writeFileSync(path.join(tempReportPath, 'definition.pbir'), JSON.stringify({
    "version": "1.0",
    "datasetReference": {
      "byPath": null
    }
  }, null, 2));

  const defDir = path.join(tempReportPath, 'definition');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'report.json'), JSON.stringify({
    "config": {}
  }, null, 2));

  // Create semantic model folder
  const modelDefDir = path.join(tempModelPath, 'definition');
  const modelTablesDir = path.join(modelDefDir, 'tables');
  fs.mkdirSync(modelTablesDir, { recursive: true });

  fs.writeFileSync(path.join(modelDefDir, 'model.tmdl'), `model ModelName\n\nref table financials\n\nref cultureInfo en-US\n`);
  fs.writeFileSync(path.join(modelDefDir, 'relationships.tmdl'), ``);
  fs.writeFileSync(path.join(modelTablesDir, 'financials.tmdl'), `table financials\n\tlineageTag: tag-financials\n\n\tcolumn Date\n\t\tdataType: dateTime\n\n\tmeasure Sales = SUM(financials[Gross Sales])\n\n\tpartition financials = mxt\n\t\tsource = ...\n`);
}

// Clean up helper
function cleanupMockReport() {
  if (fs.existsSync(tempReportPath)) {
    fs.rmSync(tempReportPath, { recursive: true, force: true });
  }
  if (fs.existsSync(tempModelPath)) {
    fs.rmSync(tempModelPath, { recursive: true, force: true });
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
        'auto_arrange_page', 'add_action_button', 'group_visuals', 'sync_slicers',
        'apply_theme', 'audit_layout', 'create_date_table', 'create_calculated_column',
        'validate_measures', 'create_kpi', 'clone_page', 'duplicate_visual',
        'set_conditional_formatting', 'add_bookmark', 'export_page_summary',
        'set_page_background', 'manage_filters', 'set_visual_interactions',
        'add_tooltip_page', 'snapshot_report', 'diff_reports', 'validate_report'
      ];
      
      for (const tName of expectedTools) {
        assert(toolNames.includes(tName), `Missing tool registration: ${tName}`);
      }
      console.log("✓ 'tools/list' contains all expected tool definitions.");

      // Check the visualType enum has pieChart, donutChart, table, pivotTable
      const addVisualTool = tools.find(t => t.name === 'add_visual');
      const visualTypeEnum = addVisualTool.inputSchema.properties.visualType.enum;
      const expectedVisualTypes = ['pieChart', 'donutChart', 'table', 'pivotTable', 'gauge', 'kpi', 'funnel', 'ribbonChart', 'decompositionTree', 'keyInfluencers', 'map', 'filledMap', 'lineClusteredColumnComboChart', 'lineStackedColumnComboChart', 'areaChart', 'stackedAreaChart', 'stackedColumnChart', 'stackedBarChart', 'hundredPercentStackedColumnChart', 'hundredPercentStackedBarChart', 'multiRowCard', 'basicShape', 'image'];
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
       assert(pieJson.visual.query.queryState.Category);
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
            color: "#333333",
            labelStyle: "Category, percent of total"
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
      assert.equal(objs.labels[0].properties.labelStyle.expr.Literal.Value, "'Category, percent of total'");
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
      assert.equal(btnJson.visual.objects.text[0].properties.show.expr.Literal.Value, "true");
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
      // --- Phase 1: Modeling & DAX Foundation Tests ---
      console.log("Testing 'create_date_table'...");
      const dateTableResp = await sendRequest('tools/call', {
        name: 'create_date_table',
        arguments: {
          tableName: "DateTable",
          startDate: "2013-01-01",
          endDate: "2014-12-31",
          fiscalYearStartMonth: 4,
          relationshipColumn: "financials.Date"
        }
      });
      assert(!dateTableResp.result.isError);
      assert(fs.existsSync(path.join(tempModelPath, 'definition', 'tables', 'DateTable.tmdl')), "DateTable.tmdl should exist");
      const dateTableContent = fs.readFileSync(path.join(tempModelPath, 'definition', 'tables', 'DateTable.tmdl'), 'utf8');
      assert(dateTableContent.includes('FiscalYear = IF(MONTH([Date]) >= 4'));
      console.log("✓ 'create_date_table' success.");

      console.log("Testing 'create_calculated_column'...");
      const calcColResp = await sendRequest('tools/call', {
        name: 'create_calculated_column',
        arguments: {
          tableName: "financials",
          columns: [
            {
              name: "Profit Tier",
              expression: 'SWITCH(TRUE(), financials[Profit] > 10000, "High", "Low")',
              dataType: "string"
            }
          ]
        }
      });
      assert(!calcColResp.result.isError);
      const financialsContent = fs.readFileSync(path.join(tempModelPath, 'definition', 'tables', 'financials.tmdl'), 'utf8');
      assert(financialsContent.includes("column 'Profit Tier' = SWITCH("));
      console.log("✓ 'create_calculated_column' success.");

      console.log("Testing 'validate_measures' offline error handling...");
      const valMeasuresResp = await sendRequest('tools/call', {
        name: 'validate_measures',
        arguments: { mode: "syntax" }
      });
      assert(valMeasuresResp.result.isError);
      assert(valMeasuresResp.result.content[0].text.includes("Could not find any active msmdsrv.exe listening ports"));
      console.log("✓ 'validate_measures' offline check correct.");

      console.log("Testing 'create_kpi'...");
      const kpiResp = await sendRequest('tools/call', {
        name: 'create_kpi',
        arguments: {
          tableName: "financials",
          measureName: "Sales",
          targetValue: "TotalSalesTarget",
          statusThresholds: {
            good: 100,
            warning: 80
          }
        }
      });
      assert(!kpiResp.result.isError);
      const financialsKpiContent = fs.readFileSync(path.join(tempModelPath, 'definition', 'tables', 'financials.tmdl'), 'utf8');
      assert(financialsKpiContent.includes("kpi"));
      assert(financialsKpiContent.includes("target = [TotalSalesTarget]"));
      console.log("✓ 'create_kpi' success.");

      // --- Phase 2: High-Impact Productivity Tests ---
      console.log("Testing 'clone_page'...");
      const cloneResp = await sendRequest('tools/call', {
        name: 'clone_page',
        arguments: {
          sourcePageId: pageId,
          newPageName: "Sales YoY Cloned"
        }
      });
      assert(!cloneResp.result.isError);
      const cloneResult = JSON.parse(cloneResp.result.content[0].text);
      const newPageId = cloneResult.newPageId;
      assert(newPageId);
      assert(fs.existsSync(path.join(tempReportPath, 'definition', 'pages', newPageId, 'page.json')));
      console.log("✓ 'clone_page' success.");

      console.log("Testing 'duplicate_visual'...");
      const dupVisualResp = await sendRequest('tools/call', {
        name: 'duplicate_visual',
        arguments: {
          sourcePageId: pageId,
          sourceVisualId: pieVisualId,
          offsetX: 50,
          offsetY: 50
        }
      });
      assert(!dupVisualResp.result.isError);
      const dupVisualResult = JSON.parse(dupVisualResp.result.content[0].text);
      const duplicatedVisualId = dupVisualResult.newVisualId;
      assert(duplicatedVisualId);
      assert(fs.existsSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', duplicatedVisualId, 'visual.json')));
      console.log("✓ 'duplicate_visual' success.");

      console.log("Testing 'set_conditional_formatting' (colorScale)...");
      const condFmtResp = await sendRequest('tools/call', {
        name: 'set_conditional_formatting',
        arguments: {
          pageId,
          visualId: pieVisualId,
          rules: {
            type: "colorScale",
            field: "financials.Profit",
            minColor: "#FF0000",
            maxColor: "#00FF00"
          }
        }
      });
      assert(!condFmtResp.result.isError);
      const pieVisualJson = JSON.parse(fs.readFileSync(pieJsonPath, 'utf8'));
      assert(pieVisualJson.visual.objects.dataPoint[0].properties.fill.colorScale);
      console.log("✓ 'set_conditional_formatting' success.");

      console.log("Testing 'add_bookmark'...");
      const bookmarkResp = await sendRequest('tools/call', {
        name: 'add_bookmark',
        arguments: {
          bookmarkName: "All Countries View",
          pageId
        }
      });
      assert(!bookmarkResp.result.isError);
      const bookmarkResult = JSON.parse(bookmarkResp.result.content[0].text);
      assert(bookmarkResult.bookmarkId);
      assert(fs.existsSync(path.join(tempReportPath, 'definition', 'bookmarks', `${bookmarkResult.bookmarkId}.bookmark.json`)));
      console.log("✓ 'add_bookmark' success.");

      console.log("Testing 'export_page_summary'...");
      const summaryResp = await sendRequest('tools/call', {
        name: 'export_page_summary',
        arguments: {
          pageId,
          format: "markdown"
        }
      });
      assert(!summaryResp.result.isError);
      const summaryResult = JSON.parse(summaryResp.result.content[0].text);
      assert(summaryResult.markdown);
      assert(summaryResult.markdown.includes("Page Summary:"));
      console.log("✓ 'export_page_summary' success.");

      // --- Phase 3: Layout & UX Intelligence Tests ---
      console.log("Testing 'set_page_background'...");
      const bgResp = await sendRequest('tools/call', {
        name: 'set_page_background',
        arguments: {
          pageId,
          type: "solid",
          color: "#E5E5E5",
          transparency: 10
        }
      });
      assert(!bgResp.result.isError);
      const updatedPageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
      assert(updatedPageJson.objects.background[0].properties.color);
      console.log("✓ 'set_page_background' success.");

      console.log("Testing 'manage_filters' (add report filter)...");
      const filterResp = await sendRequest('tools/call', {
        name: 'manage_filters',
        arguments: {
          scope: "report",
          operation: "add",
          filter: {
            field: "financials.Country",
            operator: "eq",
            values: ["USA", "Canada"]
          }
        }
      });
      assert(!filterResp.result.isError);
      const reportJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'report.json'), 'utf8'));
      assert(reportJson.filterConfig.filters.length > 0);
      console.log("✓ 'manage_filters' success.");

      console.log("Testing 'set_visual_interactions'...");
      const interactionResp = await sendRequest('tools/call', {
        name: 'set_visual_interactions',
        arguments: {
          pageId,
          sourceVisualId: pieVisualId,
          interactions: [
            {
              targetVisualId: slicerVisualId,
              type: "none"
            }
          ]
        }
      });
      assert(!interactionResp.result.isError);
      const updatedPageJson2 = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
      assert.equal(updatedPageJson2.visualInteractions[0].source, pieVisualId);
      assert.equal(updatedPageJson2.visualInteractions[0].type, "NoFilter");
      console.log("✓ 'set_visual_interactions' success.");

      console.log("Testing 'add_tooltip_page'...");
      const tooltipResp = await sendRequest('tools/call', {
        name: 'add_tooltip_page',
        arguments: {
          pageName: "Custom Hover Tooltip",
          width: 300,
          height: 200
        }
      });
      assert(!tooltipResp.result.isError);
      const tooltipResult = JSON.parse(tooltipResp.result.content[0].text);
      assert(tooltipResult.pageId);
      assert(fs.existsSync(path.join(tempReportPath, 'definition', 'pages', tooltipResult.pageId, 'page.json')));
      console.log("✓ 'add_tooltip_page' success.");

      // --- Phase 4: DevOps & Governance Tests ---
      console.log("Testing 'snapshot_report'...");
      const snapshotResp = await sendRequest('tools/call', {
        name: 'snapshot_report',
        arguments: {
          label: "before-deletion"
        }
      });
      assert(!snapshotResp.result.isError);
      const snapshotResult = JSON.parse(snapshotResp.result.content[0].text);
      assert(snapshotResult.snapshotPath);
      assert(fs.existsSync(path.join(snapshotResult.snapshotPath, 'manifest.json')));
      console.log("✓ 'snapshot_report' success.");

      console.log("Testing 'diff_reports'...");
      const diffResp = await sendRequest('tools/call', {
        name: 'diff_reports',
        arguments: {
          sourcePath: snapshotResult.snapshotPath,
          format: "json"
        }
      });
      assert(!diffResp.result.isError);
      const diffResult = JSON.parse(diffResp.result.content[0].text);
      assert(diffResult.pages);
      console.log("✓ 'diff_reports' success.");

      console.log("Testing 'validate_report'...");
      const validateResp = await sendRequest('tools/call', {
        name: 'validate_report',
        arguments: {
          fix: true
        }
      });
      assert(!validateResp.result.isError);
      const validateResult = JSON.parse(validateResp.result.content[0].text);
      assert(Array.isArray(validateResult.issues));
      console.log("✓ 'validate_report' success.");

      // --- Advanced Visual Type Generation Tests ---
      console.log("Testing 'add_visual' for gauge...");
      const gaugeResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "gauge",
          fields: {
            value: "financials.Sales",
            targetValue: "TotalSalesTarget"
          }
        }
      });
      assert(!gaugeResp.result.isError);
      const gaugeId = JSON.parse(gaugeResp.result.content[0].text).visualId;
      const gaugeJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', gaugeId, 'visual.json'), 'utf8'));
      assert.equal(gaugeJson.visual.visualType, "gauge");
      assert(gaugeJson.visual.query.queryState.Values);
      assert(gaugeJson.visual.query.queryState.TargetValue);
      console.log("✓ 'add_visual' (gauge) success.");

      console.log("Testing 'add_visual' for decompositionTree...");
      const dtResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "decompositionTree",
          fields: {
            analyze: "financials.Sales",
            explainBy: ["financials.Country", "financials.Segment"]
          }
        }
      });
      assert(!dtResp.result.isError);
      const dtId = JSON.parse(dtResp.result.content[0].text).visualId;
      const dtJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', dtId, 'visual.json'), 'utf8'));
      assert.equal(dtJson.visual.visualType, "decompositionTreeVisual");
      assert(dtJson.visual.query.queryState.Y);
      assert.equal(dtJson.visual.query.queryState.Category.projections.length, 2);
      console.log("✓ 'add_visual' (decompositionTree) success.");

      console.log("Testing 'add_visual' for map...");
      const mapResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "map",
          fields: {
            location: "financials.Country",
            size: "financials.Sales"
          }
        }
      });
      assert(!mapResp.result.isError);
      const mapId = JSON.parse(mapResp.result.content[0].text).visualId;
      const mapJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', mapId, 'visual.json'), 'utf8'));
      assert.equal(mapJson.visual.visualType, "map");
      assert(mapJson.visual.query.queryState.Location);
      assert(mapJson.visual.query.queryState.Size);
      console.log("✓ 'add_visual' (map) success.");

      console.log("Testing 'add_visual' for lineClusteredColumnComboChart...");
      const comboResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "lineClusteredColumnComboChart",
          fields: {
            xAxis: "financials.Date",
            columnValues: ["financials.Sales"],
            lineValues: ["financials.Profit"]
          }
        }
      });
      assert(!comboResp.result.isError);
      const comboId = JSON.parse(comboResp.result.content[0].text).visualId;
      const comboJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', comboId, 'visual.json'), 'utf8'));
      assert.equal(comboJson.visual.visualType, "lineClusteredColumnComboChart");
      assert(comboJson.visual.query.queryState.Category);
      assert(comboJson.visual.query.queryState.Y);
      assert(comboJson.visual.query.queryState.Y2);
      console.log("✓ 'add_visual' (combo chart) success.");

      // --- Category 1 Visual Type Generation Tests ---
      console.log("Testing 'add_visual' for stackedColumnChart...");
      const stackedResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "stackedColumnChart",
          fields: {
            xAxis: "financials.Country",
            series: "financials.Segment",
            yAxis: ["financials.Sales"]
          }
        }
      });
      assert(!stackedResp.result.isError);
      const stackedId = JSON.parse(stackedResp.result.content[0].text).visualId;
      const stackedJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', stackedId, 'visual.json'), 'utf8'));
      assert.equal(stackedJson.visual.visualType, "columnChart");
      assert(stackedJson.visual.query.queryState.Category);
      assert(stackedJson.visual.query.queryState.Series);
      assert(stackedJson.visual.query.queryState.Y);
      console.log("✓ 'add_visual' (stackedColumnChart) success.");

      console.log("Testing 'add_visual' for multiRowCard...");
      const mrcResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "multiRowCard",
          fields: {
            values: ["financials.Sales", "financials.Profit"]
          }
        }
      });
      assert(!mrcResp.result.isError);
      const mrcId = JSON.parse(mrcResp.result.content[0].text).visualId;
      const mrcJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', mrcId, 'visual.json'), 'utf8'));
      assert.equal(mrcJson.visual.visualType, "multiRowCard");
      assert.equal(mrcJson.visual.query.queryState.Values.projections.length, 2);
      console.log("✓ 'add_visual' (multiRowCard) success.");

      console.log("Testing 'add_visual' for basicShape...");
      const shapeResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "basicShape",
          fields: {
            shapeType: "Oval"
          }
        }
      });
      assert(!shapeResp.result.isError);
      const shapeId = JSON.parse(shapeResp.result.content[0].text).visualId;
      const shapeJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', shapeId, 'visual.json'), 'utf8'));
      assert.equal(shapeJson.visual.visualType, "basicShape");
      assert.equal(shapeJson.visual.objects.shape[0].properties.shapeType.expr.Literal.Value, "'Oval'");
      assert(!shapeJson.visual.query, "basicShape should not have a query block");
      console.log("✓ 'add_visual' (basicShape) success.");

      console.log("Testing 'add_visual' for image...");
      const imageResp = await sendRequest('tools/call', {
        name: 'add_visual',
        arguments: {
          pageId,
          visualType: "image",
          fields: {
            url: "StaticResources/RegisteredResources/logo.png"
          }
        }
      });
      assert(!imageResp.result.isError);
      const imageId = JSON.parse(imageResp.result.content[0].text).visualId;
      const imageJson = JSON.parse(fs.readFileSync(path.join(tempReportPath, 'definition', 'pages', pageId, 'visuals', imageId, 'visual.json'), 'utf8'));
      assert.equal(imageJson.visual.visualType, "image");
      assert.equal(imageJson.visual.objects.general[0].properties.imageUrl.expr.ResourcePackageItem.ItemName, "logo.png");
      assert(!imageJson.visual.query, "image should not have a query block");
      console.log("✓ 'add_visual' (image) success.");

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
