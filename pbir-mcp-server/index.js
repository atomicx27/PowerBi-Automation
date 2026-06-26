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

const knownMeasures = [
  'Total Sales', 'Sales YoY Growth', 'Total Profit', 'Profit Margin', 
  'Profit YoY Growth', 'Average Units Sold', 'Total COGS', 'Total Units Sold',
  'Sales MTD', 'Profit MTD', 'Sales QTD', 'Profit QTD',
  'Sales YTD', 'Profit YTD', 'Sales 3M Rolling', 'Profit 3M Rolling'
];
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
      "projections": (Array.isArray(fields.xAxis) ? fields.xAxis : [fields.xAxis]).map(x => getFieldProjection(x))
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
  } else if (visualType === 'pieChart' || visualType === 'donutChart') {
    visualObj.visual.query.queryState.Category = {
      "projections": [
        getFieldProjection(fields.legend)
      ]
    };
    visualObj.visual.query.queryState.Y = {
      "projections": [
        getFieldProjection(fields.value)
      ]
    };
  } else if (visualType === 'table') {
    visualObj.visual.query.queryState.Values = {
      "projections": (Array.isArray(fields.columns) ? fields.columns : [fields.columns]).map(c => getFieldProjection(c))
    };
  } else if (visualType === 'pivotTable') {
    if (fields.rows) {
      visualObj.visual.query.queryState.Rows = {
        "projections": (Array.isArray(fields.rows) ? fields.rows : [fields.rows]).map(r => getFieldProjection(r))
      };
    }
    if (fields.columns) {
      visualObj.visual.query.queryState.Columns = {
        "projections": (Array.isArray(fields.columns) ? fields.columns : [fields.columns]).map(c => getFieldProjection(c))
      };
    }
    if (fields.values) {
      visualObj.visual.query.queryState.Values = {
        "projections": (Array.isArray(fields.values) ? fields.values : [fields.values]).map(v => getFieldProjection(v))
      };
    }
  } else if (visualType === 'treemap') {
    const groupField = fields.group || fields.category;
    if (groupField) {
      visualObj.visual.query.queryState.Group = {
        "projections": (Array.isArray(groupField) ? groupField : [groupField]).map(g => getFieldProjection(g))
      };
    }
    const valueField = fields.value || fields.values;
    if (valueField) {
      visualObj.visual.query.queryState.Values = {
        "projections": [getFieldProjection(valueField)]
      };
    }
  } else if (visualType === 'waterfallChart') {
    const categoryField = fields.category || fields.xAxis;
    if (categoryField) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(categoryField) ? categoryField : [categoryField]).map(c => getFieldProjection(c))
      };
    }
    const yField = fields.yAxis || fields.y || fields.value;
    if (yField) {
      visualObj.visual.query.queryState.Y = {
        "projections": (Array.isArray(yField) ? yField : [yField]).map(y => getFieldProjection(y))
      };
    }
  } else if (visualType === 'scatterChart') {
    if (fields.series || fields.details) {
      visualObj.visual.query.queryState.Series = {
        "projections": [getFieldProjection(fields.series || fields.details)]
      };
    }
    if (fields.x || fields.xAxis) {
      visualObj.visual.query.queryState.X = {
        "projections": [getFieldProjection(fields.x || fields.xAxis)]
      };
    }
    if (fields.y || fields.yAxis) {
      visualObj.visual.query.queryState.Y = {
        "projections": [getFieldProjection(fields.y || fields.yAxis)]
      };
    }
  }

  return { visualName, visualObj };
}

function applyVisualFormatting(visualObj, formatArgs) {
  if (!visualObj.visual.objects) {
    visualObj.visual.objects = {};
  }
  
  const objects = visualObj.visual.objects;
  
  if (formatArgs.title) {
    const titleProps = {};
    if (formatArgs.title.text !== undefined) {
      titleProps.text = { "expr": { "Literal": { "Value": `'${formatArgs.title.text}'` } } };
    }
    if (formatArgs.title.fontSize !== undefined) {
      titleProps.fontSize = { "expr": { "Literal": { "Value": `${formatArgs.title.fontSize}` } } };
    }
    if (formatArgs.title.alignment !== undefined) {
      titleProps.alignment = { "expr": { "Literal": { "Value": `'${formatArgs.title.alignment}'` } } };
    }
    if (formatArgs.title.fontColor !== undefined) {
      titleProps.fontColor = { "solid": { "color": { "expr": { "Literal": { "Value": `'${formatArgs.title.fontColor}'` } } } } };
    }
    objects.title = [{ "properties": titleProps }];
  }

  if (formatArgs.dataLabels) {
    const labelProps = {};
    if (formatArgs.dataLabels.show !== undefined) {
      labelProps.show = { "expr": { "Literal": { "Value": `${formatArgs.dataLabels.show}` } } };
    }
    if (formatArgs.dataLabels.fontSize !== undefined) {
      labelProps.fontSize = { "expr": { "Literal": { "Value": `${formatArgs.dataLabels.fontSize}` } } };
    }
    if (formatArgs.dataLabels.color !== undefined) {
      labelProps.color = { "solid": { "color": { "expr": { "Literal": { "Value": `'${formatArgs.dataLabels.color}'` } } } } };
    }
    if (formatArgs.dataLabels.labelStyle !== undefined) {
      labelProps.labelStyle = { "expr": { "Literal": { "Value": `'${formatArgs.dataLabels.labelStyle}'` } } };
    }
    objects.labels = [{ "properties": labelProps }];
  }

  if (formatArgs.containerStyle) {
    if (formatArgs.containerStyle.borderShow !== undefined || formatArgs.containerStyle.borderColor !== undefined) {
      const borderProps = {};
      if (formatArgs.containerStyle.borderShow !== undefined) {
        borderProps.show = { "expr": { "Literal": { "Value": `${formatArgs.containerStyle.borderShow}` } } };
      }
      if (formatArgs.containerStyle.borderColor !== undefined) {
        borderProps.color = { "solid": { "color": { "expr": { "Literal": { "Value": `'${formatArgs.containerStyle.borderColor}'` } } } } };
      }
      objects.border = [{ "properties": borderProps }];
    }
    if (formatArgs.containerStyle.backgroundShow !== undefined || formatArgs.containerStyle.backgroundTransparency !== undefined) {
      const bgProps = {};
      if (formatArgs.containerStyle.backgroundShow !== undefined) {
        bgProps.show = { "expr": { "Literal": { "Value": `${formatArgs.containerStyle.backgroundShow}` } } };
      }
      if (formatArgs.containerStyle.backgroundTransparency !== undefined) {
        bgProps.transparency = { "expr": { "Literal": { "Value": `${formatArgs.containerStyle.backgroundTransparency}` } } };
      }
      objects.background = [{ "properties": bgProps }];
    }
  }

  if (formatArgs.legend) {
    const legendProps = {};
    if (formatArgs.legend.show !== undefined) {
      legendProps.show = { "expr": { "Literal": { "Value": `${formatArgs.legend.show}` } } };
    }
    if (formatArgs.legend.position !== undefined) {
      legendProps.position = { "expr": { "Literal": { "Value": `'${formatArgs.legend.position}'` } } };
    }
    objects.legend = [{ "properties": legendProps }];
  }

  if (formatArgs.axisOverrides) {
    if (formatArgs.axisOverrides.xAxisShow !== undefined || formatArgs.axisOverrides.xAxisTitleShow !== undefined) {
      const xAxisProps = {};
      if (formatArgs.axisOverrides.xAxisShow !== undefined) {
        xAxisProps.show = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.xAxisShow}` } } };
      }
      if (formatArgs.axisOverrides.xAxisTitleShow !== undefined) {
        xAxisProps.showAxisTitle = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.xAxisTitleShow}` } } };
      }
      objects.categoryAxis = [{ "properties": xAxisProps }];
    }
    if (formatArgs.axisOverrides.yAxisShow !== undefined || formatArgs.axisOverrides.yAxisTitleShow !== undefined || formatArgs.axisOverrides.yAxisMin !== undefined || formatArgs.axisOverrides.yAxisMax !== undefined) {
      const yAxisProps = {};
      if (formatArgs.axisOverrides.yAxisShow !== undefined) {
        yAxisProps.show = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.yAxisShow}` } } };
      }
      if (formatArgs.axisOverrides.yAxisTitleShow !== undefined) {
        yAxisProps.showAxisTitle = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.yAxisTitleShow}` } } };
      }
      if (formatArgs.axisOverrides.yAxisMin !== undefined) {
        yAxisProps.start = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.yAxisMin}` } } };
      }
      if (formatArgs.axisOverrides.yAxisMax !== undefined) {
        yAxisProps.end = { "expr": { "Literal": { "Value": `${formatArgs.axisOverrides.yAxisMax}` } } };
      }
      objects.valueAxis = [{ "properties": yAxisProps }];
    }
  }
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
  },

  create_table: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, isMatrix, rows = [], columns = [], values = [], layout = {} } = args;
    if (!pageId) {
      throw new Error("Parameter 'pageId' is required.");
    }
    
    const visualType = isMatrix ? 'pivotTable' : 'table';
    const fields = isMatrix ? { rows, columns, values } : { columns };
    
    return tools.add_visual({ pageId, visualType, fields, layout });
  },

  format_visual: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, visualId, title, dataLabels, axisOverrides, containerStyle, legend } = args;
    if (!pageId || !visualId) {
      throw new Error("Parameters 'pageId' and 'visualId' are required.");
    }

    const visualJsonPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualId, 'visual.json');
    if (!fs.existsSync(visualJsonPath)) {
      throw new Error(`Visual '${visualId}' on page '${pageId}' not found.`);
    }

    const visualObj = JSON.parse(fs.readFileSync(visualJsonPath, 'utf8'));
    applyVisualFormatting(visualObj, { title, dataLabels, axisOverrides, containerStyle, legend });
    
    fs.writeFileSync(visualJsonPath, JSON.stringify(visualObj, null, 2), 'utf8');
    return { message: `Visual '${visualId}' updated successfully.` };
  },

  auto_arrange_page: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, template = 'dynamicGrid' } = args;
    if (!pageId) {
      throw new Error("Parameter 'pageId' is required.");
    }

    const visualsDir = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals');
    if (!fs.existsSync(visualsDir)) {
      return { message: "No visuals on this page to arrange." };
    }

    const visualNames = fs.readdirSync(visualsDir).filter(name => {
      return fs.statSync(path.join(visualsDir, name)).isDirectory();
    });

    const visuals = visualNames.map(name => {
      const jsonPath = path.join(visualsDir, name, 'visual.json');
      return {
        name,
        path: jsonPath,
        data: JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      };
    });

    if (visuals.length === 0) {
      return { message: "No visuals found on this page." };
    }

    if (template === 'kpiHeader') {
      const kpis = [];
      const charts = [];
      visuals.forEach(v => {
        const type = v.data.visual ? v.data.visual.visualType : 'group';
        if (type === 'card' || type === 'slicer') {
          kpis.push(v);
        } else {
          charts.push(v);
        }
      });

      const kpiWidth = 200;
      const kpiHeight = 100;
      const kpiPadding = 20;
      kpis.forEach((kpi, idx) => {
        kpi.data.position = {
          x: 30 + idx * (kpiWidth + kpiPadding),
          y: 30,
          width: kpiWidth,
          height: kpiHeight
        };
      });

      const chartY = 160;
      const chartHeight = 520;
      const chartPadding = 20;
      const chartCount = charts.length;
      if (chartCount > 0) {
        const chartWidth = Math.floor((1280 - 60 - chartPadding * (chartCount - 1)) / chartCount);
        charts.forEach((chart, idx) => {
          chart.data.position = {
            x: 30 + idx * (chartWidth + chartPadding),
            y: chartY,
            width: chartWidth,
            height: chartHeight
          };
        });
      }
    } else if (template === 'splitScreen' && visuals.length === 2) {
      const width = 590;
      const height = 660;
      visuals[0].data.position = { x: 30, y: 30, width, height };
      visuals[1].data.position = { x: 660, y: 30, width, height };
    } else if (template === 'alignLeft') {
      const padding = 30;
      const width = 400;
      const height = Math.max(50, Math.floor((720 - padding * (visuals.length + 1)) / visuals.length));
      visuals.forEach((visual, idx) => {
        visual.data.position = {
          x: padding,
          y: padding + idx * (height + padding),
          width,
          height
        };
      });
    } else if (template === 'alignTop') {
      const padding = 30;
      const height = 200;
      const width = Math.max(50, Math.floor((1280 - padding * (visuals.length + 1)) / visuals.length));
      visuals.forEach((visual, idx) => {
        visual.data.position = {
          x: padding + idx * (width + padding),
          y: padding,
          width,
          height
        };
      });
    } else {
      // Default: dynamicGrid
      const cols = Math.ceil(Math.sqrt(visuals.length));
      const rows = Math.ceil(visuals.length / cols);
      const padding = 30;
      const cardWidth = Math.floor((1280 - padding * (cols + 1)) / cols);
      const cardHeight = Math.floor((720 - padding * (rows + 1)) / rows);

      visuals.forEach((visual, idx) => {
        const colIdx = idx % cols;
        const rowIdx = Math.floor(idx / cols);
        visual.data.position = {
          x: padding + colIdx * (cardWidth + padding),
          y: padding + rowIdx * (cardHeight + padding),
          width: cardWidth,
          height: cardHeight
        };
      });
    }

    // Write changes back to disk
    visuals.forEach(v => {
      fs.writeFileSync(v.path, JSON.stringify(v.data, null, 2), 'utf8');
    });

    return { message: `Arranged ${visuals.length} visuals using template '${template}'.` };
  },

  add_action_button: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, buttonType, label, targetPageName, layout = {} } = args;
    if (!pageId || !buttonType) {
      throw new Error("Parameters 'pageId' and 'buttonType' are required.");
    }

    const visualName = `Button_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const visualObj = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
      "name": visualName,
      "position": {
        "x": layout.x || 0,
        "y": layout.y || 0,
        "width": layout.width || 120,
        "height": layout.height || 40
      },
      "visual": {
        "visualType": "actionButton",
        "objects": {
          "action": [
            {
              "properties": {
                "type": { "expr": { "Literal": { "Value": buttonType === 'pageNavigation' ? "'PageNavigation'" : "'ClearAllFilters'" } } }
              }
            }
          ],
          "text": [
            {
              "properties": {
                "show": { "expr": { "Literal": { "Value": "true" } } }
              }
            },
            {
              "selector": {
                "id": "default"
              },
              "properties": {
                "text": { "expr": { "Literal": { "Value": `'${label || (buttonType === 'pageNavigation' ? 'Go to Page' : 'Clear Filters')}'` } } }
              }
            }
          ]
        }
      }
    };

    if (buttonType === 'pageNavigation' && targetPageName) {
      visualObj.visual.objects.action[0].properties.page = {
        "expr": { "Literal": { "Value": `'${targetPageName}'` } }
      };
    }

    const visualFolder = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualName);
    fs.mkdirSync(visualFolder, { recursive: true });
    fs.writeFileSync(path.join(visualFolder, 'visual.json'), JSON.stringify(visualObj, null, 2), 'utf8');

    return {
      message: `Action button '${visualName}' of type '${buttonType}' created successfully.`,
      visualId: visualName
    };
  },

  group_visuals: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, visualIds, groupName = 'MyGroup' } = args;
    if (!pageId || !visualIds || !Array.isArray(visualIds)) {
      throw new Error("Parameters 'pageId' and 'visualIds' (array) are required.");
    }

    const groupContainerName = `Group_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

    const groupObj = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
      "name": groupContainerName,
      "position": {
        "x": 0,
        "y": 0,
        "width": 100,
        "height": 100
      },
      "visualGroup": {
        "displayName": groupName
      }
    };

    const visualsDir = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals');
    const groupFolder = path.join(visualsDir, groupContainerName);
    fs.mkdirSync(groupFolder, { recursive: true });
    fs.writeFileSync(path.join(groupFolder, 'visual.json'), JSON.stringify(groupObj, null, 2), 'utf8');

    visualIds.forEach(vid => {
      const childPath = path.join(visualsDir, vid, 'visual.json');
      if (fs.existsSync(childPath)) {
        const childObj = JSON.parse(fs.readFileSync(childPath, 'utf8'));
        childObj.parentGroupName = groupContainerName;
        fs.writeFileSync(childPath, JSON.stringify(childObj, null, 2), 'utf8');
      }
    });

    return {
      message: `Group '${groupName}' created as visual container '${groupContainerName}'.`,
      groupId: groupContainerName
    };
  },

  sync_slicers: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, visualId, syncPageIds = [] } = args;
    if (!pageId || !visualId) {
      throw new Error("Parameters 'pageId' and 'visualId' are required.");
    }

    const visualJsonPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualId, 'visual.json');
    if (!fs.existsSync(visualJsonPath)) {
      throw new Error(`Slicer visual '${visualId}' on page '${pageId}' not found.`);
    }

    const visualObj = JSON.parse(fs.readFileSync(visualJsonPath, 'utf8'));
    if (!visualObj.visual.objects) {
      visualObj.visual.objects = {};
    }
    visualObj.visual.objects.slicerSync = [
      {
        "properties": {
          "sync": { "expr": { "Literal": { "Value": "true" } } }
        }
      }
    ];

    fs.writeFileSync(visualJsonPath, JSON.stringify(visualObj, null, 2), 'utf8');
    return { message: `Slicer '${visualId}' sync settings updated.` };
  },

  apply_theme: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { themeName, colors, themeJson } = args;
    if (!themeName) {
      throw new Error("Parameter 'themeName' is required.");
    }

    const baseThemesDir = path.join(activeReportPath, 'StaticResources', 'SharedResources', 'BaseThemes');
    const registeredResourcesDir = path.join(activeReportPath, 'StaticResources', 'RegisteredResources');
    if (!fs.existsSync(registeredResourcesDir)) {
      fs.mkdirSync(registeredResourcesDir, { recursive: true });
    }

    let themeData = {};
    if (themeJson) {
      themeData = themeJson;
    } else {
      const baseThemePath = path.join(baseThemesDir, 'CY26SU05.json');
      if (fs.existsSync(baseThemePath)) {
        themeData = JSON.parse(fs.readFileSync(baseThemePath, 'utf8'));
      } else {
        themeData = {
          "name": themeName,
          "dataColors": ["#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7"],
          "foreground": "#252423",
          "background": "#FFFFFF"
        };
      }
    }

    themeData.name = themeName;
    if (colors && Array.isArray(colors)) {
      if (!themeData.dataColors) themeData.dataColors = [];
      for (let i = 0; i < colors.length; i++) {
        themeData.dataColors[i] = colors[i];
      }
      themeData.tableAccent = colors[0];
      themeData.maximum = colors[0];
      themeData.hyperlink = colors[0];
      themeData.visitedHyperlink = colors[0];
    }

    const targetThemePath = path.join(registeredResourcesDir, `${themeName}.json`);
    fs.writeFileSync(targetThemePath, JSON.stringify(themeData, null, 2), 'utf8');
    log(`Saved theme file to: ${targetThemePath}`);

    const reportJsonPath = path.join(activeReportPath, 'definition', 'report.json');
    if (fs.existsSync(reportJsonPath)) {
      const reportData = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
      
      if (!reportData.themeCollection) {
        reportData.themeCollection = {};
      }
      reportData.themeCollection.customTheme = {
        "name": themeName,
        "reportVersionAtImport": {
          "visual": "2.9.0",
          "report": "3.3.0",
          "page": "2.3.1"
        },
        "type": "RegisteredResources"
      };

      if (!Array.isArray(reportData.resourcePackages)) {
        reportData.resourcePackages = [];
      }

      const registeredPkgIdx = reportData.resourcePackages.findIndex(pkg => pkg.name === 'RegisteredResources');
      const themeItem = {
        "name": themeName,
        "path": `RegisteredResources/${themeName}.json`,
        "type": "CustomTheme"
      };

      if (registeredPkgIdx === -1) {
        reportData.resourcePackages.push({
          "name": "RegisteredResources",
          "type": "RegisteredResources",
          "items": [themeItem]
        });
      } else {
        const pkg = reportData.resourcePackages[registeredPkgIdx];
        if (!Array.isArray(pkg.items)) {
          pkg.items = [];
        }
        const itemIdx = pkg.items.findIndex(item => item.name === themeName);
        if (itemIdx === -1) {
          pkg.items.push(themeItem);
        } else {
          pkg.items[itemIdx] = themeItem;
        }
      }

      fs.writeFileSync(reportJsonPath, JSON.stringify(reportData, null, 2), 'utf8');
      log(`Updated report.json successfully at: ${reportJsonPath}`);
    } else {
      logError(`report.json not found at ${reportJsonPath}`);
    }

    return {
      message: `Theme '${themeName}' applied and registered successfully.`,
      themePath: targetThemePath
    };
  },

  audit_layout: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, spacing = 20, autoFix = true } = args;
    if (!pageId) {
      throw new Error("Parameter 'pageId' is required.");
    }

    const visualsDir = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals');
    if (!fs.existsSync(visualsDir)) {
      return { message: "No visuals folder found on this page.", overlaps: [], fixed: false };
    }

    const visualNames = fs.readdirSync(visualsDir).filter(name => {
      return fs.statSync(path.join(visualsDir, name)).isDirectory();
    });

    const visuals = visualNames.map(name => {
      const jsonPath = path.join(visualsDir, name, 'visual.json');
      return {
        name,
        path: jsonPath,
        data: JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      };
    });

    if (visuals.length === 0) {
      return { message: "No visuals found on this page.", overlaps: [], fixed: false };
    }

    function getOverlap(v1, v2) {
      const p1 = v1.data.position;
      const p2 = v2.data.position;
      if (!p1 || !p2) return null;
      
      const xOverlap = p1.x < p2.x + p2.width && p1.x + p1.width > p2.x;
      const yOverlap = p1.y < p2.y + p2.height && p1.y + p1.height > p2.y;
      
      if (xOverlap && yOverlap) {
        const xLen = Math.min(p1.x + p1.width, p2.x + p2.width) - Math.max(p1.x, p2.x);
        const yLen = Math.min(p1.y + p1.height, p2.y + p2.height) - Math.max(p1.y, p2.y);
        return xLen * yLen;
      }
      return null;
    }

    let overlapsDetected = [];
    let iterations = 0;
    const maxIterations = 100;
    let changed = false;

    while (iterations < maxIterations) {
      let overlapFound = false;
      overlapsDetected = [];

      for (let i = 0; i < visuals.length; i++) {
        for (let j = i + 1; j < visuals.length; j++) {
          const v1 = visuals[i];
          const v2 = visuals[j];
          const area = getOverlap(v1, v2);
          if (area !== null) {
            overlapFound = true;
            overlapsDetected.push({
              visualA: v1.name,
              visualB: v2.name,
              area: area
            });

            if (autoFix) {
              const p1 = v1.data.position;
              const p2 = v2.data.position;
              
              if (p2.y > p1.y) {
                p2.y = p1.y + p1.height + spacing;
              } else if (p1.y > p2.y) {
                p1.y = p2.y + p2.height + spacing;
              } else {
                if (p2.x >= p1.x) {
                  p2.y = p1.y + p1.height + spacing;
                } else {
                  p1.y = p2.y + p2.height + spacing;
                }
              }
              changed = true;
            }
          }
        }
      }

      if (!overlapFound || !autoFix) {
        break;
      }
      iterations++;
    }

    if (changed && autoFix) {
      visuals.forEach(v => {
        fs.writeFileSync(v.path, JSON.stringify(v.data, null, 2), 'utf8');
      });
    }

    return {
      message: changed ? `Resolved visual overlaps on page '${pageId}' after ${iterations} iterations.` : `Audited layout for page '${pageId}'.`,
      overlaps: overlapsDetected,
      fixed: changed,
      iterations: iterations
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
              description: "Add a visual chart (Card, Line Chart, Column Chart, Bar Chart, Slicer, Pie Chart, Donut Chart, Table, or Pivot Table) to an existing report page.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: {
                    type: "string",
                    description: "The folder/ID name of the page to add the visual to."
                  },
                  visualType: {
                    type: "string",
                    enum: ["card", "lineChart", "clusteredColumnChart", "clusteredBarChart", "slicer", "pieChart", "donutChart", "table", "pivotTable", "treemap", "waterfallChart", "scatterChart"],
                    description: "The visual type chart."
                  },
                  fields: {
                    type: "object",
                    description: "Field bindings. For card: {value: 'table.column'}. For chart: {xAxis: 'table.col', yAxis: ['table.col']}. For slicer: {field: 'table.col', isDropdown: true/false}. For pie/donut: {legend: 'table.col', value: 'table.col'}. For table: {columns: ['table.col']}. For pivotTable: {rows: ['table.col'], columns: ['table.col'], values: ['table.col']}. For treemap: {group: 'table.col', value: 'table.col'}. For waterfallChart: {category: 'table.col', yAxis: 'table.col'}. For scatterChart: {series: 'table.col', xAxis: 'table.col', yAxis: 'table.col'}."
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
            },
            {
              name: "create_table",
              description: "Create a Table or Matrix (Pivot Table) visual referencing selected model fields.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: {
                    type: "string",
                    description: "The folder/ID name of the page to add the visual to."
                  },
                  isMatrix: {
                    type: "boolean",
                    description: "True if creating a Pivot Table (Matrix), false for a regular Table."
                  },
                  columns: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of columns (dimensions) for the table or columns area of the matrix."
                  },
                  rows: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of rows (dimensions) for the matrix."
                  },
                  values: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of values (measures/fields) to display."
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
                required: ["pageId"]
              }
            },
            {
              name: "format_visual",
              description: "Modify visual layout styling, titles, borders, data labels, and colors.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID containing the visual." },
                  visualId: { type: "string", description: "ID/folder name of the visual." },
                  title: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      fontSize: { type: "integer" },
                      alignment: { type: "string", enum: ["Left", "Center", "Right"] },
                      fontColor: { type: "string", description: "Hex color code e.g. '#D61A3C'" }
                    }
                  },
                  dataLabels: {
                    type: "object",
                    properties: {
                      show: { type: "boolean" },
                      fontSize: { type: "integer" },
                      color: { type: "string", description: "Hex color code" },
                      labelStyle: { type: "string", description: "Label content style (e.g. 'Category, percent of total', 'Percent of total', 'Category, data value')" }
                    }
                  },
                  axisOverrides: {
                    type: "object",
                    properties: {
                      xAxisShow: { type: "boolean" },
                      xAxisTitleShow: { type: "boolean" },
                      yAxisShow: { type: "boolean" },
                      yAxisTitleShow: { type: "boolean" },
                      yAxisMin: { type: "number" },
                      yAxisMax: { type: "number" }
                    }
                  },
                  containerStyle: {
                    type: "object",
                    properties: {
                      borderShow: { type: "boolean" },
                      borderColor: { type: "string", description: "Hex color code" },
                      backgroundShow: { type: "boolean" },
                      backgroundTransparency: { type: "number", description: "0 to 100 percentage" }
                    }
                  },
                  legend: {
                    type: "object",
                    properties: {
                      show: { type: "boolean" },
                      position: { type: "string", description: "e.g. Top, Bottom, Left, Right" }
                    }
                  }
                },
                required: ["pageId", "visualId"]
              }
            },
            {
              name: "auto_arrange_page",
              description: "Align and lay out page visuals automatically using grid templates.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID to auto-arrange." },
                  template: {
                    type: "string",
                    enum: ["dynamicGrid", "kpiHeader", "splitScreen", "alignLeft", "alignTop"],
                    description: "Layout template selection."
                  }
                },
                required: ["pageId"]
              }
            },
            {
              name: "add_action_button",
              description: "Add an interactive action button (navigation or clearing filters).",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID to add the button to." },
                  buttonType: {
                    type: "string",
                    enum: ["pageNavigation", "clearFilters"],
                    description: "Type of interactive action."
                  },
                  label: { type: "string", description: "Text label of the button." },
                  targetPageName: { type: "string", description: "Target page ID/name for pageNavigation." },
                  layout: {
                    type: "object",
                    properties: {
                      x: { type: "integer" },
                      y: { type: "integer" },
                      width: { type: "integer" },
                      height: { type: "integer" }
                    }
                  }
                },
                required: ["pageId", "buttonType"]
              }
            },
            {
              name: "group_visuals",
              description: "Group multiple visuals together under a visual group folder.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID containing the visuals." },
                  visualIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of visual IDs to include in the group."
                  },
                  groupName: { type: "string", description: "Name of the visual group display." }
                },
                required: ["pageId", "visualIds"]
              }
            },
            {
              name: "sync_slicers",
              description: "Synchronize a slicer visual across other report pages.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID containing the slicer." },
                  visualId: { type: "string", description: "Slicer visual ID." },
                  syncPageIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of page IDs to synchronize this slicer with."
                  }
                },
                required: ["pageId", "visualId"]
              }
            },
            {
              name: "apply_theme",
              description: "Registers a custom color palette theme into the project's report.json and copies the theme file.",
              inputSchema: {
                type: "object",
                properties: {
                  themeName: {
                    type: "string",
                    description: "Unique name of the theme to create/apply."
                  },
                  colors: {
                    type: "array",
                    items: { "type": "string" },
                    description: "List of hex color codes to override the default theme dataColors."
                  },
                  themeJson: {
                    type: "object",
                    description: "Optional complete theme definition JSON object."
                  }
                },
                required: ["themeName"]
              }
            },
            {
              name: "audit_layout",
              description: "Scans all visual positions on a page, identifies overlaps, and optionally auto-shifts overlapping visuals to resolve layout collisions.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: {
                    type: "string",
                    description: "Page ID containing the visuals to audit."
                  },
                  spacing: {
                    type: "integer",
                    description: "The spacing distance in pixels to maintain between shifted visuals. Defaults to 20."
                  },
                  autoFix: {
                    type: "boolean",
                    description: "True to automatically resolve overlaps and update visual coordinate files. Defaults to true."
                  }
                },
                required: ["pageId"]
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
