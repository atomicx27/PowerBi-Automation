const fs = require('fs');
const path = require('path');

const projectPath = 'C:\\Users\\GTXS3893\\Downloads\\aitest.Report';
const pageId = '0ea665b012c1bfd71f25'; // Sales Dashboard

const visualName = `Visual_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

const visualObj = {
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": visualName,
  "position": {
    "x": 920,
    "y": 100,
    "width": 320,
    "height": 450
  },
  "visual": {
    "visualType": "clusteredColumnChart",
    "query": {
      "queryState": {
        "Category": {
          "projections": [
            {
              "field": {
                "Column": {
                  "Expression": { "SourceRef": { "Entity": "financials" } },
                  "Property": "Discount Band"
                }
              },
              "queryRef": "financials.Discount Band"
            }
          ]
        },
        "Y": {
          "projections": [
            {
              "field": {
                "Measure": {
                  "Expression": { "SourceRef": { "Entity": "financials" } },
                  "Property": "Total Sales"
                }
              },
              "queryRef": "financials.Total Sales"
            }
          ]
        }
      }
    }
  }
};

const visualFolder = path.join(projectPath, 'definition', 'pages', pageId, 'visuals', visualName);
fs.mkdirSync(visualFolder, { recursive: true });
fs.writeFileSync(path.join(visualFolder, 'visual.json'), JSON.stringify(visualObj, null, 2), 'utf8');

console.log(`Successfully added visual ${visualName} showing Total Sales by Discount Band.`);
