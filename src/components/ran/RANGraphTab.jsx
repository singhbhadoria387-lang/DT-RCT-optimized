import { useEffect, useRef, useState } from 'react';
import { DataSet, Network } from 'vis-network/standalone';
import ResultsTable from '../ResultsTable';
import { loadRANTelemetry, loadRANTargetComparison, RAN_GRAPHDB, RAN_VISUAL_CONFIG_QUERIES } from '../../ranGraphdbApi';

export default function RANGraphTab({ active, graph, graphState = 'current', onStateChange, loading, error, onRefresh }) {
  const mountRef = useRef(null);
  const networkRef = useRef(null);
  const [telemetry, setTelemetry] = useState({ latest: [], metrics: [] });
  const [telemetryError, setTelemetryError] = useState('');
  const [comparison, setComparison] = useState([]);
  const [comparisonError, setComparisonError] = useState('');
  const [visualQueryIndex, setVisualQueryIndex] = useState(0);
  const [focusNode, setFocusNode] = useState('');

  useEffect(() => {
    if (!active || !mountRef.current || !graph) return undefined;
    const nodes = new DataSet(graph.nodes.map((n) => {
      const type = String(n.type || '').toLowerCase();
      const visual = type === 'site' ? { shape: 'box', color: { background: '#dbeafe', border: '#2563eb' } }
        : type.includes('host') ? { shape: 'database', color: { background: '#dcfce7', border: '#16a34a' } }
          : type === 'ocu' ? { shape: 'ellipse', color: { background: '#fef3c7', border: '#d97706' } }
            : type === 'o_du' ? { shape: 'dot', color: { background: '#ede9fe', border: '#7c3aed' } }
              : { shape: 'dot', color: { background: '#e7f0ff', border: '#4f6fc4' } };
      return { ...n, ...visual, size: type === 'o_du' ? 23 : type.includes('host') ? 22 : 18, font: { color: '#25304a', size: 12, face: 'Arial' } };
    }));
    const edges = new DataSet(graph.edges);
    networkRef.current?.destroy();
    networkRef.current = new Network(
      mountRef.current,
      { nodes, edges },
      {
        autoResize: true,

        physics: {
          enabled: true,
          stabilization: {
            enabled: true,
            iterations: 100,
            updateInterval: 25,
            fit: true
          },
          barnesHut: {
            gravitationalConstant: -3000,
            centralGravity: 0.3,
            springLength: 120,
            springConstant: 0.04,
            damping: 0.15
          }
        },

        interaction: {
          hover: true,
          navigationButtons: true,
          keyboard: true,
          hideEdgesOnDrag: true,
          hideNodesOnDrag: false
        },

        edges: {
          color: {
            color: '#94a3b8',
            highlight: '#2563eb'
          },
          font: {
            size: 10,
            color: '#64748b',
            align: 'middle'
          },
          smooth: false
        },

        nodes: {
          borderWidth: 1,
          font: {
            size: 12,
            face: 'Arial'
          }
        }
      }
    );

    // Stop physics once the initial graph has settled.
    networkRef.current.once('stabilizationIterationsDone', () => {
      networkRef.current?.setOptions({
        physics: false
      });
    });
    // networkRef.current = new Network(mountRef.current, { nodes, edges }, {
    //   autoResize: true, 
    //   physics: { 
    //     stabilization: { iterations: 180 }, 
    //     barnesHut: { gravitationalConstant: -4500,
    //        springLength: 130 
    //       } 
    //     },
    //   interaction: { hover: true, navigationButtons: true, keyboard: true },
    //   edges: { color: { color: '#94a3b8', highlight: '#2563eb' }, font: { size: 10, color: '#64748b', align: 'middle' }, smooth: { type: 'dynamic' } },
    //   nodes: { borderWidth: 1, color: { background: '#e7f0ff', border: '#4f6fc4', highlight: { background: '#dbeafe', border: '#1d4ed8' } } },
    // });
    return () => { networkRef.current?.destroy(); networkRef.current = null; };
  }, [graph, active]);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const refresh = async () => {
      try { const data = await loadRANTelemetry(); if (alive) { setTelemetry(data); setTelemetryError(''); } }
      catch (e) { if (alive) setTelemetryError(e.message); }
    };
    refresh(); const timer = setInterval(refresh, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);

  useEffect(() => {
    if (!active || graphState !== 'target') return undefined;
    let alive = true;
    loadRANTargetComparison().then((rows) => { if (alive) { setComparison(rows); setComparisonError(''); } })
      .catch((e) => { if (alive) setComparisonError(e.message); });
    return () => { alive = false; };
  }, [active, graphState, graph]);

  const fmt = (value) => value == null ? '—' : Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : value;
  const isTarget = graphState === 'target';
  useEffect(() => { if (focusNode && graph && !graph.nodes.some((node) => node.id === focusNode)) setFocusNode(''); }, [graph, focusNode]);
  return (
    <section className={`tab ${active ? 'active' : ''}`}>
      <div className="page-title">RAN Ontology Graph</div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex justify-between items-center flex-wrap gap-3">
          <div><h3>{isTarget ? 'Target RAN topology' : 'Current RAN topology'}</h3><div className="sub">RDF topology from GraphDB repository <b>{RAN_GRAPHDB.repository}</b> · {isTarget ? RAN_GRAPHDB.targetGraph : RAN_GRAPHDB.currentGraph}</div></div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className={`btn ${!isTarget ? 'blue' : ''}`} onClick={() => onStateChange?.('current')} disabled={loading || !isTarget}>Current state</button>
            <button className={`btn ${isTarget ? 'blue' : ''}`} onClick={() => onStateChange?.('target')} disabled={loading || isTarget}>Target state</button>
            <button className="btn blue" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh graph'}</button>
          </div>
        </div>
        {error && <p className="note" style={{ color: '#c0392b', marginTop: 10 }}>{error}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <div className="stat"><div className="v">{graph?.nodes?.length ?? '—'}</div><div className="l">Entities</div></div>
          <div className="stat"><div className="v">{graph?.edges?.length ?? '—'}</div><div className="l">Relationships</div></div>
          <div className="stat"><div className="v">{graph?.duMetrics?.length ?? '—'}</div><div className="l">Distributed Units</div></div>
          <div className="stat"><div className="v">{graph?.cells?.length ?? '—'}</div><div className="l">Cells</div></div>
          <div className="stat"><div className="v">{fmt(graph?.tripleCount)}</div><div className="l">RDF triples</div></div>
        </div>
        <div className="flex items-center flex-wrap gap-2" style={{ marginTop: 12 }}>
          <label className="sub" htmlFor="ran-start-node">Starting point</label>
          <select id="ran-start-node" className="input" style={{ minWidth: 260, maxWidth: 520 }} value={focusNode} onChange={(e) => setFocusNode(e.target.value)}>
            <option value="">Select a Site / Host / O-CU / O-DU</option>
            {(graph?.nodes || []).map((node) => <option key={node.id} value={node.id}>{node.label} · {node.type || 'Related resource'}</option>)}
          </select>
          <button className="btn blue" disabled={!focusNode || !networkRef.current} onClick={() => networkRef.current?.focus(focusNode, { scale: 1.25, animation: { duration: 650, easingFunction: 'easeInOutQuad' } })}>Focus node</button>
        </div>
      </div>
      {/*<div className="card" style={{ marginBottom: 14 }}>
        <div className="flex justify-between items-center flex-wrap gap-2"><h3>GraphDB visual graph configuration</h3><span className="sub">GraphDB repository: {RAN_GRAPHDB.repository}</span></div>
        <div className="flex flex-wrap gap-2" style={{ margin: '10px 0' }}>
          {RAN_VISUAL_CONFIG_QUERIES(graphState).map((item, index) => <button key={item.key} className={`btn ${visualQueryIndex === index ? 'blue' : ''}`} onClick={() => setVisualQueryIndex(index)}>{item.label}</button>)}
        </div>
        <div className="sub" style={{ marginBottom: 7 }}>{RAN_VISUAL_CONFIG_QUERIES(graphState)[visualQueryIndex]?.description}</div>
        <pre className="gqlbox" style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{RAN_VISUAL_CONFIG_QUERIES(graphState)[visualQueryIndex]?.query}</pre>
        <div className="sub">These rules are executed against the selected <b>{graphState.toUpperCase()}</b> named graph. Starting point types and expansion predicates follow the GraphDB Visual Graph configuration you supplied.</div>
      </div>*/}
      <div className="card" style={{ marginBottom: 14 }}>
        <div ref={mountRef} style={{ height: 480, width: '100%', background: '#fbfcff', border: '1px solid #e4e8f0', borderRadius: 10 }} />
        {graph && graph.nodes.length === 0 && !error && <p className="note" style={{ marginTop: 8 }}>No Site, O-Cloud Host, O-Cloud DU Host, O-CU or O-DU nodes were found. Confirm that this repository contains the selected named graph and that its rdf:type values use the configured RAN ontology classes.</p>}
        <div className="note" style={{ marginTop: 8 }}>Use the mouse wheel to zoom, drag to pan, and select a node to inspect its connections. Target state appears after a successful what-if execution.</div>
      </div>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1, minWidth: 320 }}><h3>DU inventory</h3><ResultsTable columns={['DU', 'CPU %', 'Host', 'Site']} rows={(graph?.duMetrics || []).map((x) => [x.du.split('/').pop(), fmt(x.cpu), x.host?.split('/').pop() || '—', x.site?.split('/').pop() || '—'])} /></div>
        <div className="card" style={{ flex: 1, minWidth: 320 }}><h3>Cell inventory</h3><ResultsTable columns={['Cell', 'Load %', 'Active users', 'HO failure', 'Throughput Mbps']} rows={(graph?.cells || []).map((x) => [x.name, fmt(x.load), fmt(x.users), fmt(x.handoverFailure), fmt(x.throughput)])} /></div>
      </div>
      {isTarget && <div className="card" style={{ marginTop: 14 }}>
        <h3>Current vs Target KPI comparison</h3>
        <div className="sub">Uses the same target-view logic installed by graphdb_whatif.py: newest Current observation compared with projected Target predicate.</div>
        {comparisonError && <p className="note" style={{ color: '#c0392b' }}>{comparisonError}</p>}
        <ResultsTable columns={['Element', 'Metric', 'Current', 'Target', 'Change']} rows={comparison.map((x) => [x.element.split('/').pop(), x.metric, fmt(x.current), fmt(x.target), fmt(x.change)])} />
      </div>}
      {!isTarget && <div className="card" style={{ marginTop: 14 }}>
        <h3>Live telemetry feed</h3><div className="sub">Newest observation per entity and metric from the Current graph, refreshed every 10 seconds.</div>
        {telemetryError && <p className="note" style={{ color: '#c0392b' }}>{telemetryError}</p>}
        <div className="row" style={{ margin: '10px 0' }}>{telemetry.metrics.map((m) => <div className="stat" key={m.metric}><div className="v">{m.readings}</div><div className="l">{m.metric} · {m.entities} entities</div></div>)}</div>
        <ResultsTable columns={['Entity', 'Metric', 'Value', 'Observed at']} rows={telemetry.latest.slice(0, 25).map((x) => [x.entity.split('/').pop(), x.metric, fmt(x.value), x.observedAt])} />
      </div>}
    </section>
  );
}
