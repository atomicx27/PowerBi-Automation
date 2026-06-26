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

const { execSync, spawn } = require('child_process');

function copyFolderSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    const stat = fs.lstatSync(path.join(from, element));
    if (stat.isFile()) {
      fs.copyFileSync(path.join(from, element), path.join(to, element));
    } else if (stat.isDirectory()) {
      copyFolderSync(path.join(from, element), path.join(to, element));
    }
  });
}

function getSemanticModelPath() {
  if (!activeReportPath) {
    throw new Error("No active report project connected. Call connect_project first.");
  }
  const pbirPath = path.join(activeReportPath, 'definition.pbir');
  if (fs.existsSync(pbirPath)) {
    try {
      const pbir = JSON.parse(fs.readFileSync(pbirPath, 'utf8'));
      if (pbir.datasetReference && pbir.datasetReference.byPath && pbir.datasetReference.byPath.path) {
        const relPath = pbir.datasetReference.byPath.path;
        const resolvedPath = path.resolve(activeReportPath, relPath);
        if (fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }
    } catch (e) {
      logError(`Error resolving semantic model path: ${e.message}`);
    }
  }
  
  const parentDir = path.dirname(activeReportPath);
  const items = fs.readdirSync(parentDir);
  const sibling = items.find(item => item.endsWith('.SemanticModel') && fs.statSync(path.join(parentDir, item)).isDirectory());
  if (sibling) {
    return path.join(parentDir, sibling);
  }
  
  throw new Error("Could not locate semantic model directory.");
}

function getActivePort() {
  try {
    const psCmd = 'Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in (Get-Process -Name msmdsrv -ErrorAction SilentlyContinue).Id } | Select-Object -ExpandProperty LocalPort';
    const output = execSync(`powershell -Command "${psCmd}"`, { shell: 'powershell.exe' }).toString().trim();
    if (output) {
      const ports = output.split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p));
      if (ports.length > 0) {
        return ports[0];
      }
    }
  } catch (e) {
    logError(`Failed to find active port via powershell: ${e.message}`);
  }
  return null;
}

function callModelingMcp(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const activePort = getActivePort();
    if (!activePort) {
      return reject(new Error("Could not find any active msmdsrv.exe listening ports. Is Power BI Desktop running?"));
    }

    const exePath = "C:\\Users\\GTXS3893\\AppData\\Local\\npm-cache\\_npx\\deea81b821a9ed55\\node_modules\\@microsoft\\powerbi-modeling-mcp-win32-x64\\dist\\powerbi-modeling-mcp.exe";
    let mcp;
    if (fs.existsSync(exePath)) {
      mcp = spawn(exePath, ['--start']);
    } else {
      mcp = spawn('npx', ['-y', '@microsoft/powerbi-modeling-mcp@latest', '--start'], { shell: true });
    }

    let buffer = '';
    let currentRequestId = 1;
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        mcp.kill();
        reject(new Error("Modeling MCP operation timed out."));
      }
    }, 15000); // 15s timeout

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
      if (finished) return;
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            const json = JSON.parse(trimmed);
            if (json.id === 1) {
              sendRequest("tools/call", {
                name: toolName,
                arguments: toolArgs
              });
            } else if (json.id === 2) {
              finished = true;
              clearTimeout(timeout);
              mcp.kill();
              if (json.result && json.result.isError) {
                reject(new Error(JSON.stringify(json.result.content)));
              } else {
                resolve(json.result);
              }
            }
          } catch (e) {
          }
        }
      }
    });

    mcp.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });

    setTimeout(() => {
      if (finished) return;
      sendRequest("tools/call", {
        name: "connection_operations",
        arguments: {
          request: {
            operation: "Connect",
            connectionString: `Provider=MSOLAP;Data Source=localhost:${activePort}`
          }
        }
      });
    }, 1500);
  });
}

function generateGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}


async function detectMinMaxDate(colName) {
  try {
    const daxQuery = `EVALUATE ROW("MinDate", MIN(${colName}), "MaxDate", MAX(${colName}))`;
    const result = await callModelingMcp("dax_query_operations", {
      request: {
        operation: "Execute",
        query: daxQuery
      }
    });
    const resObj = JSON.parse(result.content[0].text);
    if (resObj.data && resObj.data.Rows && resObj.data.Rows.length > 0) {
      const row = resObj.data.Rows[0];
      return {
        minDate: new Date(row["[MinDate]"]),
        maxDate: new Date(row["[MaxDate]"])
      };
    }
  } catch (e) {
    logError(`Could not auto-detect dates: ${e.message}`);
  }
  return { minDate: new Date('2013-01-01'), maxDate: new Date('2014-12-31') };
}

function generateDateTableTmdl(tableName, startDateStr, endDateStr, fiscalYearStartMonth) {
  const minDate = new Date(startDateStr);
  const maxDate = new Date(endDateStr);
  const startYear = minDate.getFullYear();
  const startMonth = minDate.getMonth() + 1;
  const startDay = minDate.getDate();
  const endYear = maxDate.getFullYear();
  const endMonth = maxDate.getMonth() + 1;
  const endDay = maxDate.getDate();

  return `table ${tableName}
	lineageTag: ${generateGuid()}

	column Date
		dataType: dateTime
		isNameInferred
		sourceColumn: [Date]
		summarizeBy: none

	column Year = YEAR([Date])
		dataType: int64
		summarizeBy: none

	column MonthNumber = MONTH([Date])
		dataType: int64
		summarizeBy: none

	column MonthName = FORMAT([Date], "MMMM")
		dataType: string
		summarizeBy: none
		sortByColumn: MonthNumber

	column Quarter = "Q" & INT((MONTH([Date]) + 2) / 3)
		dataType: string
		summarizeBy: none

	column FiscalYear = IF(MONTH([Date]) >= ${fiscalYearStartMonth}, YEAR([Date]), YEAR([Date]) - 1)
		dataType: int64
		summarizeBy: none

	column FiscalQuarter = "Q" & INT((MOD(MONTH([Date]) - ${fiscalYearStartMonth} + 12, 12) + 3) / 3)
		dataType: string
		summarizeBy: none

	column DayOfWeek = WEEKDAY([Date])
		dataType: int64
		summarizeBy: none

	column WeekNumber = WEEKNUM([Date])
		dataType: int64
		summarizeBy: none

	column IsWeekend = IF(WEEKDAY([Date]) IN {1, 7}, TRUE, FALSE)
		dataType: boolean
		summarizeBy: none

	partition ${tableName} = calculated
		mode: import
		source = CALENDAR(DATE(${startYear}, ${startMonth}, ${startDay}), DATE(${endYear}, ${endMonth}, ${endDay}))

	annotation BestPracticeAnalyzer_IgnoreRules = {"RuleIDs":["OBJECTS_SHOULD_HAVE_DESCRIPTION"]}
`;
}

function registerTableInModel(modelTmdlPath, tableName) {
  let content = fs.readFileSync(modelTmdlPath, 'utf8');
  if (content.includes(`ref table ${tableName}`)) {
    return;
  }
  
  const refTableRegex = /ref table .+/g;
  let match;
  let lastIndex = -1;
  while ((match = refTableRegex.exec(content)) !== null) {
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex !== -1) {
    content = content.slice(0, lastIndex) + `\nref table ${tableName}` + content.slice(lastIndex);
  } else {
    content = content.replace('ref cultureInfo', `ref table ${tableName}\n\nref cultureInfo`);
  }
  
  fs.writeFileSync(modelTmdlPath, content, 'utf8');
}

function addCalculatedColumnToTmdl(tmdlPath, colName, expression, dataType, formatString) {
  let content = fs.readFileSync(tmdlPath, 'utf8');
  
  let colSnippet = `\n\tcolumn '${colName}' = ${expression}\n\t\tdataType: ${dataType}\n`;
  if (formatString) {
    colSnippet += `\t\tformatString: ${formatString}\n`;
  }
  
  const partitionIndex = content.indexOf('\tpartition ');
  if (partitionIndex !== -1) {
    content = content.slice(0, partitionIndex) + colSnippet + content.slice(partitionIndex);
  } else {
    content += '\n' + colSnippet;
  }
  
  fs.writeFileSync(tmdlPath, content, 'utf8');
}

function addKpiToTmdl(tmdlPath, measureName, targetValue, statusThresholds, trendMeasure) {
  let content = fs.readFileSync(tmdlPath, 'utf8');
  
  const measureRegex = new RegExp(`^\\tmeasure\\s+('${measureName}'|${measureName})\\s*=\\s*(.+)$`, 'm');
  const match = measureRegex.exec(content);
  if (!match) {
    throw new Error(`Measure '${measureName}' not found in TMDL.`);
  }
  
  const startIndex = match.index;
  const lines = content.slice(startIndex).split('\n');
  let insertLineIndex = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !line.startsWith('\t\t') && !line.startsWith('\t')) {
      insertLineIndex = i;
      break;
    }
    if (line.startsWith('\t') && !line.startsWith('\t\t') && (line.includes('measure ') || line.includes('column ') || line.includes('partition ') || line.includes('hierarchy '))) {
      insertLineIndex = i;
      break;
    }
  }
  
  if (insertLineIndex === 0) {
    insertLineIndex = lines.length;
  }
  
  const targetExpr = typeof targetValue === 'number' ? `${targetValue}` : `[${targetValue}]`;
  const trendExpr = trendMeasure ? `\n\t\t\ttrend = [${trendMeasure}]` : '';
  
  const kpiBlock = `\n\t\tkpi
\t\t\ttarget = ${targetExpr}
\t\t\tstatusGraphics = 'Traffic Light'
\t\t\tstatusExpression = IF([${measureName}] >= ${statusThresholds.good}, 1, IF([${measureName}] >= ${statusThresholds.warning}, 0, -1))${trendExpr}`;

  let insertCharIndex = startIndex;
  for (let i = 0; i < insertLineIndex; i++) {
    insertCharIndex += lines[i].length + 1;
  }
  
  content = content.slice(0, insertCharIndex - 1) + kpiBlock + content.slice(insertCharIndex - 1);
  fs.writeFileSync(tmdlPath, content, 'utf8');
}

async function validateMeasures(mode, tableNameLimit) {
  const listRes = await callModelingMcp("measure_operations", {
    request: { operation: "List" }
  });
  
  const measures = JSON.parse(listRes.content[0].text).data.Measures || [];
  const results = [];
  
  for (const m of measures) {
    if (tableNameLimit && m.tableName !== tableNameLimit) continue;
    
    let status = "ok";
    let errorMessage = m.errorMessage || null;
    let val = null;
    
    if (m.state === "SemanticError" || m.state === "SyntaxError" || errorMessage) {
      status = "error";
    }
    
    if (status === "ok" && (mode === "execute" || mode === "full")) {
      try {
        const queryRes = await callModelingMcp("dax_query_operations", {
          request: {
            operation: "Execute",
            query: `EVALUATE ROW("Value", [${m.name}])`
          }
        });
        
        const qData = JSON.parse(queryRes.content[0].text);
        if (qData.data && qData.data.Rows && qData.data.Rows.length > 0) {
          val = qData.data.Rows[0]["[Value]"];
          if (val === null || val === undefined) {
            status = "blank";
          }
        }
      } catch (err) {
        status = "error";
        errorMessage = err.message;
      }
    }
    
    results.push({
      name: m.name,
      table: m.tableName,
      status,
      errorMessage,
      value: val
    });
  }
  
  return { measures: results };
}

function buildFilterConfig(filter) {
  const fieldRef = getFieldProjection(filter.field);
  const filterId = `Filter_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  
  let conditions = [];
  if (Array.isArray(filter.values)) {
    conditions = filter.values.map(val => ({
      "operator": filter.operator === 'eq' ? 'In' : (filter.operator === 'neq' ? 'NotIn' : filter.operator),
      "value": { "expr": { "Literal": { "Value": typeof val === 'string' ? `'${val}'` : `${val}` } } }
    }));
  }
  
  return {
    "name": filterId,
    "field": fieldRef.field,
    "filter": {
      "type": "Categorical",
      "conditions": conditions
    },
    "howCreated": "User"
  };
}

function getValidFieldsFromModel() {
  const fields = new Set();
  try {
    const modelPath = getSemanticModelPath();
    const tablesDir = path.join(modelPath, 'definition', 'tables');
    if (fs.existsSync(tablesDir)) {
      const files = fs.readdirSync(tablesDir);
      for (const file of files) {
        if (!file.endsWith('.tmdl')) continue;
        const filePath = path.join(tablesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        
        const tableMatch = /^table\s+([a-zA-Z0-9_#-]+)/m.exec(content);
        if (!tableMatch) continue;
        const tableName = tableMatch[1];
        
        const colRegex = /^\tcolumn\s+('([^']+)'|([a-zA-Z0-9_]+))/gm;
        let colMatch;
        while ((colMatch = colRegex.exec(content)) !== null) {
          const colName = colMatch[2] || colMatch[3];
          fields.add(`${tableName}.${colName}`);
        }
        
        const valRegex = /^\tmeasure\s+('([^']+)'|([a-zA-Z0-9_]+))/gm;
        let valMatch;
        while ((valMatch = valRegex.exec(content)) !== null) {
          const valName = valMatch[2] || valMatch[3];
          fields.add(`${tableName}.${valName}`);
        }
      }
    }
  } catch (e) {
    logError(`Could not extract model fields for validation: ${e.message}`);
  }
  return fields;
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
  
  let internalVisualType = visualType;
  if (visualType === 'stackedColumnChart') {
    internalVisualType = 'columnChart';
  } else if (visualType === 'stackedBarChart') {
    internalVisualType = 'barChart';
  } else if (visualType === 'decompositionTree') {
    internalVisualType = 'decompositionTreeVisual';
  } else if (visualType === 'keyInfluencers') {
    internalVisualType = 'keyInfluencersVisual';
  } else if (visualType === 'map' || visualType === 'filledMap') {
    internalVisualType = 'azureMap';
  }

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
      "visualType": internalVisualType,
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
  } else if (visualType === 'gauge') {
    if (fields.value) {
      visualObj.visual.query.queryState.Values = { "projections": [getFieldProjection(fields.value)] };
    }
    if (fields.targetValue) {
      visualObj.visual.query.queryState.TargetValue = { "projections": [getFieldProjection(fields.targetValue)] };
    }
    if (fields.minimum) {
      visualObj.visual.query.queryState.Minimum = { "projections": [getFieldProjection(fields.minimum)] };
    }
    if (fields.maximum) {
      visualObj.visual.query.queryState.Maximum = { "projections": [getFieldProjection(fields.maximum)] };
    }
  } else if (visualType === 'kpi') {
    if (fields.value) {
      visualObj.visual.query.queryState.Values = { "projections": [getFieldProjection(fields.value)] };
    }
    if (fields.trend) {
      visualObj.visual.query.queryState.Trend = { "projections": [getFieldProjection(fields.trend)] };
    }
    if (fields.targetValue) {
      visualObj.visual.query.queryState.TargetValue = { "projections": [getFieldProjection(fields.targetValue)] };
    }
  } else if (visualType === 'funnel') {
    if (fields.category) {
      visualObj.visual.query.queryState.Category = { "projections": [getFieldProjection(fields.category)] };
    }
    if (fields.y) {
      visualObj.visual.query.queryState.Y = { "projections": [getFieldProjection(fields.y)] };
    }
  } else if (visualType === 'ribbonChart') {
    if (fields.category) {
      visualObj.visual.query.queryState.Category = { "projections": [getFieldProjection(fields.category)] };
    }
    if (fields.series) {
      visualObj.visual.query.queryState.Series = { "projections": [getFieldProjection(fields.series)] };
    }
    if (fields.y) {
      visualObj.visual.query.queryState.Y = { "projections": [getFieldProjection(fields.y)] };
    }
  } else if (visualType === 'decompositionTree') {
    if (fields.analyze) {
      visualObj.visual.query.queryState.Y = { "projections": [getFieldProjection(fields.analyze)] };
    }
    if (fields.explainBy) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(fields.explainBy) ? fields.explainBy : [fields.explainBy]).map(e => getFieldProjection(e))
      };
    }
  } else if (visualType === 'keyInfluencers') {
    if (fields.analyze) {
      visualObj.visual.query.queryState.Analyze = { "projections": [getFieldProjection(fields.analyze)] };
    }
    if (fields.explainBy) {
      visualObj.visual.query.queryState.ExplainBy = {
        "projections": (Array.isArray(fields.explainBy) ? fields.explainBy : [fields.explainBy]).map(e => getFieldProjection(e))
      };
    }
  } else if (visualType === 'map') {
    if (fields.location) {
      visualObj.visual.query.queryState.Location = { "projections": [getFieldProjection(fields.location)] };
    }
    if (fields.latitude) {
      visualObj.visual.query.queryState.Latitude = { "projections": [getFieldProjection(fields.latitude)] };
    }
    if (fields.longitude) {
      visualObj.visual.query.queryState.Longitude = { "projections": [getFieldProjection(fields.longitude)] };
    }
    if (fields.size) {
      visualObj.visual.query.queryState.Size = { "projections": [getFieldProjection(fields.size)] };
    }
    if (fields.legend) {
      visualObj.visual.query.queryState.Legend = { "projections": [getFieldProjection(fields.legend)] };
    }
  } else if (visualType === 'filledMap') {
    if (fields.location) {
      visualObj.visual.query.queryState.Location = { "projections": [getFieldProjection(fields.location)] };
    }
    if (fields.legend) {
      visualObj.visual.query.queryState.Legend = { "projections": [getFieldProjection(fields.legend)] };
    }
    if (fields.value || fields.values) {
      visualObj.visual.query.queryState.Values = { "projections": [getFieldProjection(fields.value || fields.values)] };
    }
  } else if (visualType === 'lineClusteredColumnComboChart' || visualType === 'lineStackedColumnComboChart') {
    if (fields.xAxis) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(fields.xAxis) ? fields.xAxis : [fields.xAxis]).map(x => getFieldProjection(x))
      };
    }
    if (fields.series) {
      visualObj.visual.query.queryState.Series = { "projections": [getFieldProjection(fields.series)] };
    }
    if (fields.columnValues) {
      visualObj.visual.query.queryState.Y = {
        "projections": (Array.isArray(fields.columnValues) ? fields.columnValues : [fields.columnValues]).map(y => getFieldProjection(y))
      };
    }
    if (fields.lineValues) {
      visualObj.visual.query.queryState.Y2 = {
        "projections": (Array.isArray(fields.lineValues) ? fields.lineValues : [fields.lineValues]).map(y => getFieldProjection(y))
      };
    }
  } else if (visualType === 'areaChart' || visualType === 'stackedAreaChart') {
    if (fields.category || fields.xAxis) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(fields.category || fields.xAxis) ? (fields.category || fields.xAxis) : [fields.category || fields.xAxis]).map(x => getFieldProjection(x))
      };
    }
    if (fields.series) {
      visualObj.visual.query.queryState.Series = { "projections": [getFieldProjection(fields.series)] };
    }
    if (fields.yAxis || fields.value || fields.y) {
      visualObj.visual.query.queryState.Y = {
        "projections": (Array.isArray(fields.yAxis || fields.value || fields.y) ? (fields.yAxis || fields.value || fields.y) : [fields.yAxis || fields.value || fields.y]).map(y => getFieldProjection(y))
      };
    }
  } else if (visualType === 'stackedColumnChart' || visualType === 'stackedBarChart') {
    if (fields.category || fields.xAxis) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(fields.category || fields.xAxis) ? (fields.category || fields.xAxis) : [fields.category || fields.xAxis]).map(x => getFieldProjection(x))
      };
    }
    if (fields.series) {
      visualObj.visual.query.queryState.Series = { "projections": [getFieldProjection(fields.series)] };
    }
    if (fields.yAxis || fields.value || fields.y) {
      visualObj.visual.query.queryState.Y = {
        "projections": (Array.isArray(fields.yAxis || fields.value || fields.y) ? (fields.yAxis || fields.value || fields.y) : [fields.yAxis || fields.value || fields.y]).map(y => getFieldProjection(y))
      };
    }
  } else if (visualType === 'hundredPercentStackedColumnChart' || visualType === 'hundredPercentStackedBarChart') {
    if (fields.category || fields.xAxis) {
      visualObj.visual.query.queryState.Category = {
        "projections": (Array.isArray(fields.category || fields.xAxis) ? (fields.category || fields.xAxis) : [fields.category || fields.xAxis]).map(x => getFieldProjection(x))
      };
    }
    if (fields.series) {
      visualObj.visual.query.queryState.Series = { "projections": [getFieldProjection(fields.series)] };
    }
    if (fields.yAxis || fields.value || fields.y) {
      visualObj.visual.query.queryState.Y = {
        "projections": (Array.isArray(fields.yAxis || fields.value || fields.y) ? (fields.yAxis || fields.value || fields.y) : [fields.yAxis || fields.value || fields.y]).map(y => getFieldProjection(y))
      };
    }
  } else if (visualType === 'multiRowCard') {
    visualObj.visual.query.queryState.Values = {
      "projections": (Array.isArray(fields.values) ? fields.values : (fields.value ? [fields.value] : [])).map(v => getFieldProjection(v))
    };
  } else if (visualType === 'basicShape') {
    delete visualObj.visual.query;
    visualObj.visual.objects = {
      "shape": [
        {
          "properties": {
            "shapeType": {
              "expr": {
                "Literal": {
                  "Value": `'${fields.shapeType || 'Rectangle'}'`
                }
              }
            }
          }
        }
      ]
    };
  } else if (visualType === 'image') {
    delete visualObj.visual.query;
    if (fields.url) {
      const isLocal = !fields.url.startsWith('http://') && !fields.url.startsWith('https://');
      if (isLocal) {
        const filename = fields.url.split('/').pop();
        visualObj.visual.objects = {
          "general": [
            {
              "properties": {
                "imageUrl": {
                  "expr": {
                    "ResourcePackageItem": {
                      "PackageName": "RegisteredResources",
                      "ItemName": filename
                    }
                  }
                }
              }
            }
          ]
        };
      } else {
        visualObj.visual.objects = {
          "general": [
            {
              "properties": {
                "imageUrl": {
                  "expr": {
                    "Literal": {
                      "Value": `'${fields.url}'`
                    }
                  }
                }
              }
            }
          ]
        };
      }
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
    const { pageId, template = 'dynamicGrid', arrangeDecoratives = false } = args;
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

    let visuals = visualNames.map(name => {
      const jsonPath = path.join(visualsDir, name, 'visual.json');
      return {
        name,
        path: jsonPath,
        data: JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      };
    });

    if (!arrangeDecoratives) {
      visuals = visuals.filter(v => {
        const type = v.data.visual ? v.data.visual.visualType : 'group';
        return type !== 'basicShape' && type !== 'image';
      });
    }

    if (visuals.length === 0) {
      return { message: "No rearrangeable visuals found on this page." };
    }

    if (template === 'kpiHeader') {
      const kpis = [];
      const charts = [];
      visuals.forEach(v => {
        const type = v.data.visual ? v.data.visual.visualType : 'group';
        if (type === 'card' || type === 'slicer' || type === 'kpi' || type === 'gauge') {
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
  },

  create_date_table: async (args) => {
    const tableName = args.tableName || "DateTable";
    const startDate = args.startDate;
    const endDate = args.endDate;
    const fiscalYearStartMonth = args.fiscalYearStartMonth || 1;
    const relationshipColumn = args.relationshipColumn || "financials.Date";
    const liveSync = args.liveSync || false;

    const modelPath = getSemanticModelPath();
    const tablesDir = path.join(modelPath, 'definition', 'tables');
    if (!fs.existsSync(tablesDir)) {
      fs.mkdirSync(tablesDir, { recursive: true });
    }

    let actualStart = startDate;
    let actualEnd = endDate;
    if (!actualStart || !actualEnd) {
      log("Auto-detecting date range...");
      const detected = await detectMinMaxDate(relationshipColumn);
      actualStart = actualStart || detected.minDate.toISOString().split('T')[0];
      actualEnd = actualEnd || detected.maxDate.toISOString().split('T')[0];
    }

    log(`Generating Date table ${tableName} with range ${actualStart} to ${actualEnd}`);
    const tmdlContent = generateDateTableTmdl(tableName, actualStart, actualEnd, fiscalYearStartMonth);
    fs.writeFileSync(path.join(tablesDir, `${tableName}.tmdl`), tmdlContent, 'utf8');

    const modelTmdlPath = path.join(modelPath, 'definition', 'model.tmdl');
    registerTableInModel(modelTmdlPath, tableName);

    const relTmdlPath = path.join(modelPath, 'definition', 'relationships.tmdl');
    let relsContent = '';
    if (fs.existsSync(relTmdlPath)) {
      relsContent = fs.readFileSync(relTmdlPath, 'utf8').trim() + '\n\n';
    }
    
    let fromCol = relationshipColumn;
    if (fromCol.includes('[') && fromCol.includes(']')) {
      fromCol = fromCol.replace('[', '.').replace(']', '');
    }
    const relId = generateGuid();
    relsContent += `relationship ${relId}\n\tfromColumn: ${fromCol}\n\ttoColumn: ${tableName}.Date\n`;
    fs.writeFileSync(relTmdlPath, relsContent, 'utf8');

    if (liveSync) {
      log("Running live sync to active Analysis Services session...");
      try {
        const startD = new Date(actualStart);
        const endD = new Date(actualEnd);
        
        await callModelingMcp("table_operations", {
          request: {
            operation: "Create",
            definitions: [
              {
                name: tableName,
                daxExpression: `CALENDAR(DATE(${startD.getFullYear()}, ${startD.getMonth() + 1}, ${startD.getDate()}), DATE(${endD.getFullYear()}, ${endD.getMonth() + 1}, ${endD.getDate()}))`
              }
            ]
          }
        });

        const cols = [
          { name: "Year", expr: "YEAR([Date])", type: "int64" },
          { name: "MonthNumber", expr: "MONTH([Date])", type: "int64" },
          { name: "MonthName", expr: "FORMAT([Date], \"MMMM\")", type: "string" },
          { name: "Quarter", expr: "\"Q\" & INT((MONTH([Date]) + 2) / 3)", type: "string" },
          { name: "FiscalYear", expr: `IF(MONTH([Date]) >= ${fiscalYearStartMonth}, YEAR([Date]), YEAR([Date]) - 1)`, type: "int64" },
          { name: "FiscalQuarter", expr: `\"Q\" & INT((MOD(MONTH([Date]) - ${fiscalYearStartMonth} + 12, 12) + 3) / 3)`, type: "string" },
          { name: "DayOfWeek", expr: "WEEKDAY([Date])", type: "int64" },
          { name: "WeekNumber", expr: "WEEKNUM([Date])", type: "int64" },
          { name: "IsWeekend", expr: "IF(WEEKDAY([Date]) IN {1, 7}, TRUE, FALSE)", type: "boolean" }
        ];

        for (const col of cols) {
          await callModelingMcp("column_operations", {
            request: {
              operation: "Create",
              definitions: [
                {
                  tableName: tableName,
                  name: col.name,
                  expression: col.expr,
                  dataType: col.type
                }
              ]
            }
          });
        }

        const fromParts = fromCol.split('.');
        await callModelingMcp("relationship_operations", {
          request: {
            operation: "Create",
            definitions: [
              {
                name: relId,
                fromTable: fromParts[0],
                fromColumn: fromParts[1],
                toTable: tableName,
                toColumn: "Date",
                isActive: true
              }
            ]
          }
        });
      } catch (err) {
        logError(`Live sync failed: ${err.message}`);
      }
    }

    return {
      message: `Date table '${tableName}' created successfully on disk.`,
      tableName,
      startDate: actualStart,
      endDate: actualEnd,
      relationshipId: relId
    };
  },

  create_calculated_column: async (args) => {
    const { tableName, columns = [], liveSync = false } = args;
    if (!tableName || columns.length === 0) {
      throw new Error("Parameters 'tableName' and 'columns' (array) are required.");
    }

    const modelPath = getSemanticModelPath();
    const tmdlPath = path.join(modelPath, 'definition', 'tables', `${tableName}.tmdl`);
    if (!fs.existsSync(tmdlPath)) {
      throw new Error(`Table TMDL file not found for '${tableName}'.`);
    }

    log(`Adding calculated columns to table ${tableName} on disk`);
    for (const col of columns) {
      addCalculatedColumnToTmdl(tmdlPath, col.name, col.expression, col.dataType || "string", col.formatString);
    }

    if (liveSync) {
      log("Running live sync for calculated columns...");
      try {
        for (const col of columns) {
          await callModelingMcp("column_operations", {
            request: {
              operation: "Create",
              definitions: [
                {
                  tableName,
                  name: col.name,
                  expression: col.expression,
                  dataType: col.dataType || "string",
                  formatString: col.formatString
                }
              ]
            }
          });
        }
      } catch (err) {
        logError(`Live sync for calculated columns failed: ${err.message}`);
      }
    }

    return {
      message: `Calculated columns added successfully to '${tableName}'.`,
      count: columns.length
    };
  },

  validate_measures: async (args) => {
    const { mode = "full", tableName } = args;
    const results = await validateMeasures(mode, tableName);
    return results;
  },

  create_kpi: async (args) => {
    const { tableName, measureName, targetValue, statusThresholds, trendMeasure, liveSync = false } = args;
    if (!tableName || !measureName || !targetValue || !statusThresholds) {
      throw new Error("Parameters 'tableName', 'measureName', 'targetValue', and 'statusThresholds' are required.");
    }

    const modelPath = getSemanticModelPath();
    const tmdlPath = path.join(modelPath, 'definition', 'tables', `${tableName}.tmdl`);
    if (!fs.existsSync(tmdlPath)) {
      throw new Error(`Table TMDL file not found for '${tableName}'.`);
    }

    log(`Adding KPI definition to measure ${measureName} in table ${tableName}`);
    addKpiToTmdl(tmdlPath, measureName, targetValue, statusThresholds, trendMeasure);

    if (liveSync) {
      log("Running live sync for KPI...");
      try {
        const targetExpr = typeof targetValue === 'number' ? `${targetValue}` : `[${targetValue}]`;
        const statusExpr = `IF([${measureName}] >= ${statusThresholds.good}, 1, IF([${measureName}] >= ${statusThresholds.warning}, 0, -1))`;
        
        const kpiTmdl = `target = ${targetExpr}\nstatusGraphics = 'Traffic Light'\nstatusExpression = ${statusExpr}${trendMeasure ? `\ntrend = [${trendMeasure}]` : ''}`;
        
        await callModelingMcp("measure_operations", {
          request: {
            operation: "Update",
            definitions: [
              {
                tableName,
                name: measureName,
                kpi: kpiTmdl
              }
            ]
          }
        });
      } catch (err) {
        logError(`Live sync for KPI failed: ${err.message}`);
      }
    }

    return {
      message: `KPI defined successfully for measure '${measureName}'.`
    };
  },

  clone_page: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { sourcePageId, newPageName } = args;
    if (!sourcePageId || !newPageName) {
      throw new Error("Parameters 'sourcePageId' and 'newPageName' are required.");
    }

    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    const sourcePageFolder = path.join(pagesDir, sourcePageId);
    if (!fs.existsSync(sourcePageFolder)) {
      throw new Error(`Source page folder '${sourcePageId}' not found.`);
    }

    const newPageId = Array.from({length: 20}, () => Math.floor(Math.random()*16).toString(16)).join('');
    const newPageFolder = path.join(pagesDir, newPageId);
    fs.mkdirSync(newPageFolder, { recursive: true });

    const pageJsonPath = path.join(sourcePageFolder, 'page.json');
    if (fs.existsSync(pageJsonPath)) {
      const pageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
      pageJson.name = newPageId;
      pageJson.displayName = newPageName;
      fs.writeFileSync(path.join(newPageFolder, 'page.json'), JSON.stringify(pageJson, null, 2), 'utf8');
    }

    const sourceVisualsDir = path.join(sourcePageFolder, 'visuals');
    if (fs.existsSync(sourceVisualsDir)) {
      const newVisualsDir = path.join(newPageFolder, 'visuals');
      fs.mkdirSync(newVisualsDir, { recursive: true });

      const visualFolders = fs.readdirSync(sourceVisualsDir);
      for (const vFolder of visualFolders) {
        const vPath = path.join(sourceVisualsDir, vFolder);
        if (fs.statSync(vPath).isDirectory()) {
          const newVisualId = `Visual_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
          const newVPath = path.join(newVisualsDir, newVisualId);
          fs.mkdirSync(newVPath, { recursive: true });

          const visualJsonPath = path.join(vPath, 'visual.json');
          if (fs.existsSync(visualJsonPath)) {
            const visualJson = JSON.parse(fs.readFileSync(visualJsonPath, 'utf8'));
            visualJson.name = newVisualId;
            fs.writeFileSync(path.join(newVPath, 'visual.json'), JSON.stringify(visualJson, null, 2), 'utf8');
          }
        }
      }
    }

    const pagesJsonPath = path.join(pagesDir, 'pages.json');
    if (fs.existsSync(pagesJsonPath)) {
      try {
        const pagesData = JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
        if (Array.isArray(pagesData.pageOrder)) {
          pagesData.pageOrder.push(newPageId);
          pagesData.activePageName = newPageId;
          fs.writeFileSync(pagesJsonPath, JSON.stringify(pagesData, null, 2), 'utf8');
        }
      } catch (e) {
        logError(`Error updating pages.json order file: ${e.message}`);
      }
    }

    return {
      message: `Page '${newPageName}' cloned successfully.`,
      newPageId
    };
  },

  duplicate_visual: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { sourcePageId, sourceVisualId, targetPageId, offsetX = 20, offsetY = 20 } = args;
    if (!sourcePageId || !sourceVisualId) {
      throw new Error("Parameters 'sourcePageId' and 'sourceVisualId' are required.");
    }

    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    const sourceVPath = path.join(pagesDir, sourcePageId, 'visuals', sourceVisualId, 'visual.json');
    if (!fs.existsSync(sourceVPath)) {
      throw new Error(`Source visual.json not found.`);
    }

    const targetPage = targetPageId || sourcePageId;
    const targetVisualsDir = path.join(pagesDir, targetPage, 'visuals');
    if (!fs.existsSync(targetVisualsDir)) {
      fs.mkdirSync(targetVisualsDir, { recursive: true });
    }

    const newVisualId = `Visual_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const newVisualFolder = path.join(targetVisualsDir, newVisualId);
    fs.mkdirSync(newVisualFolder, { recursive: true });

    const visualJson = JSON.parse(fs.readFileSync(sourceVPath, 'utf8'));
    visualJson.name = newVisualId;

    if (visualJson.position) {
      visualJson.position.x = (visualJson.position.x || 0) + offsetX;
      visualJson.position.y = (visualJson.position.y || 0) + offsetY;
    }

    fs.writeFileSync(path.join(newVisualFolder, 'visual.json'), JSON.stringify(visualJson, null, 2), 'utf8');

    return {
      message: `Visual '${sourceVisualId}' duplicated successfully as '${newVisualId}'.`,
      newVisualId
    };
  },

  set_conditional_formatting: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, visualId, rules } = args;
    if (!pageId || !visualId || !rules) {
      throw new Error("Parameters 'pageId', 'visualId', and 'rules' are required.");
    }

    const visualJsonPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualId, 'visual.json');
    if (!fs.existsSync(visualJsonPath)) {
      throw new Error(`Visual not found.`);
    }

    const visualObj = JSON.parse(fs.readFileSync(visualJsonPath, 'utf8'));
    if (!visualObj.visual.objects) {
      visualObj.visual.objects = {};
    }

    let targetObjName = "dataPoint";
    let targetPropName = "fill";
    
    const vType = visualObj.visual.visualType;
    if (vType === 'table' || vType === 'pivotTable') {
      targetObjName = "values";
      targetPropName = "backColor";
    }
    
    if (!visualObj.visual.objects[targetObjName]) {
      visualObj.visual.objects[targetObjName] = [{}];
    }
    
    const targetProperties = visualObj.visual.objects[targetObjName][0].properties || {};
    visualObj.visual.objects[targetObjName][0].properties = targetProperties;
    
    const fieldRef = getFieldProjection(rules.field);

    if (rules.type === 'colorScale') {
      targetProperties[targetPropName] = {
        "colorScale": {
          "differenceAsZero": false,
          "expression": fieldRef.field,
          "gradient": {
            "min": {
              "color": { "solid": { "color": { "expr": { "Literal": { "Value": `'${rules.minColor}'` } } } } },
              "type": rules.minValue !== undefined ? "Custom" : "LowestValue"
            },
            "max": {
              "color": { "solid": { "color": { "expr": { "Literal": { "Value": `'${rules.maxColor}'` } } } } },
              "type": rules.maxValue !== undefined ? "Custom" : "HighestValue"
            }
          }
        }
      };
      
      if (rules.minValue !== undefined) {
        targetProperties[targetPropName].colorScale.gradient.min.value = { "expr": { "Literal": { "Value": `${rules.minValue}` } } };
      }
      if (rules.maxValue !== undefined) {
        targetProperties[targetPropName].colorScale.gradient.max.value = { "expr": { "Literal": { "Value": `${rules.maxValue}` } } };
      }
      
      if (rules.midColor) {
        targetProperties[targetPropName].colorScale.gradient.mid = {
          "color": { "solid": { "color": { "expr": { "Literal": { "Value": `'${rules.midColor}'` } } } } },
          "type": rules.midValue !== undefined ? "Custom" : "Percentile"
        };
        if (rules.midValue !== undefined) {
          targetProperties[targetPropName].colorScale.gradient.mid.value = { "expr": { "Literal": { "Value": `${rules.midValue}` } } };
        }
      }
    } else if (rules.type === 'iconSet') {
      targetProperties["icon"] = {
        "iconSet": {
          "expression": fieldRef.field,
          "iconSetType": rules.iconStyle || "trafficLight",
          "alignment": "Right",
          "rules": (rules.thresholds || []).map(t => ({
            "icon": t.icon,
            "range": {
              "min": { "type": "Custom", "value": t.min },
              "max": { "type": "Custom", "value": t.max }
            }
          }))
        }
      };
    }

    fs.writeFileSync(visualJsonPath, JSON.stringify(visualObj, null, 2), 'utf8');

    return {
      message: `Conditional formatting applied successfully to visual '${visualId}'.`
    };
  },

  add_bookmark: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { bookmarkName, type = "navigation", pageId } = args;
    if (!bookmarkName || !pageId) {
      throw new Error("Parameters 'bookmarkName' and 'pageId' are required.");
    }

    const bookmarkId = `Bookmark_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const bookmarksDir = path.join(activeReportPath, 'definition', 'bookmarks');
    if (!fs.existsSync(bookmarksDir)) {
      fs.mkdirSync(bookmarksDir, { recursive: true });
    }

    const bookmarkJson = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmark/1.0.0/schema.json",
      "name": bookmarkId,
      "displayName": bookmarkName,
      "explorationState": {
        "activeSection": pageId
      }
    };
    
    fs.writeFileSync(
      path.join(bookmarksDir, `${bookmarkId}.bookmark.json`), 
      JSON.stringify(bookmarkJson, null, 2), 
      'utf8'
    );

    const bookmarksJsonPath = path.join(bookmarksDir, 'bookmarks.json');
    let bookmarksData = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmarks/1.0.0/schema.json",
      "bookmarks": [],
      "bookmarkOrder": []
    };

    if (fs.existsSync(bookmarksJsonPath)) {
      try {
        bookmarksData = JSON.parse(fs.readFileSync(bookmarksJsonPath, 'utf8'));
      } catch (e) {
        logError(`Error reading bookmarks.json: ${e.message}`);
      }
    }

    if (!Array.isArray(bookmarksData.bookmarks)) bookmarksData.bookmarks = [];
    if (!Array.isArray(bookmarksData.bookmarkOrder)) bookmarksData.bookmarkOrder = [];

    bookmarksData.bookmarks.push({ "name": bookmarkId });
    bookmarksData.bookmarkOrder.push(bookmarkId);

    fs.writeFileSync(bookmarksJsonPath, JSON.stringify(bookmarksData, null, 2), 'utf8');

    return {
      message: `Bookmark '${bookmarkName}' created successfully.`,
      bookmarkId
    };
  },

  export_page_summary: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, format = "markdown" } = args;
    if (!pageId) {
      throw new Error("Parameter 'pageId' is required.");
    }

    const pageDir = path.join(activeReportPath, 'definition', 'pages', pageId);
    if (!fs.existsSync(pageDir)) {
      throw new Error(`Page '${pageId}' not found.`);
    }
    
    const pageJson = JSON.parse(fs.readFileSync(path.join(pageDir, 'page.json'), 'utf8'));
    const visualsDir = path.join(pageDir, 'visuals');
    const visuals = [];

    if (fs.existsSync(visualsDir)) {
      const items = fs.readdirSync(visualsDir);
      for (const item of items) {
        const vPath = path.join(visualsDir, item, 'visual.json');
        if (fs.existsSync(vPath)) {
          try {
            const vJson = JSON.parse(fs.readFileSync(vPath, 'utf8'));
            const fields = {};
            const queryState = vJson.visual?.query?.queryState || {};
            for (const key of Object.keys(queryState)) {
              const projections = queryState[key]?.projections || [];
              fields[key] = projections.map(p => p.queryRef);
            }
            
            visuals.push({
              id: item,
              type: vJson.visual?.visualType || 'unknown',
              fields,
              position: vJson.position || {}
            });
          } catch (e) {
            logError(`Error parsing visual ${item}: ${e.message}`);
          }
        }
      }
    }

    const summaryObj = {
      page: {
        id: pageId,
        displayName: pageJson.displayName || pageId,
        width: pageJson.width || 1280,
        height: pageJson.height || 720
      },
      visuals
    };

    let md = `# Page Summary: ${pageJson.displayName || pageId}\n`;
    md += `- **Page ID**: ${pageId}\n`;
    md += `- **Dimensions**: ${pageJson.width || 1280} x ${pageJson.height || 720}\n\n`;
    md += `## Visuals Inventory\n\n`;
    md += `| Visual ID | Type | Fields / Bindings | Position (X, Y, W, H) |\n`;
    md += `| --- | --- | --- | --- |\n`;
    for (const v of visuals) {
      const fieldsStr = Object.entries(v.fields)
        .map(([k, val]) => `**${k}**: ${val.join(', ')}`)
        .join('<br>');
      const posStr = `X: ${v.position.x}, Y: ${v.position.y}, W: ${v.position.width}, H: ${v.position.height}`;
      md += `| ${v.id} | ${v.type} | ${fieldsStr} | ${posStr} |\n`;
    }

    if (format === "json") {
      return summaryObj;
    } else if (format === "markdown") {
      return { markdown: md };
    } else {
      return { json: summaryObj, markdown: md };
    }
  },

  set_page_background: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, type, color, transparency = 0, imagePath } = args;
    if (!pageId || !type) {
      throw new Error("Parameters 'pageId' and 'type' are required.");
    }

    const pageJsonPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'page.json');
    if (!fs.existsSync(pageJsonPath)) {
      throw new Error(`Page '${pageId}' not found.`);
    }

    const pageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
    if (!pageJson.objects) pageJson.objects = {};

    if (type === "solid") {
      pageJson.objects.background = [
        {
          "properties": {
            "color": {
              "solid": {
                "color": {
                  "expr": {
                    "Literal": {
                      "Value": `'${color}'`
                    }
                  }
                }
              }
            },
            "transparency": {
              "expr": {
                "Literal": {
                  "Value": `${transparency}`
                }
              }
            }
          }
        }
      ];
    } else if (type === "image" && imagePath) {
      const imageBasename = path.basename(imagePath);
      const destDir = path.join(activeReportPath, 'StaticResources', 'RegisteredResources');
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.writeFileSync(path.join(destDir, imageBasename), fs.readFileSync(imagePath));

      const reportJsonPath = path.join(activeReportPath, 'definition', 'report.json');
      if (fs.existsSync(reportJsonPath)) {
        const reportData = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
        if (!Array.isArray(reportData.resourcePackages)) {
          reportData.resourcePackages = [];
        }
        let regPkg = reportData.resourcePackages.find(pkg => pkg.name === 'RegisteredResources');
        if (!regPkg) {
          regPkg = { "name": "RegisteredResources", "type": "RegisteredResources", "items": [] };
          reportData.resourcePackages.push(regPkg);
        }
        if (!Array.isArray(regPkg.items)) regPkg.items = [];
        
        const itemExists = regPkg.items.some(it => it.name === imageBasename);
        if (!itemExists) {
          regPkg.items.push({
            "name": imageBasename,
            "path": `RegisteredResources/${imageBasename}`,
            "type": "Resource"
          });
        }
        fs.writeFileSync(reportJsonPath, JSON.stringify(reportData, null, 2), 'utf8');
      }

      pageJson.objects.background = [
        {
          "properties": {
            "image": {
              "expr": {
                "Literal": {
                  "Value": `'RegisteredResources/${imageBasename}'`
                }
              }
            },
            "transparency": {
              "expr": {
                "Literal": {
                  "Value": `${transparency}`
                }
              }
            }
          }
        }
      ];
    }

    fs.writeFileSync(pageJsonPath, JSON.stringify(pageJson, null, 2), 'utf8');
    return { message: `Page background updated successfully.` };
  },

  manage_filters: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { scope, pageId, visualId, operation, filter } = args;
    if (!scope || !operation) {
      throw new Error("Parameters 'scope' and 'operation' are required.");
    }

    let targetPath = '';
    let parentKey = 'filterConfig';
    
    if (scope === "visual") {
      if (!pageId || !visualId) throw new Error("pageId and visualId required for visual scope.");
      targetPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'visuals', visualId, 'visual.json');
    } else if (scope === "page") {
      if (!pageId) throw new Error("pageId required for page scope.");
      targetPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'page.json');
    } else if (scope === "report") {
      targetPath = path.join(activeReportPath, 'definition', 'report.json');
    }

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Target file not found at ${targetPath}.`);
    }

    const data = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

    if (operation === "clear") {
      delete data[parentKey];
    } else if (operation === "remove") {
      if (data[parentKey] && Array.isArray(data[parentKey].filters)) {
        data[parentKey].filters = data[parentKey].filters.filter(f => f.name !== filter.name);
      }
    } else if (operation === "add") {
      if (!filter || !filter.field) throw new Error("Filter field required for add operation.");
      if (!data[parentKey]) data[parentKey] = { "filters": [] };
      if (!Array.isArray(data[parentKey].filters)) data[parentKey].filters = [];
      
      const newFilter = buildFilterConfig(filter);
      data[parentKey].filters.push(newFilter);
    }

    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
    return { message: `Filters managed successfully under ${scope} scope.` };
  },

  set_visual_interactions: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageId, sourceVisualId, interactions = [] } = args;
    if (!pageId || !sourceVisualId) {
      throw new Error("Parameters 'pageId' and 'sourceVisualId' are required.");
    }

    const pageJsonPath = path.join(activeReportPath, 'definition', 'pages', pageId, 'page.json');
    if (!fs.existsSync(pageJsonPath)) {
      throw new Error(`Page '${pageId}' not found.`);
    }

    const pageJson = JSON.parse(fs.readFileSync(pageJsonPath, 'utf8'));
    if (!Array.isArray(pageJson.visualInteractions)) {
      pageJson.visualInteractions = [];
    }

    for (const inter of interactions) {
      const typeMap = {
        "filter": "DataFilter",
        "highlight": "HighlightFilter",
        "none": "NoFilter"
      };
      const mappedType = typeMap[inter.type] || "DataFilter";
      
      const idx = pageJson.visualInteractions.findIndex(vi => vi.source === sourceVisualId && vi.target === inter.targetVisualId);
      if (idx !== -1) {
        pageJson.visualInteractions[idx].type = mappedType;
      } else {
        pageJson.visualInteractions.push({
          "source": sourceVisualId,
          "target": inter.targetVisualId,
          "type": mappedType
        });
      }
    }

    fs.writeFileSync(pageJsonPath, JSON.stringify(pageJson, null, 2), 'utf8');
    return { message: `Visual interactions set successfully on page '${pageId}'.` };
  },

  add_tooltip_page: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { pageName, width = 320, height = 240 } = args;
    if (!pageName) {
      throw new Error("Parameter 'pageName' is required.");
    }

    const pageId = Array.from({length: 20}, () => Math.floor(Math.random()*16).toString(16)).join('');
    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    const pageFolder = path.join(pagesDir, pageId);
    fs.mkdirSync(pageFolder, { recursive: true });

    const pageJson = {
      "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json",
      "name": pageId,
      "displayName": pageName,
      "displayOption": "ActualSize",
      "height": height,
      "width": width,
      "type": "Tooltip"
    };

    fs.writeFileSync(path.join(pageFolder, 'page.json'), JSON.stringify(pageJson, null, 2), 'utf8');

    const pagesJsonPath = path.join(pagesDir, 'pages.json');
    if (fs.existsSync(pagesJsonPath)) {
      try {
        const pagesData = JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
        if (Array.isArray(pagesData.pageOrder)) {
          pagesData.pageOrder.push(pageId);
          fs.writeFileSync(pagesJsonPath, JSON.stringify(pagesData, null, 2), 'utf8');
        }
      } catch (e) {
        logError(`Error updating pages.json: ${e.message}`);
      }
    }

    return {
      message: `Tooltip page '${pageName}' created successfully.`,
      pageId
    };
  },

  snapshot_report: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const label = args.label || "backup";
    const snapshotsDir = path.join(activeReportPath, '.snapshots');
    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotName = `snapshot_${timestamp}_${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const destFolder = path.join(snapshotsDir, snapshotName);

    log(`Creating snapshot backup of definition folder to ${destFolder}`);
    copyFolderSync(path.join(activeReportPath, 'definition'), path.join(destFolder, 'definition'));

    let pageCount = 0;
    let visualCount = 0;
    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    if (fs.existsSync(pagesDir)) {
      const pageDirs = fs.readdirSync(pagesDir).filter(p => fs.statSync(path.join(pagesDir, p)).isDirectory());
      pageCount = pageDirs.length;
      for (const p of pageDirs) {
        const vDir = path.join(pagesDir, p, 'visuals');
        if (fs.existsSync(vDir)) {
          visualCount += fs.readdirSync(vDir).filter(v => fs.statSync(path.join(vDir, v)).isDirectory()).length;
        }
      }
    }

    const manifest = {
      timestamp: new Date().toISOString(),
      label,
      pageCount,
      visualCount
    };
    fs.writeFileSync(path.join(destFolder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    return {
      message: `Snapshot '${snapshotName}' created successfully.`,
      snapshotPath: destFolder
    };
  },

  diff_reports: (args) => {
    const { sourcePath, targetPath, format = "markdown" } = args;
    if (!sourcePath) {
      throw new Error("Parameter 'sourcePath' (before report path) is required.");
    }
    const finalTarget = targetPath || activeReportPath;
    if (!finalTarget) {
      throw new Error("No connected report path or targetPath parameter provided.");
    }

    log(`Diffing report: ${sourcePath} vs ${finalTarget}`);
    const srcDef = path.join(sourcePath, 'definition');
    const trgDef = path.join(finalTarget, 'definition');

    const srcPagesDir = path.join(srcDef, 'pages');
    const trgPagesDir = path.join(trgDef, 'pages');

    const srcPages = fs.existsSync(srcPagesDir) ? fs.readdirSync(srcPagesDir).filter(p => fs.statSync(path.join(srcPagesDir, p)).isDirectory()) : [];
    const trgPages = fs.existsSync(trgPagesDir) ? fs.readdirSync(trgPagesDir).filter(p => fs.statSync(path.join(trgPagesDir, p)).isDirectory()) : [];

    const addedPages = trgPages.filter(p => !srcPages.includes(p));
    const removedPages = srcPages.filter(p => !trgPages.includes(p));
    const sharedPages = srcPages.filter(p => trgPages.includes(p));

    const modifiedPages = [];
    const addedVisuals = [];
    const removedVisuals = [];

    for (const p of sharedPages) {
      const srcJson = JSON.parse(fs.readFileSync(path.join(srcPagesDir, p, 'page.json'), 'utf8'));
      const trgJson = JSON.parse(fs.readFileSync(path.join(trgPagesDir, p, 'page.json'), 'utf8'));
      
      let pageModified = srcJson.displayName !== trgJson.displayName || srcJson.width !== trgJson.width || srcJson.height !== trgJson.height;

      const srcVisDir = path.join(srcPagesDir, p, 'visuals');
      const trgVisDir = path.join(trgPagesDir, p, 'visuals');
      const srcVis = fs.existsSync(srcVisDir) ? fs.readdirSync(srcVisDir).filter(v => fs.statSync(path.join(srcVisDir, v)).isDirectory()) : [];
      const trgVis = fs.existsSync(trgVisDir) ? fs.readdirSync(trgVisDir).filter(v => fs.statSync(path.join(trgVisDir, v)).isDirectory()) : [];

      const added = trgVis.filter(v => !srcVis.includes(v)).map(v => `${p}/${v}`);
      const removed = srcVis.filter(v => !trgVis.includes(v)).map(v => `${p}/${v}`);
      
      addedVisuals.push(...added);
      removedVisuals.push(...removed);

      if (pageModified || added.length > 0 || removed.length > 0) {
        modifiedPages.push({
          id: p,
          displayName: trgJson.displayName || p,
          changes: {
            displayNameChanged: srcJson.displayName !== trgJson.displayName,
            addedVisualsCount: added.length,
            removedVisualsCount: removed.length
          }
        });
      }
    }

    const diffObj = {
      pages: {
        added: addedPages,
        removed: removedPages,
        modified: modifiedPages
      },
      visuals: {
        added: addedVisuals,
        removed: removedVisuals
      }
    };

    let md = `# Report Diff Summary\n\n`;
    md += `## Pages\n`;
    md += `- **Added Pages**: ${addedPages.length > 0 ? addedPages.join(', ') : 'None'}\n`;
    md += `- **Removed Pages**: ${removedPages.length > 0 ? removedPages.join(', ') : 'None'}\n`;
    md += `- **Modified Pages**: ${modifiedPages.length > 0 ? modifiedPages.map(p => `${p.displayName} (${p.id})`).join(', ') : 'None'}\n\n`;
    md += `## Visuals\n`;
    md += `- **Added Visuals**: ${addedVisuals.length > 0 ? addedVisuals.join(', ') : 'None'}\n`;
    md += `- **Removed Visuals**: ${removedVisuals.length > 0 ? removedVisuals.join(', ') : 'None'}\n`;

    if (format === "json") return diffObj;
    if (format === "markdown") return { markdown: md };
    return { json: diffObj, markdown: md };
  },

  validate_report: (args) => {
    if (!activeReportPath) {
      throw new Error("No active report project connected. Call connect_project first.");
    }
    const { fix = false } = args;
    const issues = [];
    let fixedCount = 0;

    const pagesDir = path.join(activeReportPath, 'definition', 'pages');
    const pagesJsonPath = path.join(pagesDir, 'pages.json');

    if (!fs.existsSync(pagesJsonPath)) {
      issues.push({ severity: "error", type: "missing_file", message: "pages.json order file is missing." });
      return { issues, fixedCount };
    }

    let pagesData = {};
    try {
      pagesData = JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
    } catch (e) {
      issues.push({ severity: "error", type: "invalid_json", message: `Failed to parse pages.json: ${e.message}` });
      return { issues, fixedCount };
    }

    const pageOrder = pagesData.pageOrder || [];
    const validFields = getValidFieldsFromModel();

    const checkedPageDirs = [];
    const fixedPageOrder = [];
    for (const pid of pageOrder) {
      const pFolder = path.join(pagesDir, pid);
      if (!fs.existsSync(pFolder)) {
        issues.push({ severity: "error", type: "orphaned_page_reference", message: `Page ID '${pid}' in pages.json has no folder.` });
        if (fix) {
          fixedCount++;
          continue;
        }
      }
      fixedPageOrder.push(pid);
      checkedPageDirs.push(pid);
    }

    if (fix && fixedCount > 0) {
      pagesData.pageOrder = fixedPageOrder;
      fs.writeFileSync(pagesJsonPath, JSON.stringify(pagesData, null, 2), 'utf8');
    }

    if (fs.existsSync(pagesDir)) {
      const pageFolders = fs.readdirSync(pagesDir).filter(p => fs.statSync(path.join(pagesDir, p)).isDirectory());
      for (const pf of pageFolders) {
        const visualsDir = path.join(pagesDir, pf, 'visuals');
        if (fs.existsSync(visualsDir)) {
          const visualFolders = fs.readdirSync(visualsDir).filter(v => fs.statSync(path.join(visualsDir, v)).isDirectory());
          for (const vf of visualFolders) {
            const vJsonPath = path.join(visualsDir, vf, 'visual.json');
            if (fs.existsSync(vJsonPath)) {
              try {
                const vJson = JSON.parse(fs.readFileSync(vJsonPath, 'utf8'));
                const queryState = vJson.visual?.query?.queryState || {};
                
                for (const key of Object.keys(queryState)) {
                  const projections = queryState[key]?.projections || [];
                  for (const proj of projections) {
                    const queryRef = proj.queryRef;
                    if (queryRef && validFields.size > 0 && !validFields.has(queryRef)) {
                      issues.push({
                        severity: "warning",
                        type: "invalid_field_reference",
                        message: `Visual '${vf}' on page '${pf}' binds to field '${queryRef}' which does not exist in model.`,
                        location: `${pf}/visuals/${vf}`
                      });
                    }
                  }
                }
              } catch (e) {
                issues.push({ severity: "error", type: "invalid_json", message: `Failed to parse visual.json for ${vf} on page ${pf}` });
              }
            }
          }
        }
      }
    }

    return { issues, fixedCount };
  }
};

// StdIn reader loop for JSON-RPC messages
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
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
                    enum: ["card", "lineChart", "clusteredColumnChart", "clusteredBarChart", "slicer", "pieChart", "donutChart", "table", "pivotTable", "treemap", "waterfallChart", "scatterChart", "gauge", "kpi", "funnel", "ribbonChart", "decompositionTree", "keyInfluencers", "map", "filledMap", "lineClusteredColumnComboChart", "lineStackedColumnComboChart", "areaChart", "stackedAreaChart", "stackedColumnChart", "stackedBarChart", "hundredPercentStackedColumnChart", "hundredPercentStackedBarChart", "multiRowCard", "basicShape", "image"],
                    description: "The visual type chart."
                  },
                  fields: {
                    type: "object",
                    description: "Field bindings. For card/gauge: {value: 'col', targetValue?: 'col', minimum?: 'col', maximum?: 'col'}. For chart/funnel/area/stackedChart: {xAxis/category/field/series?: 'col', yAxis/y?: ['col']}. For kpi: {value: 'col', trend: 'col', targetValue: 'col'}. For slicer: {field: 'col', isDropdown: bool}. For pie/donut: {legend: 'col', value: 'col'}. For table: {columns: ['col']}. For pivotTable: {rows: ['col'], columns: ['col'], values: ['col']}. For treemap: {group: 'col', value: 'col'}. For waterfallChart: {category: 'col', yAxis: 'col'}. For scatterChart: {series: 'col', xAxis: 'col', yAxis: 'col'}. For ribbonChart: {category: 'col', series: 'col', y: 'col'}. For decompositionTree/keyInfluencers: {analyze: 'col', explainBy: ['col']}. For map: {location: 'col', latitude?: 'col', longitude?: 'col', size?: 'col', legend?: 'col'}. For filledMap: {location: 'col', legend?: 'col', value: 'col'}. For combo chart: {xAxis: 'col', columnValues: ['col'], lineValues: ['col'], series?: 'col'}. For multiRowCard: {values: ['col']}. For basicShape: {shapeType?: 'Rectangle'|'Oval'}. For image: {url: 'path/url'}."
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
            },
            {
              name: "create_date_table",
              description: "Generates a proper Date dimension table as a DAX calculated table and writes it to the TMDL definition, optionally syncing to Analysis Services.",
              inputSchema: {
                type: "object",
                properties: {
                  tableName: { type: "string", description: "Name of the date table. Default 'DateTable'." },
                  startDate: { type: "string", description: "Start date (YYYY-MM-DD)." },
                  endDate: { type: "string", description: "End date (YYYY-MM-DD)." },
                  fiscalYearStartMonth: { type: "integer", description: "Month number for fiscal year start (1=Jan, 4=Apr, etc.). Default 1." },
                  relationshipColumn: { type: "string", description: "The fact table column to relate to (e.g. 'financials.Date'). Default 'financials.Date'." },
                  liveSync: { type: "boolean", description: "Whether to sync live with Analysis Services." }
                }
              }
            },
            {
              name: "create_calculated_column",
              description: "Adds DAX calculated columns to an existing table's TMDL definition.",
              inputSchema: {
                type: "object",
                properties: {
                  tableName: { type: "string", description: "Target table name." },
                  columns: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Column name." },
                        expression: { type: "string", description: "DAX expression." },
                        dataType: { type: "string", description: "Data type (string, int64, double, boolean, dateTime)." },
                        formatString: { type: "string", description: "Format string." }
                      },
                      required: ["name", "expression"]
                    }
                  },
                  liveSync: { type: "boolean", description: "Whether to sync live with Analysis Services." }
                },
                required: ["tableName", "columns"]
              }
            },
            {
              name: "validate_measures",
              description: "Health-checks all measures in the connected semantic model (syntax or execution).",
              inputSchema: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["syntax", "execute", "full"], description: "Validation depth. Default 'full'." },
                  tableName: { type: "string", description: "Optional table name to limit validation to." }
                }
              }
            },
            {
              name: "create_kpi",
              description: "Defines KPI objects with targets, status thresholds, and trend references.",
              inputSchema: {
                type: "object",
                properties: {
                  tableName: { type: "string", description: "Table containing the base measure." },
                  measureName: { type: "string", description: "The measure to attach the KPI to." },
                  targetValue: { type: "string", description: "Target as a fixed number or measure name." },
                  statusThresholds: {
                    type: "object",
                    properties: {
                      good: { type: "number", description: "Value at or above which status is good." },
                      warning: { type: "number", description: "Value at or above which status is warning." }
                    },
                    required: ["good", "warning"]
                  },
                  trendMeasure: { type: "string", description: "Name of trend indicator measure." },
                  liveSync: { type: "boolean", description: "Whether to sync live with Analysis Services." }
                },
                required: ["tableName", "measureName", "targetValue", "statusThresholds"]
              }
            },
            {
              name: "clone_page",
              description: "Duplicates an entire page within the same project.",
              inputSchema: {
                type: "object",
                properties: {
                  sourcePageId: { type: "string", description: "The page ID to clone." },
                  newPageName: { type: "string", description: "Display name for the cloned page." }
                },
                required: ["sourcePageId", "newPageName"]
              }
            },
            {
              name: "duplicate_visual",
              description: "Clones a visual to the same or different page with offsets.",
              inputSchema: {
                type: "object",
                properties: {
                  sourcePageId: { type: "string", description: "Page containing the source visual." },
                  sourceVisualId: { type: "string", description: "The visual to clone." },
                  targetPageId: { type: "string", description: "Destination page ID. Defaults to source page." },
                  offsetX: { type: "integer", description: "Pixel offset X from original." },
                  offsetY: { type: "integer", description: "Pixel offset Y from original." }
                },
                required: ["sourcePageId", "sourceVisualId"]
              }
            },
            {
              name: "set_conditional_formatting",
              description: "Applies data-driven color or icon rules to visuals.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID containing visual." },
                  visualId: { type: "string", description: "Visual ID to apply rules to." },
                  rules: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["colorScale", "iconSet"], description: "Rule type." },
                      field: { type: "string", description: "Measure or column to evaluate (e.g. 'financials.Profit')." },
                      minColor: { type: "string", description: "Min color hex." },
                      midColor: { type: "string", description: "Mid color hex." },
                      maxColor: { type: "string", description: "Max color hex." },
                      minValue: { type: "number", description: "Custom min value." },
                      midValue: { type: "number", description: "Custom mid value." },
                      maxValue: { type: "number", description: "Custom max value." },
                      iconStyle: { type: "string", description: "Icon set style (e.g. 'trafficLight')." },
                      thresholds: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            icon: { type: "string", description: "Icon name." },
                            min: { type: "number", description: "Min value threshold." },
                            max: { type: "number", description: "Max value threshold." }
                          },
                          required: ["icon", "min", "max"]
                        }
                      }
                    },
                    required: ["type", "field"]
                  }
                },
                required: ["pageId", "visualId", "rules"]
              }
            },
            {
              name: "add_bookmark",
              description: "Creates report bookmarks for storytelling or state capture.",
              inputSchema: {
                type: "object",
                properties: {
                  bookmarkName: { type: "string", description: "Display name of the bookmark." },
                  type: { type: "string", enum: ["navigation", "state"], description: "Bookmark type. Default 'navigation'." },
                  pageId: { type: "string", description: "Target page ID for bookmark." }
                },
                required: ["bookmarkName", "pageId"]
              }
            },
            {
              name: "export_page_summary",
              description: "Generates a structured manifest (JSON/Markdown) of everything on a page.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID to summarize." },
                  format: { type: "string", enum: ["json", "markdown", "both"], description: "Output format. Default 'markdown'." }
                },
                required: ["pageId"]
              }
            },
            {
              name: "set_page_background",
              description: "Configures solid color or image wallpaper backgrounds on report pages.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID." },
                  type: { type: "string", enum: ["solid", "image"], description: "Background type." },
                  color: { type: "string", description: "Hex color code (e.g. '#FFFFFF') for solid type." },
                  transparency: { type: "integer", description: "Transparency percentage (0-100). Default 0." },
                  imagePath: { type: "string", description: "Absolute path to image file for image type." }
                },
                required: ["pageId", "type"]
              }
            },
            {
              name: "manage_filters",
              description: "Programmatically adds, removes, or clears filters at visual, page, or report level.",
              inputSchema: {
                type: "object",
                properties: {
                  scope: { type: "string", enum: ["visual", "page", "report"], description: "Filter scope." },
                  pageId: { type: "string", description: "Page ID (required for visual/page scope)." },
                  visualId: { type: "string", description: "Visual ID (required for visual scope)." },
                  operation: { type: "string", enum: ["add", "remove", "clear"], description: "Filter operation." },
                  filter: {
                    type: "object",
                    properties: {
                      field: { type: "string", description: "Field name (e.g. 'financials.Country')." },
                      operator: { type: "string", description: "Operator (eq, neq, gt, lt, between, in)." },
                      values: { type: "array", items: { type: "string" }, description: "Filter values." }
                    }
                  }
                },
                required: ["scope", "operation"]
              }
            },
            {
              name: "set_visual_interactions",
              description: "Controls cross-filtering and cross-highlighting behavior between visuals.",
              inputSchema: {
                type: "object",
                properties: {
                  pageId: { type: "string", description: "Page ID." },
                  sourceVisualId: { type: "string", description: "Source visual ID." },
                  interactions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        targetVisualId: { type: "string", description: "Target visual ID." },
                        type: { type: "string", enum: ["filter", "highlight", "none"], description: "Interaction type." }
                      },
                      required: ["targetVisualId", "type"]
                    }
                  }
                },
                required: ["pageId", "sourceVisualId"]
              }
            },
            {
              name: "add_tooltip_page",
              description: "Creates a custom tooltip page that appears on hover over data points.",
              inputSchema: {
                type: "object",
                properties: {
                  pageName: { type: "string", description: "Display name for the tooltip page." },
                  width: { type: "integer", description: "Tooltip width in pixels. Default 320." },
                  height: { type: "integer", description: "Tooltip height in pixels. Default 240." }
                },
                required: ["pageName"]
              }
            },
            {
              name: "snapshot_report",
              description: "Creates a timestamped backup of the entire report folder.",
              inputSchema: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Optional human-readable label. Default 'backup'." }
                }
              }
            },
            {
              name: "diff_reports",
              description: "Compares two report folders or a report against a snapshot and produces a structured diff.",
              inputSchema: {
                type: "object",
                properties: {
                  sourcePath: { type: "string", description: "Path to the 'before' report (or snapshot folder)." },
                  targetPath: { type: "string", description: "Path to the 'after' report. Defaults to active connected project." },
                  format: { type: "string", enum: ["json", "markdown", "both"], description: "Output format. Default 'markdown'." }
                },
                required: ["sourcePath"]
              }
            },
            {
              name: "validate_report",
              description: "Lints the entire report structure for consistency and correctness.",
              inputSchema: {
                type: "object",
                properties: {
                  fix: { type: "boolean", description: "Whether to auto-fix minor issues. Default false." }
                }
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
          const result = await tools[toolName](toolArgs);
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
