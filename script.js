const STORAGE_KEYS = {
  CURRENT_REPORT: "comps_hq_current_report",
  HISTORY: "comps_hq_history"
};

const MIN_RESULTS = 3;

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  if (page === "search") initSearchPage();
  if (page === "results") initResultsPage();
  if (page === "history") initHistoryPage();
});

function initSearchPage() {
  const form = document.getElementById("searchForm");
  const alertBox = document.getElementById("searchAlert");

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const subject = {
      fullAddress: valueOf("fullAddress"),
      streetName: valueOf("streetName"),
      city: valueOf("city"),
      state: valueOf("state").toUpperCase(),
      zipCode: valueOf("zipCode"),
      yearBuilt: numberOf("yearBuilt"),
      bedrooms: numberOf("bedrooms"),
      bathrooms: numberOf("bathrooms"),
      lotSizeSqft: numberOf("lotSizeSqft")
    };

    const criteria = {
      timeRange: valueOf("timeRange"),
      sortOrder: valueOf("sortOrder")
    };

    const missing = Object.entries(subject).filter(([, value]) => value === "" || value === 0 || Number.isNaN(value));
    if (missing.length > 0) {
      showAlert(alertBox, "Please fill in all subject property fields before running the search.");
      return;
    }

    const soldParse = parseSoldListings(document.getElementById("soldInput").value);
    if (!soldParse.ok) {
      showAlert(alertBox, soldParse.error);
      return;
    }

    const activeParse = parseActiveListings(document.getElementById("activeInput").value);
    if (!activeParse.ok) {
      showAlert(alertBox, activeParse.error);
      return;
    }

    if (soldParse.data.length === 0) {
      showAlert(alertBox, "Please paste at least one sold comp line.");
      return;
    }

    if (activeParse.data.length === 0) {
      showAlert(alertBox, "Please paste at least one active listing line.");
      return;
    }

    hideAlert(alertBox);

    const report = buildReport(subject, criteria, soldParse.data, activeParse.data);
    saveCurrentReport(report);
    saveReportToHistory(report);

    window.location.href = `./results.html?report=${encodeURIComponent(report.id)}`;
  });
}

function initResultsPage() {
  const loading = document.getElementById("resultsLoading");
  const root = document.getElementById("resultsRoot");
  const reportId = new URLSearchParams(window.location.search).get("report");
  const report = reportId ? getReportById(reportId) : getCurrentReport();

  window.setTimeout(() => {
    loading.classList.add("hidden");
    root.classList.remove("hidden");

    if (!report) {
      root.innerHTML = `
        <div class="empty-state">
          <h3 class="empty-title">No report found</h3>
          <p class="empty-text">Run a new search first so the results page has data to display.</p>
          <div class="history-actions">
            <a class="button button-primary" href="./search.html">Start New Search</a>
            <a class="button button-secondary" href="./history.html">Open History</a>
          </div>
        </div>
      `;
      return;
    }

    root.innerHTML = renderResultsPage(report);
    bindCopyButtons(report);
  }, 400);
}

function initHistoryPage() {
  const root = document.getElementById("historyRoot");
  const history = getHistory();

  if (history.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <h3 class="empty-title">No saved reports yet</h3>
        <p class="empty-text">Run a search and your reports will appear here.</p>
        <div class="history-actions">
          <a class="button button-primary" href="./search.html">Start New Search</a>
        </div>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <div class="history-list">
      ${history.map(renderHistoryCard).join("")}
    </div>
  `;
}

function buildReport(subject, criteria, soldCandidates, activeCandidates) {
  const soldFiltered = filterSoldCandidatesByTimeRange(soldCandidates, criteria.timeRange)
    .filter((item) => sameCityOnly(subject, item));
  const activeFiltered = activeCandidates
    .filter((item) => sameCityOnly(subject, item))
    .filter((item) => {
      const status = String(item.status || "").toLowerCase();
      return status === "active" || status === "for-sale";
    });

  const soldResults = selectGroup(subject, soldFiltered, "sold", criteria.sortOrder);
  const activeResults = selectGroup(subject, activeFiltered, "active", criteria.sortOrder);

  const averageSoldPrice = soldResults.selected.length
    ? Math.round(soldResults.selected.reduce((sum, item) => sum + item.price, 0) / soldResults.selected.length)
    : 0;

  const novationOffer = Math.round(averageSoldPrice * 0.94 - 40000);
  const sixtyPercentOffer = Math.round(averageSoldPrice * 0.60);

  return {
    id: createId(),
    createdAt: new Date().toISOString(),
    subject,
    criteria,
    soldComps: soldResults.selected,
    activeListings: activeResults.selected,
    soldExactMatchCount: soldResults.exactCount,
    activeExactMatchCount: activeResults.exactCount,
    soldFallbackUsed: soldResults.fallbackUsed,
    activeFallbackUsed: activeResults.fallbackUsed,
    metrics: {
      averageSoldPrice,
      novationOffer,
      sixtyPercentOffer
    },
    notes: "Static GitHub Pages workflow using manually pasted Zillow research data."
  };
}

function selectGroup(subject, records, type, sortOrder) {
  const ranked = records
    .map((item) => rankProperty(subject, item, type))
    .filter((item) => item.similarityScore > 0);

  const exact = ranked.filter((item) => item.matchType === "exact");
  const sorted = [...ranked].sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === "exact" ? -1 : 1;
    if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;

    if (type === "sold") {
      const aDate = new Date(a.soldDate).getTime();
      const bDate = new Date(b.soldDate).getTime();
      return sortOrder === "NEWEST_TO_OLDEST" ? bDate - aDate : aDate - bDate;
    }

    return a.daysOnMarket - b.daysOnMarket;
  });

  const selected = exact.length >= MIN_RESULTS ? sorted.slice(0, MIN_RESULTS) : sorted.slice(0, MIN_RESULTS);

  return {
    selected,
    exactCount: exact.length,
    fallbackUsed: exact.length < MIN_RESULTS
  };
}

function rankProperty(subject, item, type) {
  const exact = isExactMatch(subject, item);
  const score = similarityScore(subject, item);
  const explanation = buildExplanation(subject, item, exact, type);

  return {
    ...item,
    similarityScore: score,
    matchType: exact ? "exact" : "closest",
    explanation
  };
}

function isExactMatch(subject, item) {
  return (
    sameCityOnly(subject, item) &&
    Math.abs(subject.bedrooms - item.bedrooms) <= 1 &&
    Math.abs(subject.bathrooms - item.bathrooms) <= 1 &&
    lotDifferencePercent(subject.lotSizeSqft, item.lotSizeSqft) <= 0.20 &&
    Math.abs(subject.yearBuilt - item.yearBuilt) <= 10
  );
}

function similarityScore(subject, item) {
  if (!sameCityOnly(subject, item)) return 0;

  const bedScore = clamp(1 - Math.abs(subject.bedrooms - item.bedrooms) / 4);
  const bathScore = clamp(1 - Math.abs(subject.bathrooms - item.bathrooms) / 3);
  const lotScore = clamp(1 - lotDifferencePercent(subject.lotSizeSqft, item.lotSizeSqft));
  const yearScore = clamp(1 - Math.abs(subject.yearBuilt - item.yearBuilt) / 25);

  return round(
    bedScore * 0.27 +
    bathScore * 0.25 +
    lotScore * 0.25 +
    yearScore * 0.23
  );
}

function buildExplanation(subject, item, exact, type) {
  const bedDiff = Math.abs(subject.bedrooms - item.bedrooms);
  const bathDiff = Math.abs(subject.bathrooms - item.bathrooms);
  const lotDiff = Math.round(lotDifferencePercent(subject.lotSizeSqft, item.lotSizeSqft) * 100);
  const yearDiff = Math.abs(subject.yearBuilt - item.yearBuilt);

  if (exact) {
    return `Exact same-city ${type === "sold" ? "comp" : "listing"}: beds ${bedDiff}, baths ${bathDiff}, lot ${lotDiff}% difference, year built ${yearDiff} years apart.`;
  }

  return `Closest same-city ${type === "sold" ? "comp" : "listing"} fallback: beds ${bedDiff}, baths ${bathDiff}, lot ${lotDiff}% difference, year built ${yearDiff} years apart.`;
}

function parseSoldListings(text) {
  const lines = splitLines(text);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|").map((part) => part.trim());
    if (parts.length < 12) {
      return { ok: false, error: `Sold comps line ${i + 1} is incomplete.` };
    }

    const item = {
      type: "sold",
      address: parts[0],
      city: parts[1],
      state: parts[2].toUpperCase(),
      zipCode: parts[3],
      price: Number(parts[4]),
      soldDate: parts[5],
      daysOnMarket: Number(parts[6]),
      priceDrops: Number(parts[7]),
      bedrooms: Number(parts[8]),
      bathrooms: Number(parts[9]),
      lotSizeSqft: Number(parts[10]),
      yearBuilt: Number(parts[11])
    };

    if (!item.address || !item.city || !item.state || !item.zipCode || Number.isNaN(item.price)) {
      return { ok: false, error: `Sold comps line ${i + 1} has invalid values.` };
    }

    items.push(item);
  }

  return { ok: true, data: items };
}

function parseActiveListings(text) {
  const lines = splitLines(text);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|").map((part) => part.trim());
    if (parts.length < 11) {
      return { ok: false, error: `Active listings line ${i + 1} is incomplete.` };
    }

    const item = {
      type: "active",
      address: parts[0],
      city: parts[1],
      state: parts[2].toUpperCase(),
      zipCode: parts[3],
      price: Number(parts[4]),
      daysOnMarket: Number(parts[5]),
      bedrooms: Number(parts[6]),
      bathrooms: Number(parts[7]),
      lotSizeSqft: Number(parts[8]),
      yearBuilt: Number(parts[9]),
      status: String(parts[10]).toLowerCase()
    };

    if (!item.address || !item.city || !item.state || !item.zipCode || Number.isNaN(item.price)) {
      return { ok: false, error: `Active listings line ${i + 1} has invalid values.` };
    }

    items.push(item);
  }

  return { ok: true, data: items };
}

function filterSoldCandidatesByTimeRange(records, timeRange) {
  const cutoff = getCutoffDate(timeRange);

  return records.filter((item) => {
    const soldDate = new Date(item.soldDate);
    return !Number.isNaN(soldDate.getTime()) && soldDate >= cutoff;
  });
}

function getCutoffDate(timeRange) {
  const now = new Date();
  const date = new Date(now);

  if (timeRange === "LAST_6_MONTHS") date.setMonth(date.getMonth() - 6);
  if (timeRange === "LAST_12_MONTHS") date.setMonth(date.getMonth() - 12);
  if (timeRange === "LAST_24_MONTHS") date.setMonth(date.getMonth() - 24);

  return date;
}

function sameCityOnly(subject, item) {
  return (
    String(subject.city).trim().toLowerCase() === String(item.city).trim().toLowerCase() &&
    String(subject.state).trim().toLowerCase() === String(item.state).trim().toLowerCase()
  );
}

function lotDifferencePercent(a, b) {
  if (!a) return 1;
  return Math.abs(b - a) / a;
}

function clamp(value) {
  return Math.min(Math.max(value, 0), 1);
}

function round(value) {
  return Number(value.toFixed(4));
}

function renderResultsPage(report) {
  return `
    <div class="result-stack">
      <div class="page-hero">
        <div>
          <div class="eyebrow">Results</div>
          <h2 class="page-title">Comp Search Report</h2>
          <p class="page-subtitle">Manual Zillow input turned into same-city sold comps, active listings, summary copy, and offer calculations.</p>
        </div>
        <div class="hero-actions">
          <a class="button button-secondary" href="./search.html">New Search</a>
          <a class="button button-primary" href="./history.html">View History</a>
        </div>
      </div>

      ${renderSubjectCard(report)}
      ${renderKpis(report)}
      ${renderSoldSection(report)}
      ${renderActiveSection(report)}
      ${renderCopyBlock(report)}
      ${renderMetadata(report)}
    </div>
  `;
}

function renderSubjectCard(report) {
  return `
    <section class="panel hero-panel">
      <div class="section-head">
        <div>
          <div class="eyebrow">1. Subject Property Card</div>
          <h3 class="section-title">${escapeHtml(report.subject.fullAddress)}</h3>
          <p class="hero-text">${escapeHtml(report.subject.city)}, ${escapeHtml(report.subject.state)} ${escapeHtml(report.subject.zipCode)}</p>
        </div>
      </div>

      <div class="hero-grid">
        <div>
          <div class="mini-grid">
            <div class="mini-card">
              <div class="meta-key">Street</div>
              <div class="meta-value">${escapeHtml(report.subject.streetName)}</div>
            </div>
            <div class="mini-card">
              <div class="meta-key">Bedrooms</div>
              <div class="meta-value">${report.subject.bedrooms}</div>
            </div>
            <div class="mini-card">
              <div class="meta-key">Bathrooms</div>
              <div class="meta-value">${report.subject.bathrooms}</div>
            </div>
            <div class="mini-card">
              <div class="meta-key">Lot Size</div>
              <div class="meta-value">${formatNumber(report.subject.lotSizeSqft)} sqft</div>
            </div>
            <div class="mini-card">
              <div class="meta-key">Year Built</div>
              <div class="meta-value">${report.subject.yearBuilt}</div>
            </div>
            <div class="mini-card">
              <div class="meta-key">City Lock</div>
              <div class="meta-value">${escapeHtml(report.subject.city)}</div>
            </div>
          </div>
        </div>

        <div class="side-stack">
          <div class="side-card">
            <div class="meta-key">Sold Matches</div>
            <div class="meta-value">${report.soldComps.length} selected</div>
          </div>
          <div class="side-card">
            <div class="meta-key">Active Matches</div>
            <div class="meta-value">${report.activeListings.length} selected</div>
          </div>
          <div class="side-card">
            <div class="meta-key">Exact Matches</div>
            <div class="meta-value">${report.soldExactMatchCount} sold / ${report.activeExactMatchCount} active</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderKpis(report) {
  return `
    <section>
      <div class="section-head">
        <div>
          <div class="eyebrow">2. KPI Cards</div>
          <h3 class="section-title">Offer Snapshot</h3>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Average Sold Price</div>
          <div class="kpi-value">${formatCurrency(report.metrics.averageSoldPrice)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Novation Offer</div>
          <div class="kpi-value">${formatCurrency(report.metrics.novationOffer)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">60% Offer</div>
          <div class="kpi-value">${formatCurrency(report.metrics.sixtyPercentOffer)}</div>
        </div>
      </div>
    </section>
  `;
}

function renderSoldSection(report) {
  if (!report.soldComps.length) {
    return `
      <section>
        <div class="section-head">
          <div>
            <div class="eyebrow">3. Sold Comps Section</div>
            <h3 class="section-title">Sold Comps</h3>
          </div>
        </div>
        <div class="empty-state">
          <h4 class="empty-title">No sold comps available</h4>
          <p class="empty-text">No sold properties matched your pasted data within the selected window and same-city rule.</p>
        </div>
      </section>
    `;
  }

  return `
    <section>
      <div class="section-head">
        <div>
          <div class="eyebrow">3. Sold Comps Section</div>
          <h3 class="section-title">Sold Comps</h3>
        </div>
      </div>

      <div class="table-card">
        <div class="table-header">
          <h3>Comparable Sold Properties</h3>
          <p>Sold comps are filtered by sold date window, same city, and your matching rules.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Sold Price</th>
                <th>Sold Date</th>
                <th>DOM</th>
                <th>Drops</th>
                <th>Beds</th>
                <th>Baths</th>
                <th>Lot</th>
                <th>Built</th>
                <th>Match</th>
                <th>Similarity</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              ${report.soldComps.map((item) => `
                <tr>
                  <td>${escapeHtml(item.address)}</td>
                  <td>${formatCurrency(item.price)}</td>
                  <td>${formatDate(item.soldDate)}</td>
                  <td>${item.daysOnMarket}</td>
                  <td>${item.priceDrops}</td>
                  <td>${item.bedrooms}</td>
                  <td>${item.bathrooms}</td>
                  <td>${formatNumber(item.lotSizeSqft)} sqft</td>
                  <td>${item.yearBuilt}</td>
                  <td>${matchBadge(item.matchType)}</td>
                  <td>${Math.round(item.similarityScore * 100)}%</td>
                  <td>${escapeHtml(item.explanation)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderActiveSection(report) {
  if (!report.activeListings.length) {
    return `
      <section>
        <div class="section-head">
          <div>
            <div class="eyebrow">4. Active Listings Section</div>
            <h3 class="section-title">Active Listings</h3>
          </div>
        </div>
        <div class="empty-state">
          <h4 class="empty-title">No active listings available</h4>
          <p class="empty-text">No active or for-sale listings matched your pasted same-city data.</p>
        </div>
      </section>
    `;
  }

  return `
    <section>
      <div class="section-head">
        <div>
          <div class="eyebrow">4. Active Listings Section</div>
          <h3 class="section-title">Active Listings</h3>
        </div>
      </div>

      <div class="table-card">
        <div class="table-header">
          <h3>Current Active Listings</h3>
          <p>Active listings must be active / for-sale and stay inside the same city as the subject property.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>List Price</th>
                <th>DOM</th>
                <th>Beds</th>
                <th>Baths</th>
                <th>Lot</th>
                <th>Built</th>
                <th>Match</th>
                <th>Similarity</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              ${report.activeListings.map((item) => `
                <tr>
                  <td>${escapeHtml(item.address)}</td>
                  <td>${formatCurrency(item.price)}</td>
                  <td>${item.daysOnMarket}</td>
                  <td>${item.bedrooms}</td>
                  <td>${item.bathrooms}</td>
                  <td>${formatNumber(item.lotSizeSqft)} sqft</td>
                  <td>${item.yearBuilt}</td>
                  <td>${matchBadge(item.matchType)}</td>
                  <td>${Math.round(item.similarityScore * 100)}%</td>
                  <td>${escapeHtml(item.explanation)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderCopyBlock(report) {
  return `
    <section>
      <div class="section-head">
        <div>
          <div class="eyebrow">5. Copy/Paste Summary Block</div>
          <h3 class="section-title">CRM Copy Block</h3>
        </div>
      </div>

      <div class="panel copy-panel">
        <div class="copy-actions">
          <button class="button button-primary" id="copySoldBtn">Copy Sold Comps</button>
          <button class="button button-secondary" id="copyActiveBtn">Copy Active Listings</button>
          <button class="button button-outline" id="copyFullBtn">Copy Full Report</button>
        </div>
        <textarea id="summaryOutput" readonly>${buildQuickSummary(report)}</textarea>
      </div>
    </section>
  `;
}

function renderMetadata(report) {
  return `
    <section>
      <div class="section-head">
        <div>
          <div class="eyebrow">6. Search Metadata / Filters Used</div>
          <h3 class="section-title">Saved Filters & Search Context</h3>
        </div>
      </div>

      <div class="panel">
        <div class="meta-grid">
          <div class="meta-card">
            <div class="meta-key">Saved</div>
            <div class="meta-value">${formatDate(report.createdAt)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Sold Date Window</div>
            <div class="meta-value">${humanTimeRange(report.criteria.timeRange)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Sold Sort</div>
            <div class="meta-value">${humanSort(report.criteria.sortOrder)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">City Lock</div>
            <div class="meta-value">${escapeHtml(report.subject.city)}, ${escapeHtml(report.subject.state)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Beds Rule</div>
            <div class="meta-value">± 1</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Baths Rule</div>
            <div class="meta-value">± 1</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Lot Size Rule</div>
            <div class="meta-value">± 20%</div>
          </div>
          <div class="meta-card">
            <div class="meta-key">Year Built Rule</div>
            <div class="meta-value">± 10 years</div>
          </div>
        </div>

        <div class="separator"></div>
        <p class="meta-text">${escapeHtml(report.notes)}</p>
      </div>
    </section>
  `;
}

function renderHistoryCard(report) {
  return `
    <div class="history-card">
      <div class="eyebrow">Saved Report</div>
      <h3>${escapeHtml(report.subject.fullAddress)}</h3>
      <p>${escapeHtml(report.subject.city)}, ${escapeHtml(report.subject.state)} ${escapeHtml(report.subject.zipCode)}</p>
      <p class="meta-text">Average Sold Price: ${formatCurrency(report.metrics.averageSoldPrice)}</p>
      <p class="meta-text">Saved: ${formatDate(report.createdAt)}</p>
      <div class="history-actions">
        <a class="button button-primary" href="./results.html?report=${encodeURIComponent(report.id)}">Open Report</a>
        <a class="button button-secondary" href="./search.html">New Search</a>
      </div>
    </div>
  `;
}

function bindCopyButtons(report) {
  const output = document.getElementById("summaryOutput");
  const sold = buildSoldSummary(report);
  const active = buildActiveSummary(report);
  const full = buildQuickSummary(report);

  document.getElementById("copySoldBtn").addEventListener("click", () => {
    output.value = sold;
    copyText(sold);
  });

  document.getElementById("copyActiveBtn").addEventListener("click", () => {
    output.value = active;
    copyText(active);
  });

  document.getElementById("copyFullBtn").addEventListener("click", () => {
    output.value = full;
    copyText(full);
  });
}

function buildSoldSummary(report) {
  return [
    "SOLD COMPS:",
    ...report.soldComps.map((item) => `${item.address} — ${formatCurrency(item.price)}`),
    "",
    `Average Sold Price: ${formatCurrency(report.metrics.averageSoldPrice)}`,
    `Novation Offer: ${formatCurrency(report.metrics.novationOffer)}`,
    `60% Offer: ${formatCurrency(report.metrics.sixtyPercentOffer)}`
  ].join("\n");
}

function buildActiveSummary(report) {
  return [
    "ACTIVE LISTINGS:",
    ...report.activeListings.map((item) => `${item.address} — ${formatCurrency(item.price)}`)
  ].join("\n");
}

function buildQuickSummary(report) {
  return `${buildSoldSummary(report)}\n\n${buildActiveSummary(report)}`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert("Copied to clipboard");
  });
}

function matchBadge(matchType) {
  if (matchType === "exact") {
    return `<span class="badge badge-exact">Exact</span>`;
  }
  return `<span class="badge badge-fallback">Closest</span>`;
}

function saveCurrentReport(report) {
  localStorage.setItem(STORAGE_KEYS.CURRENT_REPORT, JSON.stringify(report));
}

function getCurrentReport() {
  const raw = localStorage.getItem(STORAGE_KEYS.CURRENT_REPORT);
  return raw ? JSON.parse(raw) : null;
}

function saveReportToHistory(report) {
  const history = getHistory();
  const next = [report, ...history.filter((item) => item.id !== report.id)];
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(next.slice(0, 50)));
}

function getHistory() {
  const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
  return raw ? JSON.parse(raw) : [];
}

function getReportById(id) {
  return getHistory().find((item) => item.id === id) || null;
}

function valueOf(id) {
  return String(document.getElementById(id).value || "").trim();
}

function numberOf(id) {
  return Number(document.getElementById(id).value);
}

function splitLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function showAlert(node, message) {
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideAlert(node) {
  node.textContent = "";
  node.classList.add("hidden");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function humanTimeRange(value) {
  if (value === "LAST_6_MONTHS") return "Last 6 months";
  if (value === "LAST_12_MONTHS") return "Last 12 months";
  return "Last 24 months";
}

function humanSort(value) {
  return value === "OLDEST_TO_NEWEST" ? "Oldest to newest" : "Newest to oldest";
}

function createId() {
  return `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
