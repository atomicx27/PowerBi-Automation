const fs = require('fs');
const path = require('path');

// Read the breakdown.json file
const breakdownData = JSON.parse(fs.readFileSync('breakdown.json', 'utf8'));
const csvText = breakdownData.result.content[1].resource.text;

// Parse the CSV
const lines = csvText.trim().split('\r\n');
const headers = lines[0].split(',');

const records = [];
for (let i = 1; i < lines.length; i++) {
  const values = [];
  let currentVal = '';
  let inQuotes = false;
  
  // Custom split to handle potential commas inside quotes (though here simple split is fine)
  const line = lines[i];
  const row = line.split(',');
  
  if (row.length < headers.length) continue;
  
  const record = {
    year: parseInt(row[0]),
    monthNum: parseInt(row[1]),
    monthName: row[2],
    country: row[3],
    segment: row[4],
    sales: parseFloat(row[5]) || 0,
    yoy: row[6] ? parseFloat(row[6]) : null,
    profit: parseFloat(row[7]) || 0,
    units: parseInt(row[8]) || 0
  };
  records.push(record);
}

// Generate the HTML content with embedded data and charts
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Financials & YoY Growth Dashboard</title>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <!-- Chart.js -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(22, 28, 45, 0.6);
            --card-border: rgba(255, 255, 255, 0.08);
            --text-primary: #f3f4f6;
            --text-secondary: #9ca3af;
            --accent-blue: #3b82f6;
            --accent-green: #10b981;
            --accent-purple: #8b5cf6;
            --accent-coral: #f43f5e;
            --glass-shine: rgba(255, 255, 255, 0.03);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Outfit', sans-serif;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 2rem;
            background-image: 
                radial-gradient(at 0% 0%, rgba(59, 130, 246, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.15) 0px, transparent 50%);
            background-attachment: fixed;
        }

        header {
            margin-bottom: 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .logo-area h1 {
            font-size: 2.2rem;
            font-weight: 700;
            background: linear-gradient(135deg, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.25rem;
        }

        .logo-area p {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .filters-container {
            display: flex;
            gap: 1rem;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            padding: 0.75rem 1.5rem;
            border-radius: 16px;
            backdrop-filter: blur(12px);
        }

        .filter-group {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .filter-group label {
            font-size: 0.75rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.05em;
        }

        .filter-group select {
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid var(--card-border);
            color: var(--text-primary);
            padding: 0.5rem 2rem 0.5rem 1rem;
            border-radius: 8px;
            font-size: 0.9rem;
            cursor: pointer;
            outline: none;
            appearance: none;
            background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f3f4f6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
            background-repeat: no-repeat;
            background-position: right 0.7rem center;
            background-size: 1em;
            transition: all 0.2s ease;
        }

        .filter-group select:hover {
            border-color: var(--accent-blue);
        }

        /* KPI Grid */
        .kpi-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .kpi-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 20px;
            padding: 1.5rem;
            backdrop-filter: blur(12px);
            position: relative;
            overflow: hidden;
            transition: transform 0.3s ease, border-color 0.3s ease;
        }

        .kpi-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 100%;
            background: linear-gradient(180deg, var(--glass-shine), transparent);
            pointer-events: none;
        }

        .kpi-card:hover {
            transform: translateY(-4px);
            border-color: rgba(255, 255, 255, 0.15);
        }

        .kpi-title {
            color: var(--text-secondary);
            font-size: 0.9rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .kpi-value {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        .kpi-trend {
            font-size: 0.85rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }

        .trend-up { color: var(--accent-green); }
        .trend-down { color: var(--accent-coral); }
        .trend-neutral { color: var(--text-secondary); }

        /* Dashboard Main Layout */
        .dashboard-layout {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        @media (max-width: 1024px) {
            .dashboard-layout {
                grid-template-columns: 1fr;
            }
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 24px;
            padding: 1.75rem;
            backdrop-filter: blur(12px);
        }

        .card h2 {
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card h2 span.subtitle {
            font-size: 0.8rem;
            font-weight: 400;
            color: var(--text-secondary);
        }

        .chart-container {
            position: relative;
            width: 100%;
            height: 380px;
        }

        /* Table Card styling */
        .table-card {
            grid-column: span 2;
        }

        @media (max-width: 1024px) {
            .table-card {
                grid-column: span 1;
            }
        }

        .data-table-container {
            overflow-x: auto;
            max-height: 400px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }

        th, td {
            padding: 1rem 1.25rem;
            font-size: 0.9rem;
        }

        th {
            background: rgba(15, 23, 42, 0.4);
            font-weight: 600;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--card-border);
            position: sticky;
            top: 0;
            z-index: 10;
            backdrop-filter: blur(8px);
        }

        tr {
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            transition: background-color 0.2s ease;
        }

        tr:hover {
            background: rgba(255, 255, 255, 0.02);
        }

        .badge {
            padding: 0.25rem 0.6rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .badge-positive {
            background: rgba(16, 185, 129, 0.15);
            color: var(--accent-green);
        }

        .badge-negative {
            background: rgba(244, 63, 94, 0.15);
            color: var(--accent-coral);
        }
    </style>
</head>
<body>
    <header>
        <div class="logo-area">
            <h1>YoY Sales Growth Dashboard</h1>
            <p>Interactive Analysis of Power BI Financial Dataset</p>
        </div>
        <div class="filters-container">
            <div class="filter-group">
                <label for="countryFilter">Country</label>
                <select id="countryFilter" onchange="updateDashboard()">
                    <option value="All">All Countries</option>
                </select>
            </div>
            <div class="filter-group">
                <label for="segmentFilter">Segment</label>
                <select id="segmentFilter" onchange="updateDashboard()">
                    <option value="All">All Segments</option>
                </select>
            </div>
        </div>
    </header>

    <!-- Key Metrics Grid -->
    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                Total Sales (YTD 2014)
            </div>
            <div class="kpi-value" id="kpiSales">$0.00</div>
            <div class="kpi-trend" id="salesTrend">
                <span class="trend-up">▲ 2014 vs 2013</span>
            </div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
                Average YoY Growth
            </div>
            <div class="kpi-value" id="kpiYoY">0.0%</div>
            <div class="kpi-trend" id="yoyTrend">
                <span class="trend-up">▲ Dynamic Rate</span>
            </div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
                Total Profit (2014)
            </div>
            <div class="kpi-value" id="kpiProfit">$0.00</div>
            <div class="kpi-trend" id="profitTrend">
                <span class="trend-up">▲ Positive Margin</span>
            </div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
                Units Sold (2014)
            </div>
            <div class="kpi-value" id="kpiUnits">0</div>
            <div class="kpi-trend" id="unitsTrend">
                <span class="trend-up">▲ Active Volume</span>
            </div>
        </div>
    </div>

    <!-- Main Visuals -->
    <div class="dashboard-layout">
        <!-- Sales comparison Chart -->
        <div class="card">
            <h2>Monthly Sales Trend <span class="subtitle">2013 vs 2014 Comparison</span></h2>
            <div class="chart-container">
                <canvas id="salesTrendChart"></canvas>
            </div>
        </div>

        <!-- YoY Growth Rate Chart -->
        <div class="card">
            <h2>Year-over-Year Growth Rate <span class="subtitle">Monthly YoY % (2014)</span></h2>
            <div class="chart-container">
                <canvas id="yoyChart"></canvas>
            </div>
        </div>

        <!-- Detailed Data Table -->
        <div class="card table-card">
            <h2>Monthly Detailed Performance</h2>
            <div class="data-table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Month</th>
                            <th>2013 Sales</th>
                            <th>2014 Sales</th>
                            <th>YoY Growth (%)</th>
                            <th>2014 Profit</th>
                            <th>2014 Units Sold</th>
                        </tr>
                    </thead>
                    <tbody id="dataTableBody">
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        // Inject parsed records from Node.js script
        const rawData = ${JSON.stringify(records, null, 2)};

        // Populate filter select elements
        const countries = [...new Set(rawData.map(r => r.country))].sort();
        const segments = [...new Set(rawData.map(r => r.segment))].sort();

        const countrySelect = document.getElementById('countryFilter');
        countries.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            countrySelect.appendChild(opt);
        });

        const segmentSelect = document.getElementById('segmentFilter');
        segments.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            segmentSelect.appendChild(opt);
        });

        // Initialize variables for Chart.js instances
        let salesChart = null;
        let yoyChartInstance = null;

        // Month formatting helper
        const monthNames = [
            "January", "February", "March", "April", "May", "June", 
            "July", "August", "September", "October", "November", "December"
        ];

        // Format Currency
        function formatCurrency(val) {
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 0
            }).format(val);
        }

        // Format Percent
        function formatPercent(val) {
            if (val === null || val === undefined || isNaN(val)) return 'N/A';
            return (val * 100).toFixed(1) + '%';
        }

        function updateDashboard() {
            const selectedCountry = document.getElementById('countryFilter').value;
            const selectedSegment = document.getElementById('segmentFilter').value;

            // Filter data
            let filtered = rawData;
            if (selectedCountry !== 'All') {
                filtered = filtered.filter(r => r.country === selectedCountry);
            }
            if (selectedSegment !== 'All') {
                filtered = filtered.filter(r => r.segment === selectedSegment);
            }

            // Aggregate Monthly Data for 2013 and 2014
            const monthlyData = {};
            for (let m = 1; m <= 12; m++) {
                monthlyData[m] = {
                    monthName: monthNames[m-1],
                    sales2013: 0,
                    sales2014: 0,
                    profit2014: 0,
                    units2014: 0
                };
            }

            filtered.forEach(r => {
                if (r.year === 2013) {
                    monthlyData[r.monthNum].sales2013 += r.sales;
                } else if (r.year === 2014) {
                    monthlyData[r.monthNum].sales2014 += r.sales;
                    monthlyData[r.monthNum].profit2014 += r.profit;
                    monthlyData[r.monthNum].units2014 += r.units;
                }
            });

            // Calculate KPIs for 2014
            let totalSales2014 = 0;
            let totalSales2013 = 0;
            let totalProfit2014 = 0;
            let totalUnits2014 = 0;
            
            // For YoY, we calculate average YoY growth for the months that have comparative data (Sept-Dec)
            let yoySum = 0;
            let yoyCount = 0;

            const tableRows = [];
            const labels = [];
            const sales13Data = [];
            const sales14Data = [];
            const yoyValues = [];
            const yoyColors = [];

            for (let m = 1; m <= 12; m++) {
                const item = monthlyData[m];
                totalSales2014 += item.sales2014;
                totalSales2013 += item.sales2013;
                totalProfit2014 += item.profit2014;
                totalUnits2014 += item.units2014;

                let yoyVal = null;
                if (item.sales2013 > 0 && item.sales2014 > 0) {
                    yoyVal = (item.sales2014 - item.sales2013) / item.sales2013;
                    yoySum += yoyVal;
                    yoyCount++;
                }

                labels.push(item.monthName);
                sales13Data.push(item.sales2013 > 0 ? item.sales2013 : null);
                sales14Data.push(item.sales2014 > 0 ? item.sales2014 : null);
                
                // Only show YoY chart values if we have comparison
                yoyValues.push(yoyVal !== null ? yoyVal * 100 : null);
                yoyColors.push(yoyVal >= 0 ? '#10b981' : '#f43f5e');

                // Build Table row HTML
                const yoyText = yoyVal !== null ? formatPercent(yoyVal) : '-';
                const yoyClass = yoyVal !== null ? (yoyVal >= 0 ? 'badge-positive' : 'badge-negative') : '';
                const yoyBadge = yoyVal !== null ? \`<span class="badge \${yoyClass}">\${yoyText}</span>\` : '<span style="color:var(--text-secondary)">-</span>';

                tableRows.push(\`
                    <tr>
                        <td><strong>\${item.monthName}</strong></td>
                        <td>\${item.sales2013 > 0 ? formatCurrency(item.sales2013) : '-'}</td>
                        <td>\${item.sales2014 > 0 ? formatCurrency(item.sales2014) : '-'}</td>
                        <td>\${yoyBadge}</td>
                        <td>\${item.sales2014 > 0 ? formatCurrency(item.profit2014) : '-'}</td>
                        <td>\${item.sales2014 > 0 ? item.units2014.toLocaleString() : '-'}</td>
                    </tr>
                \`);
            }

            // Render KPIs
            document.getElementById('kpiSales').textContent = formatCurrency(totalSales2014);
            document.getElementById('kpiProfit').textContent = formatCurrency(totalProfit2014);
            document.getElementById('kpiUnits').textContent = totalUnits2014.toLocaleString();

            const avgYoY = yoyCount > 0 ? yoySum / yoyCount : 0;
            document.getElementById('kpiYoY').textContent = formatPercent(avgYoY);

            // Set table
            document.getElementById('dataTableBody').innerHTML = tableRows.join('');

            // Render Charts
            renderCharts(labels, sales13Data, sales14Data, yoyValues, yoyColors);
        }

        function renderCharts(labels, sales13, sales14, yoy, yoyColors) {
            // Destroy existing charts to reload
            if (salesChart) salesChart.destroy();
            if (yoyChartInstance) yoyChartInstance.destroy();

            // Sales Trend Chart (Double line)
            const ctxSales = document.getElementById('salesTrendChart').getContext('2d');
            salesChart = new Chart(ctxSales, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: '2013 Sales',
                            data: sales13,
                            borderColor: 'rgba(255, 255, 255, 0.35)',
                            backgroundColor: 'transparent',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointBackgroundColor: 'rgba(255, 255, 255, 0.5)',
                            tension: 0.3,
                            spanGaps: true
                        },
                        {
                            label: '2014 Sales',
                            data: sales14,
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.05)',
                            fill: true,
                            borderWidth: 3,
                            pointBackgroundColor: '#3b82f6',
                            tension: 0.3,
                            spanGaps: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#f3f4f6', font: { family: 'Outfit', size: 12 } }
                        }
                    },
                    scales: {
                        x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af' } },
                        y: { 
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }, 
                            ticks: { 
                                color: '#9ca3af',
                                callback: function(value) { return '$' + (value/1000).toLocaleString() + 'k'; }
                            } 
                        }
                    }
                }
            });

            // YoY Growth Bar Chart
            const ctxYoY = document.getElementById('yoyChart').getContext('2d');
            
            // Only show labels/values for months with YoY growth (Sept - Dec)
            const yoyLabels = labels.slice(8); // Sept, Oct, Nov, Dec
            const yoyData = yoy.slice(8);
            const yoyBarColors = yoyColors.slice(8);

            yoyChartInstance = new Chart(ctxYoY, {
                type: 'bar',
                data: {
                    labels: yoyLabels,
                    datasets: [{
                        label: 'YoY Growth (%)',
                        data: yoyData,
                        backgroundColor: yoyBarColors,
                        borderRadius: 8,
                        barThickness: 30
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } },
                        y: { 
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }, 
                            ticks: { 
                                color: '#9ca3af',
                                callback: function(value) { return value.toFixed(0) + '%'; }
                            } 
                        }
                    }
                }
            });
        }

        // Run on load
        updateDashboard();
    </script>
</body>
</html>`;

fs.writeFileSync('dashboard.html', htmlContent, 'utf8');
console.log("Stunning interactive HTML Dashboard created at dashboard.html!");
