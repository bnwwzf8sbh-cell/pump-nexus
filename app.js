const PUMP_BASE = "https://frontend-api-v3.pump.fun/coins";
const WATCH_KEY = "pump-nexus-watch";

const state = {
  tab: "radar",
  query: "",
  coins: [],
  selected: null,
  solUsd: null,
  source: "idle",
  error: null,
};

const $ = (id) => document.getElementById(id);

function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(3)}`;
}

function usdMarketCap(c) {
  return Number(c.market_cap_usd ?? c.usd_market_cap ?? 0);
}

function priceUsd(c) {
  const supply = Number(c.total_supply || 1e9);
  const mcap = usdMarketCap(c);
  if (mcap > 0 && supply > 0) return mcap / (supply / 1e6 > 1e6 ? supply / 1e6 : 1e9);
  // pump.fun typically 1e9 display supply
  if (mcap > 0) return mcap / 1e9;
  return null;
}

function age(ts) {
  if (!ts) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function scoreOf(c) {
  const replies = Number(c.reply_count || 0);
  const live = c.is_currently_live ? 18 : 0;
  const complete = c.complete ? 12 : 0;
  const recency = (() => {
    const ts = c.last_trade_timestamp || c.created_timestamp;
    if (!ts) return 0;
    const ms = ts > 1e12 ? ts : ts * 1000;
    const h = (Date.now() - ms) / 36e5;
    return Math.max(0, 30 - h);
  })();
  const curve = bondingPct(c);
  return Math.max(1, Math.min(99, Math.round(20 + live + complete + Math.min(25, replies / 8) + recency * 0.4 + curve * 0.15)));
}

function bondingPct(c) {
  if (c.complete) return 100;
  const realSol = Number(c.real_sol_reserves || 0) / 1e9;
  // classic pump curve ~85 SOL to graduate; clamp
  if (realSol > 0) return Math.max(0, Math.min(99, (realSol / 85) * 100));
  return 0;
}

function initials(sym) {
  return (sym || "??").slice(0, 2).toUpperCase();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchWithFallback(url) {
  try {
    return await fetchJson(url);
  } catch (e1) {
    const proxied = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    try {
      return await fetchJson(proxied);
    } catch (e2) {
      const origin = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      return fetchJson(origin);
    }
  }
}

function pumpUrl(params) {
  const u = new URL(PUMP_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  });
  return u.toString();
}

const queries = {
  radar: { offset: 0, limit: 50, sort: "market_cap", order: "DESC", includeNsfw: false },
  new: { offset: 0, limit: 50, sort: "created_timestamp", order: "DESC", includeNsfw: false },
  live: { offset: 0, limit: 50, sort: "last_trade_timestamp", order: "DESC", includeNsfw: false },
  majors: { offset: 0, limit: 50, sort: "market_cap", order: "DESC", includeNsfw: false, complete: true },
  watch: { offset: 0, limit: 50, sort: "last_trade_timestamp", order: "DESC", includeNsfw: false },
};

async function loadSol() {
  try {
    const data = await fetchWithFallback(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112"
    );
    const pair = (data.pairs || []).find((p) => p.quoteToken?.symbol === "USDC" || p.quoteToken?.symbol === "USDT")
      || data.pairs?.[0];
    if (pair?.priceUsd) state.solUsd = Number(pair.priceUsd);
  } catch {
    /* keep last */
  }
}

function watchlist() {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
  } catch {
    return [];
  }
}

function toggleWatch(mint) {
  const list = watchlist();
  const i = list.indexOf(mint);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(mint);
  localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 40)));
  renderDetail(state.selected);
}

async function loadTab() {
  setRelay("RELAYING", "live");
  try {
    if (state.tab === "watch") {
      const mints = watchlist();
      if (!mints.length) {
        state.coins = [];
        state.source = "watchlist empty";
      } else {
        const pages = await fetchWithFallback(pumpUrl(queries.radar));
        const set = new Set(mints);
        state.coins = (Array.isArray(pages) ? pages : []).filter((c) => set.has(c.mint));
        // fetch missing individually
        const have = new Set(state.coins.map((c) => c.mint));
        for (const mint of mints) {
          if (have.has(mint)) continue;
          try {
            const one = await fetchWithFallback(`${PUMP_BASE}/${mint}`);
            if (one?.mint) state.coins.push(one);
          } catch {
            /* skip */
          }
        }
        state.source = "watchlist ∩ pump.fun";
      }
    } else {
      const raw = await fetchWithFallback(pumpUrl(queries[state.tab] || queries.radar));
      let coins = Array.isArray(raw) ? raw : raw?.coins || [];
      if (state.tab === "live") {
        const livestream = coins.filter((c) => c.is_currently_live);
        coins = livestream.length ? livestream : coins;
        state.source = livestream.length ? "livestreams" : "last trades (no live rooms)";
      } else {
        state.source = `pump.fun ${state.tab}`;
      }
      state.coins = coins;
    }
    state.error = null;
    setRelay("RELAYING", "live");
  } catch (err) {
    state.error = String(err.message || err);
    setRelay("OFFLINE", "err");
    state.source = state.error;
  }
  render();
}

function setRelay(label, cls) {
  $("relayLabel").textContent = label;
  $("relay-pill")?.classList.remove("live", "err");
  document.querySelector(".relay-pill").classList.remove("live", "err");
  if (cls) document.querySelector(".relay-pill").classList.add(cls);
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.coins;
  return state.coins.filter((c) =>
    [c.symbol, c.name, c.mint, c.creator].filter(Boolean).some((x) => String(x).toLowerCase().includes(q))
  );
}

function renderFeed() {
  const list = filtered();
  $("feedCount").textContent = `${list.length} signals`;
  $("feed").innerHTML = list
    .map((c) => {
      const sel = state.selected?.mint === c.mint ? "sel" : "";
      const chg = ""; // no reliable 24h from this endpoint
      const img = c.image_uri
        ? `<img src="${c.image_uri}" alt="" onerror="this.remove()">`
        : initials(c.symbol);
      return `<div class="row ${sel}" data-mint="${c.mint}">
        <div class="avatar">${img}</div>
        <div class="meta">
          <div><b>${escapeHtml(c.symbol || "???")}</b>
            <span class="badge ${c.complete ? "" : "curve"}">${c.complete ? "GRADUATED" : "CURVE"}</span>
          </div>
          <small>${escapeHtml(c.name || "")}</small>
        </div>
        <div class="nums">
          <div>${fmtUsd(usdMarketCap(c))}</div>
          <div class="age">${age(c.last_trade_timestamp || c.created_timestamp)}</div>
        </div>
      </div>`;
    })
    .join("");
  $("feed").querySelectorAll(".row").forEach((el) => {
    el.addEventListener("click", () => {
      state.selected = state.coins.find((c) => c.mint === el.dataset.mint) || null;
      render();
      enrichSelected();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[ch]));
}

function snippet(c) {
  const mint = c?.mint || "—";
  const short = mint.length > 16 ? `${mint.slice(0, 8)}…${mint.slice(-6)}` : mint;
  return `<span class="cm">// live relay snapshot — read only</span>
<span class="kw">import</span> { useRelay } <span class="kw">from</span> <span class="st">"./hooks/useRelay"</span>;

<span class="kw">const</span> EXPLORER_TX_URLS = {
  solana: <span class="st">"https://solscan.io/tx/"</span>,
  1: <span class="st">"https://etherscan.io/tx/"</span>,
};

<span class="kw">const</span> target = {
  symbol: <span class="st">"${escapeHtml(c?.symbol || "")}"</span>,
  name: <span class="st">"${escapeHtml(c?.name || "")}"</span>,
  mint: <span class="st">"${short}"</span>,
  mcap: <span class="st">"${fmtUsd(c ? usdMarketCap(c) : null)}"</span>,
  score: ${c ? scoreOf(c) : 0},
  status: <span class="st">"${c?.complete ? "graduated" : "bonding"}"</span>,
  chain: <span class="st">"solana"</span>,
};

<span class="kw">export function</span> <span class="fn">StatCard</span>({ label, value }) {
  <span class="kw">return</span> <div className=<span class="st">"stat-card"</span>>{value}</div>
}

<span class="kw">export function</span> <span class="fn">TxHash</span>({ hash = target.mint }) {
  <span class="kw">return</span> <a href={<span class="st">\`https://solscan.io/token/\${hash}\`</span>}>{hash}</a>
}`;
}

function renderDetail(c) {
  if (!c) {
    $("detail").innerHTML = `<div class="panel-h"><span class="lights"><i></i><i></i><i></i></span>UX CROSSSECTION</div><p class="empty">Select a signal in the feed.</p>`;
    $("codePane").innerHTML = snippet(null);
    $("midSymbol").textContent = "—";
    return;
  }
  const watching = watchlist().includes(c.mint);
  const pct = bondingPct(c);
  const px = c._pairPrice ?? priceUsd(c);
  const ath = c.ath_market_cap && usdMarketCap(c) ? ((usdMarketCap(c) / c.ath_market_cap) - 1) * 100 : null;
  $("codePane").innerHTML = snippet(c);
  $("midSymbol").textContent = c.symbol || "—";
  $("detail").innerHTML = `
    <div class="panel-h"><span class="lights"><i></i><i></i><i></i></span>UX CROSSSECTION</div>
    <div class="detail-head">
      <div class="avatar">${c.image_uri ? `<img src="${c.image_uri}" alt="">` : initials(c.symbol)}</div>
      <div>
        <div><b>${escapeHtml(c.symbol || "")}</b> <span class="badge ${c.complete ? "" : "curve"}">${c.complete ? "GRADUATED" : "CURVE"}</span></div>
        <small style="color:var(--dim)">${escapeHtml(c.name || "")}</small>
      </div>
    </div>
    <div class="detail-grid">
      <div class="stat"><label>PRICE</label><b>${px != null ? fmtUsd(px).replace("$", "$") : "—"}</b></div>
      <div class="stat"><label>VS ATH MCAP</label><b class="${ath != null && ath < 0 ? "chg down" : ""}">${ath == null ? "—" : `${ath.toFixed(1)}%`}</b></div>
      <div class="stat"><label>MARKET CAP</label><b>${fmtUsd(usdMarketCap(c))}</b></div>
      <div class="stat"><label>SCORE</label><b>${scoreOf(c)}</b></div>
    </div>
    <div class="curvebar"><span style="width:${pct}%"></span></div>
    <div class="rows">
      <div><span>Bonding</span><span>${c.complete ? "GRADUATED" : `${pct.toFixed(1)}%`}</span></div>
      <div><span>Mint</span><a href="https://solscan.io/token/${c.mint}" target="_blank" rel="noopener">${c.mint}</a></div>
      <div><span>Creator</span><a href="https://solscan.io/account/${c.creator || ""}" target="_blank" rel="noopener">${c.creator || "—"}</a></div>
      <div><span>Replies</span><span>${c.reply_count ?? 0}</span></div>
      <div><span>Created</span><span>${age(c.created_timestamp)}</span></div>
      <div><span>Last print</span><span>${age(c.last_trade_timestamp)}</span></div>
    </div>
    <div class="actions">
      <button type="button" id="watchBtn">${watching ? "Unwatch" : "Watch"}</button>
      <a href="https://pump.fun/${c.mint}" target="_blank" rel="noopener">Open</a>
      <a href="https://dexscreener.com/solana/${c.mint}" target="_blank" rel="noopener">Chart</a>
    </div>`;
  $("watchBtn")?.addEventListener("click", () => toggleWatch(c.mint));
}

async function enrichSelected() {
  const c = state.selected;
  if (!c?.mint) return;
  try {
    const data = await fetchWithFallback(`https://api.dexscreener.com/latest/dex/tokens/${c.mint}`);
    const pair = (data.pairs || [])[0];
    if (pair?.priceUsd) {
      c._pairPrice = Number(pair.priceUsd);
      renderDetail(c);
    }
  } catch {
    /* ignore */
  }
}

function renderKpis() {
  const list = filtered();
  const cap = list.reduce((s, c) => s + usdMarketCap(c), 0);
  const lives = list.filter((c) => c.is_currently_live).length;
  const avg = list.length ? Math.round(list.reduce((s, c) => s + scoreOf(c), 0) / list.length) : 0;
  $("kpiCap").textContent = fmtUsd(cap);
  $("kpiLive").textContent = String(lives);
  $("kpiScore").textContent = String(avg || "—");
  $("kpiChannel").textContent = state.error ? "OFFLINE" : "LIVE";
  $("kpiSource").textContent = state.source;
  $("solPrice").textContent = state.solUsd ? `SOL $${state.solUsd.toFixed(2)}` : "SOL —";
}

function renderTape() {
  const bits = filtered()
    .slice(0, 18)
    .map((c) => `<span><b>${escapeHtml(c.symbol || "")}</b> ${fmtUsd(usdMarketCap(c))}</span>`);
  $("tape").innerHTML = bits.join("");
}

function drawConstellation() {
  const canvas = $("constellation");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const nodes = filtered().slice(0, 18);
  nodes.forEach((c, i) => {
    const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const r = 28 + (scoreOf(c) % 40);
    const x = w / 2 + Math.cos(a) * r * 1.8;
    const y = h / 2 + Math.sin(a) * r * 0.7;
    ctx.beginPath();
    ctx.fillStyle = c.complete ? "#00e5ff" : "#c77dff";
    ctx.globalAlpha = 0.85;
    ctx.arc(x, y, 5 + (usdMarketCap(c) > 1e7 ? 4 : 0), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function render() {
  renderFeed();
  renderDetail(state.selected);
  renderKpis();
  renderTape();
  drawConstellation();
}

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  [...$("tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
  state.selected = null;
  loadTab();
});

$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

$("constellation").addEventListener("click", () => {
  const list = filtered();
  if (!list.length) return;
  state.selected = list[Math.floor(Math.random() * list.length)];
  render();
  enrichSelected();
});

loadSol();
loadTab();
setInterval(loadTab, 20000);
setInterval(loadSol, 60000);
setInterval(() => {
  renderFeed();
  renderKpis();
  renderTape();
}, 1000);
