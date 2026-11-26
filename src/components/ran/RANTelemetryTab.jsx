import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Wifi } from 'lucide-react';
import { loadRANSiteIngestion, loadRANSiteScenario, RAN_GRAPHDB } from '../../ranGraphdbApi';

const DEFAULT_THRESHOLD = 85;
const fmt = (value, digits = 1) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const local = (value = '') => String(value).split(/[/#:]/).filter(Boolean).pop() || String(value);

export default function RANTelemetryTab({ active, onSiteScenarioChange }) {
  const [data, setData] = useState({ sites: [], clusters: [], readings: [], head: null, threshold: DEFAULT_THRESHOLD });
  const [site, setSite] = useState('');
  const [demand, setDemand] = useState(4);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [siteScenario, setSiteScenario] = useState(null);
  const [siteScenarioLoading, setSiteScenarioLoading] = useState(false);
  const [siteScenarioError, setSiteScenarioError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const next = await loadRANSiteIngestion();
      setData(next);
      setSite((old) => next.sites.some((x) => x.id === old) ? old : (next.sites[0]?.id || ''));
    } catch (e) { setError(e.message || 'Unable to load RAN site telemetry.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!active || !site) return undefined;
    let alive = true;
    setSiteScenario(null);
    onSiteScenarioChange?.(null);
    setSiteScenarioError('');
    setSiteScenarioLoading(true);
    loadRANSiteScenario(local(site), demand).then((result) => {
      if (!alive) return;
      const nextScenario = { siteId: local(site), payload: result };
      setSiteScenario(nextScenario);
      onSiteScenarioChange?.(nextScenario);
      if (result?.demandMbps != null && Number.isFinite(Number(result.demandMbps))) setDemand(Number(result.demandMbps));
    }).catch((e) => {
      if (alive) setSiteScenarioError(e.message || 'Unable to load the selected site.');
    }).finally(() => {
      if (alive) setSiteScenarioLoading(false);
    });
    return () => { alive = false; };
  }, [active, site, demand, onSiteScenarioChange]);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 20000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const selected = useMemo(() => data.sites.find((x) => x.id === site) || null, [data.sites, site]);
  const clusters = useMemo(() => data.clusters.filter((x) => x.site === site), [data.clusters, site]);
  const currentScenario = siteScenario?.siteId === local(site) ? siteScenario.payload : null;
  const scenarioClusters = useMemo(() => (currentScenario?.clusters || []).map((cluster) => ({
    id: cluster.id,
    site,
    label: cluster.label ?? cluster.id,
    duCount: cluster.duCount ?? cluster.dus?.length ?? 0,
    host: cluster.server ?? null,
    duCpu: cluster.duCpuPct ?? null,
    duPrb: cluster.duPrbDlPct ?? null,
    cuCpu: cluster.cuCpuPct ?? null,
    coresUsedPct: cluster.serverCoresUsedPct ?? null,
    status: cluster.status || 'NO DATA',
    dus: cluster.dus || [],
  })), [currentScenario, site]);
  const displayedClusters = currentScenario ? scenarioClusters : clusters;
  const peakCpu = currentScenario?.cards?.peakDuCpuPct ?? selected?.peakCpu ?? null;
  const connectedUsers = currentScenario?.connectedUEs ?? selected?.users ?? null;
  const perUe = currentScenario?.baselineDemandMbps ?? selected?.perUeMbps ?? null;
  const threshold = currentScenario ? DEFAULT_THRESHOLD : data.threshold || DEFAULT_THRESHOLD;
  const status = currentScenario?.cards?.status || (peakCpu == null ? 'NO DATA' : peakCpu >= threshold ? 'OVERLOAD' : peakCpu < 30 ? 'UNDER-LOAD' : 'NORMAL');
  const statusColor = status === 'OVERLOAD' ? '#dc2626' : status === 'UNDER-LOAD' || status === 'NO DATA' ? '#d97706' : '#16a34a';
  const capacity = currentScenario?.dlCapacityPerDuMbps ?? selected?.dlCapacityMbps ?? null;
  const sliderMin = currentScenario?.slider?.min ?? 0;
  const sliderMax = currentScenario?.slider?.max ?? 20;
  const sliderStep = currentScenario?.slider?.step ?? 0.1;
  const underloadMbps = currentScenario?.thresholds?.underloadMbps;
  const overloadMbps = currentScenario?.thresholds?.overloadMbps;
  const demandStatus = underloadMbps != null && demand < underloadMbps
    ? 'Below the underload demand threshold'
    : overloadMbps != null && demand > overloadMbps
      ? 'Above the overload demand threshold'
      : demand > 12 ? 'High demand scenario' : 'Normal demand scenario';

  return (
    <section className={`tab ${active ? 'active' : ''}`}>
      <div className="page-title">GraphDB Operations Console</div>
      <div className="ran-ingest-heading">
        <div><div className="ran-eyebrow">NETWORK INTELLIGENCE / RAN</div><div className="ran-subtitle">Explore your RAN topology, drive CU / DU traffic demand per site, and review the what-if scaling plan.</div></div>
        <div className="ran-connection"><span /> GraphDB connected · {RAN_GRAPHDB.repository}</div>
      </div>
      <div className="ran-section-title"><Activity size={17}/> Traffic ingestion</div>

      <div className="card ran-demand-card">
        <div className="ran-card-top">
          <h3>Simulate per-UE traffic demand</h3>
          <label className="ran-site-select">Site
            <select value={site} onChange={(e) => setSite(e.target.value)} disabled={!data.sites.length}>
              {data.sites.length ? data.sites.map((x) => <option key={x.id} value={x.id}>{x.label}</option>) : <option value="">No sites found</option>}
            </select>
          </label>
        </div>
        <p className="ran-description">Adjust the per-UE downlink demand for every DU at the selected site. DU or CU CPU crossing {fmt(threshold, 0)}% indicates an overload condition; values below 30% indicate under-load. Use the What-If page to evaluate a scaling or traffic-steering plan. This slider is a scenario input and does not overwrite live GraphDB telemetry.</p>
        <p className="ran-baseline">Real current baseline: <b>{fmt(perUe)} Mbps per UE</b> · <b>{fmt(connectedUsers, 0)}</b> connected UEs on {selected?.label || 'the selected site'}.</p>
        <div className="ran-ingest-grid">
          <div className="ran-slider-area">
            <div className="ran-slider-value"><b>{fmt(demand)} Mbps</b><span>Scenario demand per UE</span></div>
            <input aria-label="Per UE traffic demand" type="range" min={sliderMin} max={sliderMax} step={sliderStep} value={demand} onChange={(e) => setDemand(Number(e.target.value))} />
            <div className="ran-slider-scale"><span>{fmt(sliderMin)}</span><span>{underloadMbps == null ? 'Under-load' : `Under-load: ${fmt(underloadMbps)} Mbps`}</span><span>{overloadMbps == null ? 'Overload' : `Overload: ${fmt(overloadMbps)} Mbps`}</span><span>{fmt(sliderMax)} Mbps</span></div>
            <div className="ran-zone-labels"><span>Under-load zone</span><span>Normal zone</span><span>Overload zone</span></div>
            <div className="ran-demand-note">{demandStatus} · Use this value when configuring your What-If scenario.</div>
          </div>
          <div className="ran-kpi-grid">
            <div className="ran-kpi green"><strong>{fmt(perUe)}</strong><span>Mbps per UE</span></div>
            <div className="ran-kpi navy"><strong>{fmt(capacity, 0)}</strong><span>Mbps DL capacity per DU</span></div>
            <div className="ran-kpi" style={{ background: statusColor }}><strong>{status}</strong><span>Site status</span></div>
            <div className={`ran-kpi ${peakCpu != null && peakCpu >= threshold ? 'red' : 'green'}`}><strong>{peakCpu == null ? '—' : `${fmt(peakCpu)}%`}</strong><span>Peak DU CPU (threshold {fmt(threshold, 0)}%)</span></div>
          </div>
        </div>
        {error && <p className="ran-error">{error}</p>}
        {siteScenarioError && <p className="ran-error">Site load failed: {siteScenarioError}</p>}
      </div>

      <div className="card ran-cluster-card">
        <div className="ran-cluster-heading"><div><h3>{selected?.label || 'Selected site'} · CU clusters</h3><p className="ran-muted">{currentScenario ? 'Cluster utilization returned for the selected site.' : 'CU and DU utilization based on the newest observations in the Current named graph.'}</p></div><button className="btn blue" onClick={refresh} disabled={loading}><RefreshCw size={14} className={loading ? 'ran-spin' : ''}/> {loading ? 'Refreshing…' : 'Refresh'}</button></div>
        <div className="ran-table-wrap">
          <table className="ran-table">
            <thead>
              <tr>
                <th style={{color:"white"}}>CU CLUSTER</th>
                <th style={{color:"white"}}>DUs</th>
                <th style={{color:"white"}}>DU CPU (each)</th>
                <th style={{color:"white"}}>DU PRB DL</th>
                <th style={{color:"white"}}>CU CPU</th>
                <th style={{color:"white"}}>Server cores used</th>
                <th style={{color:"white"}}>Status</th>
              </tr>
            </thead>
          <tbody>{displayedClusters.length ? displayedClusters.map((row) => <tr key={row.id}><td><b>{row.label}</b></td><td>{row.duCount} · {row.host || 'host n/a'}</td><td>{row.dus?.length ? row.dus.map((du) => <div key={du.id}>{du.id}: {fmt(du.cpuPct)}% CPU · {fmt(du.prbDlPct)}% PRB · {du.status}</div>) : `${fmt(row.duCpu)}%`}</td><td>{fmt(row.duPrb)}%</td><td>{fmt(row.cuCpu)}%</td><td>{row.coresUsedPct != null ? `${fmt(row.coresUsedPct)}%` : row.coresUsed == null ? '—' : `${fmt(row.coresUsed, 0)}${row.totalCores == null ? '' : ` of ${fmt(row.totalCores, 0)}`}`}</td><td><span className={`ran-status ${row.status === 'OVERLOAD' ? 'overload' : row.status === 'NO DATA' ? 'nodata' : 'normal'}`}>{row.status}</span></td></tr>) : <tr><td colSpan="7" className="ran-empty">{siteScenarioLoading || loading ? 'Loading site topology and telemetry…' : siteScenarioError ? 'Site cluster data could not be loaded.' : 'No CU clusters found for this site in the Current graph.'}</td></tr>}</tbody>
        </table></div>
      </div>
      <div className="ran-ingest-footer"><span>GraphDB repository: <b>{RAN_GRAPHDB.repository}</b> · Current graph: <code>{RAN_GRAPHDB.currentGraph}</code></span><span><Wifi size={13}/> Auto-refresh: every 20 seconds · {data.head ? `Latest: ${new Date(data.head).toLocaleTimeString()}` : 'Waiting for telemetry'}</span></div>
    </section>
  );
}
