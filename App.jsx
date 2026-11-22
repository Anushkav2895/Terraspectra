import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PolygonLayer } from "@deck.gl/layers";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { LayoutDashboard, MapPin, Leaf, FileText, Settings, LogOut, Search, Bell, CalendarDays, Upload, Download, ShieldCheck, ShieldAlert, Activity, Sprout, Satellite } from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8000/predict_raw" : "/predict_raw"); // set VITE_API_URL when hosting the dashboard separately (e.g. Vercel)
const ORIGIN = { lng: 113.0, lat: 35.0 }; // demo location (dataset has no GPS)
const TILE_M = 100; // each 64x64 tile is drawn as 100 m x 100 m (demo scale)
const COLORS = { Health: [46, 230, 140], Other: [250, 176, 40], Rust: [244, 67, 80] };
const NAMES = { Health: "Healthy", Other: "Other", Rust: "Rust (diseased)" };
const DEFAULT_VIEW = { longitude: ORIGIN.lng, latitude: ORIGIN.lat, zoom: 15 };
const cosLat = Math.cos((ORIGIN.lat * Math.PI) / 180);
const dLat = TILE_M / 111320, dLng = TILE_M / (111320 * cosLat);
const rgb = (c) => `rgb(${COLORS[c].join(",")})`;
const DEMO_ONLY = window.location.hostname.endsWith(".vercel.app"); // the hosted demo has no model server
const NAV = [["dashboard", "Dashboard", LayoutDashboard], ["map", "Field Monitor", MapPin], ["analysis", "Disease Analysis", Leaf], ["reports", "Reports", FileText], ["settings", "Settings", Settings]];

function buildTiles(r) {
  const out = [];
  for (let i = 0; i < r.grid_rows; i++)
    for (let j = 0; j < r.grid_cols; j++) {
      const w = ORIGIN.lng + j * dLng, s = ORIGIN.lat + (r.grid_rows - 1 - i) * dLat;
      out.push({ id: String.fromCharCode(65 + i) + (j + 1), row: i, col: j, label: r.classes[r.grid[i][j]], rust: r.rust_probability[i][j],
        conf: r.confidence ? r.confidence[i][j] : r.rust_probability[i][j], polygon: [[w, s], [w + dLng, s], [w + dLng, s + dLat], [w, s + dLat]] });
    }
  return out;
}
function buildView(r) {
  const width = Math.max(r.grid_cols, r.grid_rows) * TILE_M;
  return { longitude: ORIGIN.lng + (r.grid_cols * dLng) / 2, latitude: ORIGIN.lat + (r.grid_rows * dLat) / 2,
    zoom: Math.min(18, Math.log2((156543 * cosLat * 560) / width) - 0.8), pitch: 50, bearing: -15 };
}
function makeDates(n) { // demo dates over the dataset's flight window
  const a = Date.UTC(2018, 3, 25), b = Date.UTC(2018, 4, 18);
  return Array.from({ length: n }, (_, i) => new Date(n === 1 ? a : a + ((b - a) * i) / (n - 1)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }));
}
const SATELLITE = new TileLayer({
  id: "sat", data: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", minZoom: 0, maxZoom: 18, tileSize: 256,
  renderSubLayers: (p) => { const [[w, s], [e, n]] = p.tile.boundingBox; return new BitmapLayer(p, { data: null, image: p.data, bounds: [w, s, e, n] }); },
});
const pctOf = (r, c) => (r.counts[c] / (r.grid_rows * r.grid_cols)) * 100;

function Spark({ values, color }) {
  return (<LineChart width={96} height={34} data={values.map((v) => ({ v }))}><Line dataKey="v" dot={false} stroke={color} strokeWidth={2} isAnimationActive={false} /></LineChart>);
}
function Kpi({ Icon, label, value, delta, color, values }) {
  return (
    <div className="card kpi">
      <div className="kpiTop"><Icon size={26} color={color} /><Spark values={values.length > 1 ? values : [0, 0]} color={color} /></div>
      <b style={{ color }}>{value}</b><span>{label}</span>
      <small>{delta === null ? "\u00a0" : delta === 0 ? "no change" : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)} vs previous date`}</small>
    </div>
  );
}
function ZonePanel({ zone, selected }) {
  if (!zone) return <p className="muted">Upload images, then click a zone on the map.</p>;
  return (
    <div className="analysis">
      <svg width="116" height="116" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r="46" fill="none" stroke="#17323a" strokeWidth="9" />
        <circle cx="55" cy="55" r="46" fill="none" stroke={rgb(zone.label)} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${zone.conf * 289} 289`} transform="rotate(-90 55 55)" style={{ filter: `drop-shadow(0 0 6px ${rgb(zone.label)})` }} />
        <text x="55" y="53" textAnchor="middle" fill="#fff" fontSize="20" fontWeight="700">{(zone.conf * 100).toFixed(1)}%</text>
        <text x="55" y="70" textAnchor="middle" fill="#7fa3ad" fontSize="10">model confidence</text>
      </svg>
      <div>
        <small className="muted">Zone {zone.id} {selected ? "(selected)" : "(highest rust risk)"}</small>
        <div style={{ color: rgb(zone.label), fontSize: 22, fontWeight: 700 }}>{NAMES[zone.label]}</div>
        <small className="muted">Rust probability {(zone.rust * 100).toFixed(1)}%</small>
        <ul><li>Inspect this zone in the field</li><li>Compare it with neighbouring zones</li><li>Ask an agronomist about treatment</li></ul>
      </div>
    </div>
  );
}
function MapCard({ tiles, view, mode, setMode, picked, setPicked, zone, height, results, step, setStep, playing, setPlaying, dates }) {
  const layers = [SATELLITE, new PolygonLayer({
    id: "zones", data: tiles, getPolygon: (d) => d.polygon, pickable: true, wireframe: false, extruded: mode === "risk", filled: mode === "risk", stroked: true,
    getElevation: (d) => (d.label === "Rust" ? 10 + d.rust * 50 : 3), getLineColor: [255, 255, 255, mode === "risk" ? 120 : 200], lineWidthMinPixels: 1,
    getFillColor: (d) => [...COLORS[d.label], 200],
  })];
  return (
    <div className="card" id="map">
      <div className="mapHead"><h3><Satellite size={16} /> Field Map</h3>
        <div className="toggle"><button className={mode === "risk" ? "on" : ""} onClick={() => setMode("risk")}>Risk Map</button><button className={mode === "sat" ? "on" : ""} onClick={() => setMode("sat")}>Satellite</button></div>
      </div>
      <div className="map" style={{ height }}>
        <DeckGL initialViewState={view} controller={true} layers={layers} onClick={(i) => setPicked(i.object ? { id: i.object.id, x: i.x, y: i.y } : null)}
          getTooltip={({ object }) => object && { text: `Zone ${object.id}: ${NAMES[object.label]}\nRust probability: ${(object.rust * 100).toFixed(1)}%` }} />
        <div className="mapLegend">{["Health", "Other", "Rust"].map((c) => <div key={c}><i style={{ background: rgb(c) }} />{NAMES[c]}</div>)}</div>
        {picked && zone && picked.x !== undefined && (
          <div className="popup" style={{ left: Math.min(picked.x + 12, 360), top: Math.max(picked.y - 90, 8) }}>
            <b>Zone {zone.id}</b><div style={{ color: rgb(zone.label) }}>{NAMES[zone.label]}</div><small>Risk score {(zone.rust * 100).toFixed(0)} / 100</small>
          </div>
        )}
      </div>
      {results.length > 1 && (
        <div className="timeline"><button onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
          <input type="range" min={0} max={results.length - 1} value={step} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} /><b>{dates[step]} 2018</b></div>
      )}
    </div>
  );
}

export default function App() {
  const [results, setResults] = useState([]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("risk");
  const [picked, setPicked] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState(0);
  const [bell, setBell] = useState(false);
  const [name, setName] = useState("Anushka");
  const [notify, setNotify] = useState(true);
  const [demo, setDemo] = useState(false);
  const fileRef = useRef(null);

  const result = results[step] || null;
  const dates = useMemo(() => makeDates(results.length), [results.length]);
  const tiles = useMemo(() => (result ? buildTiles(result) : []), [result]);
  const view = useMemo(() => (results.length ? buildView(results[0]) : DEFAULT_VIEW), [results]);
  const total = result ? result.grid_rows * result.grid_cols : 0;
  const rp = result ? result.rust_percent : 0;
  const top = tiles.reduce((a, t) => (!a || t.rust > a.rust ? t : a), null);
  const zone = (picked && tiles.find((t) => t.id === picked.id)) || top;
  const delta = (c) => (step > 0 ? results[step].counts[c] - results[step - 1].counts[c] : null);
  const chartData = results.map((r, i) => ({ date: dates[i], Healthy: +pctOf(r, "Health").toFixed(1), Other: +pctOf(r, "Other").toFixed(1), Rust: +pctOf(r, "Rust").toFixed(1) })).slice(range ? -range : 0);
  const spark = (c) => results.map((r) => r.counts[c]);
  const alerts = tiles.filter((t) => t.label === "Rust" && t.rust >= 0.9).sort((a, b) => b.rust - a.rust).slice(0, 5);
  const status = rp < 10 ? ["Low rust risk", "Rust is limited to a few zones."] : rp < 30 ? ["Moderate rust risk", "Inspect the highlighted zones."] : ["High rust risk", "A large share of zones show rust."];
  const found = tiles.filter((t) => t.id.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.rust - a.rust);

  useEffect(() => { // show saved demo results on first open, if the site has them
    fetch("demo_results.json").then((r) => (r.ok ? r.json() : null)).then((d) => { if (Array.isArray(d) && d.length) { setResults(d); setDemo(true); } }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s >= results.length - 1 ? 0 : s + 1)), 1200);
    return () => clearInterval(id);
  }, [playing, results.length]);

  async function onFiles(e) {
    const files = Array.from(e.target.files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return;
    if (DEMO_ONLY) { setError("Live analysis is not available on this hosted demo. It runs on the local version."); return; }
    setError(null); setPlaying(false); setStep(0); setPicked(null);
    const out = [];
    try {
      for (let i = 0; i < files.length; i++) {
        setProgress({ i: i + 1, n: files.length });
        const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: files[i] });
        if (!res.ok) throw new Error(await res.text());
        out.push(await res.json());
      }
      setResults(out);
      setDemo(false);
    } catch (err) { setError(String(err.message || err)); } finally { setProgress(null); }
  }
  function downloadCsv(i) {
    const rows = ["zone,class,rust_probability,confidence", ...buildTiles(results[i]).map((t) => [t.id, t.label, t.rust, t.conf].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `terraspectra_${dates[i].replace(" ", "_")}.csv`;
    a.click();
  }
  const mapProps = { tiles, view, mode, setMode, picked, setPicked, zone, results, step, setStep, playing, setPlaying, dates };
  const Upload1 = (
    <label className="drop"><Upload size={22} /><b>{progress ? `Analysing ${progress.i} of ${progress.n}...` : "Upload hyperspectral images"}</b>
      <small>.tif files: 1 image, or several (one per date) for the timeline</small><input ref={fileRef} type="file" accept=".tif,.tiff" multiple onChange={onFiles} hidden />
      {progress && <div className="bar big"><i style={{ width: `${(progress.i / progress.n) * 100}%`, background: "#2ee6a6" }} /></div>}</label>
  );

  return (
    <div className="app">
      <style>{CSS}</style>
      <aside className="side">
        <div className="logo"><Sprout color="#2ee6a6" /><span>TerraSpectra</span></div>
        {NAV.map(([id, label, Icon]) => (<button key={id} className={page === id ? "nav on" : "nav"} onClick={() => setPage(id)}><Icon size={18} /><span>{label}</span></button>))}
        <div className="user"><div className="avatar">{name.slice(0, 1).toUpperCase()}</div><div><b>{name}</b><small>Analyst</small></div><LogOut size={16} title="Demo only" /></div>
      </aside>

      <main className="main">
        <header className="top">
          <div className="search"><Search size={16} /><input placeholder="Search zones (e.g. D8) or reports..." value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && query) setPage("map"); }} /></div>
          <div className="topRight">
            <div className="pill"><CalendarDays size={15} />
              <select value={range} onChange={(e) => setRange(Number(e.target.value))}><option value={0}>{results.length ? `${dates[0]} - ${dates[dates.length - 1]} 2018` : "No dates yet"}</option><option value={3}>Last 3 dates</option></select></div>
            <div className="bellWrap"><button className="iconBtn" onClick={() => setBell(!bell)}><Bell size={18} />{notify && alerts.length > 0 && <i className="dot" />}</button>
              {bell && (<div className="drop2"><b>Alerts</b>{notify && alerts.length ? alerts.map((t) => <div key={t.id} className="alertRow"><ShieldAlert size={14} color="#f44350" />Zone {t.id}: high rust risk ({(t.rust * 100).toFixed(0)}%)</div>) : <small className="muted">No alerts.</small>}</div>)}</div>
          </div>
        </header>

        {error && <div className="card err">Error: {error}</div>}
        {demo && <div className="card demoBar"><b>Demo data</b> saved from the model's analysis of 5 sample farm images (demo dates and location). {DEMO_ONLY ? "Live analysis of new images runs only on the local version." : "Upload your own images on the Disease Analysis page to analyse them live."}</div>}

        {page === "dashboard" && (<>
          <section className="hero">
            <div><h1>Terra<span>Spectra</span></h1><p>AI-Powered Crop Disease Forecasting<br />with Hyperspectral Intelligence</p><small>Monitor. Analyze. Protect.</small></div>
            <svg className="leaf" viewBox="0 0 120 120"><defs><filter id="g"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
              <path d="M60 10C90 25 105 55 60 105C15 55 30 25 60 10Z" fill="#2ee6a622" stroke="#2ee6a6" strokeWidth="2" filter="url(#g)" />
              <path d="M60 20V100M60 45L42 60M60 60L78 45M60 75L44 88" stroke="#22d3ee" strokeWidth="1.5" fill="none" filter="url(#g)" />
              <ellipse cx="60" cy="108" rx="34" ry="7" fill="none" stroke="#22d3ee" strokeWidth="1.5" filter="url(#g)" /></svg>
          </section>
          <section className="kpis">
            <Kpi Icon={Leaf} label="Total zones" value={result ? total : "-"} delta={null} color="#7ee8c6" values={spark("Health").map(() => total)} />
            <Kpi Icon={ShieldCheck} label="Healthy zones" value={result ? result.counts.Health : "-"} delta={delta("Health")} color={rgb("Health")} values={spark("Health")} />
            <Kpi Icon={ShieldAlert} label="Rust zones" value={result ? result.counts.Rust : "-"} delta={delta("Rust")} color={rgb("Rust")} values={spark("Rust")} />
            <Kpi Icon={Activity} label="Rust-risk area" value={result ? `${rp}%` : "-"} delta={null} color={rgb("Other")} values={results.map((r) => r.rust_percent)} />
          </section>
          <section className="row2">
            <div className="card"><h3><Activity size={16} /> Crop Health Overview</h3>
              {results.length ? (<ResponsiveContainer width="100%" height={260}><LineChart data={chartData} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#17323a" /><XAxis dataKey="date" stroke="#7fa3ad" fontSize={11} /><YAxis stroke="#7fa3ad" fontSize={11} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={{ background: "#071a22", border: "1px solid #1f4a45", borderRadius: 8 }} formatter={(v) => `${v}%`} />
                <Line type="monotone" dataKey="Healthy" stroke={rgb("Health")} strokeWidth={2.5} /><Line type="monotone" dataKey="Other" stroke={rgb("Other")} strokeWidth={2.5} /><Line type="monotone" dataKey="Rust" stroke={rgb("Rust")} strokeWidth={2.5} />
              </LineChart></ResponsiveContainer>) : <p className="muted">Upload images to see the trend.</p>}</div>
            <MapCard {...mapProps} height={300} />
          </section>
          <section className="row2">
            <div className="card"><h3><Leaf size={16} /> Disease Analysis</h3><ZonePanel zone={zone} selected={!!picked} /></div>
            <div className="card"><h3><Activity size={16} /> Recent Activity</h3>
              {results.length ? [...results.keys()].reverse().map((i) => (<div className="act" key={i}><span>{dates[i]}: rust-risk area {results[i].rust_percent}%</span><small>{i === step ? "viewing" : `${results[i].counts.Rust} rust zones`}</small></div>)) : <p className="muted">Nothing analysed yet.</p>}</div>
          </section>
        </>)}

        {page === "map" && (<section className="row2 wide"><MapCard {...mapProps} height={460} />
          <div className="card list"><h3><MapPin size={16} /> Zones {query && `matching "${query}"`}</h3>
            {found.length ? found.slice(0, 40).map((t) => (<div key={t.id} className={`zrow${zone && zone.id === t.id ? " sel" : ""}`} onClick={() => setPicked({ id: t.id })}>
              <i style={{ background: rgb(t.label) }} /><b>{t.id}</b><span>{NAMES[t.label]}</span><div className="bar"><i style={{ width: `${t.rust * 100}%`, background: rgb("Rust") }} /></div><small>{(t.rust * 100).toFixed(0)}%</small></div>)) : <p className="muted">No zones yet. Upload images on the Disease Analysis page.</p>}</div></section>)}

        {page === "analysis" && (<section className="row2">
          <div className="card"><h3><Upload size={16} /> Analyse images</h3>{Upload1}<p className="muted">Images are sent to the TerraSpectra API (3D-CNN + Vision Transformer). Each 64x64 tile is classified as Healthy, Other or Rust.</p></div>
          <div className="card"><h3><Leaf size={16} /> Result</h3><ZonePanel zone={zone} selected={!!picked} />
            {result && <div className="shares">{["Health", "Other", "Rust"].map((c) => (<div key={c}><span>{NAMES[c]}</span><div className="bar"><i style={{ width: `${pctOf(result, c)}%`, background: rgb(c) }} /></div><b>{pctOf(result, c).toFixed(0)}%</b></div>))}</div>}</div></section>)}

        {page === "reports" && (<div className="card"><h3><FileText size={16} /> Analysis reports (this session)</h3>
          {results.length ? [...results.keys()].filter((i) => dates[i].toLowerCase().includes(query.toLowerCase())).map((i) => (
            <div className="act" key={i}><span>Scan {dates[i]} 2018: {results[i].grid_rows * results[i].grid_cols} zones, rust-risk area {results[i].rust_percent}%</span>
              <button className="mini" onClick={() => downloadCsv(i)}><Download size={13} /> CSV</button></div>)) : <p className="muted">No reports yet. Reports appear after you analyse images. PDF export is not built yet.</p>}</div>)}

        {page === "settings" && (<div className="card narrow"><h3><Settings size={16} /> Settings</h3>
          <label className="field">Display name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field row"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Show high-risk alerts in the bell menu</label>
          <small className="muted">Settings are kept only while this page is open (demo).</small></div>)}
      </main>

      <aside className="right">
        <div className="card status"><div className="big">{result ? <Sprout size={44} color="#2ee6a6" /> : <Satellite size={44} color="#22d3ee" />}</div><b>{result ? status[0] : "Ready"}</b><small>{result ? status[1] : "Upload hyperspectral images to begin."}</small></div>
        <h3>Quick Actions</h3>
        <button className="act1" onClick={() => { setPage("analysis"); }}><Upload size={16} /> Upload images</button>
        <button className="act2" onClick={() => setPage("reports")}><FileText size={16} /> View reports</button>
        <button className="act2" onClick={() => setPage("map")}><MapPin size={16} /> Explore map</button>
        <button className="act2" disabled={!result} onClick={() => downloadCsv(step)}><Download size={16} /> Download report (CSV)</button>
        <div className="card powered"><Satellite size={18} color="#22d3ee" /> Powered by Hyperspectral AI</div>
        <div className="card model"><b>Model</b> 3D-CNN + Vision Transformer, 71.7% accuracy on 120 held-out patches (Health 60%, Other 85%, Rust 70%), so some zones are misclassified. Farm location and dates are demo values.</div>
      </aside>
    </div>
  );
}

const CSS = `
html,body{background:#050d14;overflow-x:hidden;margin:0}
*{box-sizing:border-box}button{font-family:inherit}
.app{display:grid;grid-template-columns:200px 1fr 250px;min-height:100vh;background:radial-gradient(circle at 25% 0,#0b2a33 0,#050d14 55%);color:#e3f4f1;font-family:system-ui,sans-serif}
.side{padding:18px 12px;background:#050f15;border-right:1px solid #11313a;display:flex;flex-direction:column;gap:6px;position:sticky;top:0;height:100vh}
.logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px;margin-bottom:18px}
.nav{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;color:#8fb2ba;background:none;border:0;cursor:pointer;font-size:14px;text-align:left;transition:.2s}
.nav:hover{background:#0d2630;color:#fff}.nav.on{background:linear-gradient(90deg,#14c98a,#0e9c8f);color:#032;font-weight:600;box-shadow:0 0 16px #2ee6a655}
.user{margin-top:auto;display:flex;align-items:center;gap:10px;font-size:13px}.user small{display:block;color:#7fa3ad}.avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#2ee6a6,#22d3ee);color:#032;display:grid;place-items:center;font-weight:700}
.main{padding:16px 18px;display:flex;flex-direction:column;gap:14px;min-width:0}
.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.search{display:flex;align-items:center;gap:8px;flex:1;max-width:460px;background:#0a1d25;border:1px solid #17404a;border-radius:12px;padding:8px 12px;color:#7fa3ad}
.search input{flex:1;background:none;border:0;outline:0;color:#e3f4f1;font-size:14px}.topRight{display:flex;gap:10px;align-items:center}
.pill{display:flex;align-items:center;gap:8px;background:#0a1d25;border:1px solid #17404a;border-radius:20px;padding:6px 12px;font-size:13px}.pill select{background:none;border:0;color:#e3f4f1;outline:0}.pill option{background:#0a1d25}
.iconBtn{position:relative;background:#0a1d25;border:1px solid #17404a;border-radius:50%;width:38px;height:38px;display:grid;place-items:center;color:#e3f4f1;cursor:pointer}.dot{position:absolute;top:7px;right:8px;width:8px;height:8px;border-radius:50%;background:#f44350}
.bellWrap{position:relative}.drop2{position:absolute;right:0;top:46px;width:260px;background:#08202a;border:1px solid #1f4a55;border-radius:12px;padding:12px;z-index:10;display:flex;flex-direction:column;gap:8px;font-size:13px}.alertRow{display:flex;gap:8px;align-items:center}
.hero{display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-radius:18px;background:linear-gradient(120deg,#0c3b3a,#08202a 55%,#0d3d4a);border:1px solid #1b5a5a;overflow:hidden}
.hero h1{margin:0;font-size:40px}.hero h1 span{color:#2ee6a6}.hero p{margin:6px 0;font-weight:600}.hero small{color:#2ee6a6}.leaf{width:130px;height:130px;animation:float 5s ease-in-out infinite}
@keyframes float{50%{transform:translateY(-8px)}}
.card{background:#0a1d25b3;backdrop-filter:blur(10px);border:1px solid #1a4650;border-radius:16px;padding:14px;transition:.25s}.card:hover{border-color:#2ee6a655;box-shadow:0 0 18px #2ee6a61f}
.card h3{margin:0 0 8px;font-size:15px;display:flex;align-items:center;gap:6px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.kpi{display:flex;flex-direction:column}.kpiTop{display:flex;justify-content:space-between;align-items:center}
.kpi b{font-size:28px}.kpi span{font-size:13px;color:#b5d4d6}.kpi small{color:#7fa3ad;font-size:11px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.row2.wide{grid-template-columns:1.5fr 1fr}.muted{color:#7fa3ad;font-size:13px}
.mapHead{display:flex;justify-content:space-between;align-items:center}.toggle{display:flex;background:#071820;border-radius:18px;padding:3px}
.toggle button{background:none;border:0;color:#8fb2ba;padding:5px 12px;border-radius:14px;cursor:pointer}.toggle .on{background:#2ee6a6;color:#032;font-weight:600}
.map{position:relative;border-radius:12px;overflow:hidden;margin-top:6px}.mapLegend{position:absolute;left:8px;bottom:8px;background:#050d14cc;padding:8px 10px;border-radius:8px;font-size:12px;pointer-events:none}
.mapLegend i,.zrow>i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.popup{position:absolute;background:#08202a;border:1px solid #2ee6a666;border-radius:10px;padding:8px 12px;font-size:13px;pointer-events:none;box-shadow:0 0 14px #2ee6a644}
.timeline{display:flex;align-items:center;gap:10px;margin-top:8px}.timeline input{flex:1}.timeline button,.mini{cursor:pointer;border-radius:8px;border:1px solid #1f4a55;background:#0d2630;color:#e3f4f1;padding:4px 10px}
.analysis{display:flex;gap:16px;align-items:center}.analysis ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:#b5d4d6}
.act{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #12303a;font-size:13px}.act small{color:#7fa3ad}
.drop{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed #2ee6a655;border-radius:14px;padding:26px;cursor:pointer;text-align:center;transition:.2s}.drop:hover{background:#2ee6a60f}.drop small{color:#7fa3ad}
.bar{height:8px;background:#17323a;border-radius:4px;flex:1}.bar i{display:block;height:8px;border-radius:4px}.bar.big{width:100%;margin-top:8px}
.shares{margin-top:14px}.shares>div{display:grid;grid-template-columns:110px 1fr 40px;gap:8px;align-items:center;font-size:12px;margin-top:8px}
.list{max-height:540px;overflow-y:auto}.zrow{display:grid;grid-template-columns:16px 34px 1fr 90px 36px;gap:6px;align-items:center;padding:7px 6px;border-radius:8px;cursor:pointer;font-size:13px}.zrow:hover,.zrow.sel{background:#12303a}
.field{display:flex;flex-direction:column;gap:6px;margin:12px 0;font-size:13px}.field.row{flex-direction:row;align-items:center}.field input:not([type=checkbox]){background:#071820;border:1px solid #17404a;border-radius:8px;padding:8px;color:#e3f4f1}.narrow{max-width:480px}
.err{color:#ff8a80;border-color:#ff8a8066}.demoBar{font-size:13px;color:#b5d4d6;border-color:#22d3ee66;padding:10px 14px}.demoBar b{color:#22d3ee}
.right{padding:16px 14px;display:flex;flex-direction:column;gap:10px}.right h3{margin:6px 0 0;font-size:15px}.status{text-align:center;display:flex;flex-direction:column;gap:4px;align-items:center}.status small{color:#9bbfc4}
.act1,.act2{display:flex;align-items:center;gap:8px;border-radius:12px;padding:11px;font-size:14px;cursor:pointer;border:1px solid #1f4a55;transition:.2s}
.act1{background:linear-gradient(90deg,#2ee6a6,#22d3ee);color:#032;font-weight:700}.act1:hover{box-shadow:0 0 16px #2ee6a688}.act2{background:#0a1d25;color:#e3f4f1}.act2:hover{background:#12303a}.act2:disabled{opacity:.4;cursor:default}
.powered{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}.model{font-size:12px;color:#9bbfc4;line-height:1.5}.model b{color:#e3f4f1}
@media(max-width:1150px){.app{grid-template-columns:64px 1fr}.right{grid-column:2}.nav span,.logo span,.user div,.user svg:last-child{display:none}.kpis{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){.app{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;overflow-x:auto}.user{display:none}.right{grid-column:1}.row2,.row2.wide{grid-template-columns:1fr}.top{flex-direction:column;align-items:stretch}.hero .leaf{display:none}}
`;
