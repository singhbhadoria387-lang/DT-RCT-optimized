// RAN-only GraphDB integration. This endpoint is proxied by Vite to 10.161.4.199;
// Core and Transport continue using their existing local GraphDB proxies on 10.161.4.175.
const REPOSITORY = import.meta.env.VITE_GRAPHDB_RAN_REPOSITORY || 'Traffic_Steering';
const ROOT = `/ran-graphdb/repositories/${encodeURIComponent(REPOSITORY)}`;
const GRAPHDB_REQUEST_TIMEOUT_MS = 30_000;
const RAN_NS = 'http://example.com/ran-dt/';
const CURRENT_GRAPH = import.meta.env.VITE_GRAPHDB_RAN_CURRENT_GRAPH || `${RAN_NS}graph/current`;
const TARGET_GRAPH = import.meta.env.VITE_GRAPHDB_RAN_TARGET_GRAPH || `${RAN_NS}graph/target`;
const OBS_PREFIX = `${RAN_NS}obs/`;
const PREFIX = `PREFIX ran: <${RAN_NS}>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n`;
const NODE_TYPES = ['Site', 'OCloudHost', 'OCloudDUHost', 'OCU', 'O_DU'];
const EDGE_PREDICATES = ['locatedAt', 'hostedOn', 'containsNode', 'connectsToCUCP'];
const typeValues = NODE_TYPES.map((x) => `ran:${x}`).join(', ');
const edgeValues = EDGE_PREDICATES.map((x) => `ran:${x}`).join(', ');

const RAN_GRAPH_LIMITS={
  RDF_TRIPLES: 300,
  STARTING_NODES: 40,
  RELATIONSHIPS: 100,
  NODE_PROPERTIES: 80,
  CELLS: 50,
  TELEMETRY_ROWS: 200,
}

export const RAN_GRAPHDB = {
  repository: REPOSITORY,
  host: '10.161.4.199',
  currentGraph: CURRENT_GRAPH,
  targetGraph: TARGET_GRAPH,
};

export async function runRANSparql(query) {
  let response;
  let body;
  const signal = AbortSignal.timeout(GRAPHDB_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(ROOT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/sparql-results+json, application/json;q=0.9',
      },
      body: new URLSearchParams({ query }).toString(),
      signal,
    });
    body = await response.text();
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`RAN GraphDB query timed out after ${GRAPHDB_REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  }
  if (!response.ok) throw new Error(`RAN GraphDB (${REPOSITORY}) HTTP ${response.status}: ${body.slice(0, 600)}`);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`GraphDB did not return SPARQL JSON: ${body.slice(0, 300)}`); }
  if (!Array.isArray(data?.results?.bindings)) throw new Error('Unexpected GraphDB response. Check repository, query and GraphDB permissions.');
  return data.results.bindings;
}

export async function loadRANSiteScenario(site, demandMbps) {
  const siteId = String(site).replace(/^Site/, '');
  const response = await fetch(`/ran-api/api/sites/${encodeURIComponent(siteId)}/load`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ demandMbps: Number(demandMbps) }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`RAN site load HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  let result;
  try { result = JSON.parse(body); } catch {
    throw new Error(`RAN site load returned invalid JSON: ${body.slice(0, 300)}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('RAN site load returned an unexpected response shape.');
  }
  return result;
}

const localName = (iri = '') => String(iri).split(/[/#:]/).filter(Boolean).pop() || String(iri);
const numeric = (value) => value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : value);
const graphTriplesQuery = (graphIri) => `${PREFIX}
# Starting point data source: Query 1 (CONSTRUCT expressed as SELECT for the browser)
SELECT ?s ?p ?o WHERE {
  GRAPH <${graphIri}> {
    ?s ?p ?o .
    FILTER(!STRSTARTS(STR(?s), "${OBS_PREFIX}"))
  }
} ORDER BY ?s ?p ?o
 LIMIT ${RAN_GRAPH_LIMITS.RDF_TRIPLES}`;

// Starting point tab: the RAN classes configured in GraphDB Visual Graph.
const startingPointQuery = (graphIri) => `${PREFIX}
SELECT DISTINCT ?node ?type ?label ?comment WHERE {
  GRAPH <${graphIri}> {
    ?node a ?type .
    FILTER(?type IN (${typeValues}))
    OPTIONAL { ?node rdfs:label ?label }
    OPTIONAL { ?node rdfs:comment ?comment }
  }
} 
ORDER BY ?type ?label ?node
LIMIT ${RAN_GRAPH_LIMITS.STARTING_NODES}`;

// Graph expansion tab: same four relationship predicates and both directions as supplied.
const graphExpansionQuery = (graphIri) => `${PREFIX}
SELECT DISTINCT ?from ?predicate ?to WHERE {
  GRAPH <${graphIri}> {
    {
      ?node ?p ?value .
      FILTER(?p IN (${edgeValues}))
      FILTER(isIRI(?value) && STRSTARTS(STR(?value), "${RAN_NS}"))
      BIND(?node AS ?from)
      BIND(?p AS ?predicate)
      BIND(?value AS ?to)
    }
    UNION
    {
      ?value ?p2 ?node .
      FILTER(?p2 IN (${edgeValues}))
      FILTER(isIRI(?value) && STRSTARTS(STR(?value), "${RAN_NS}"))
      BIND(?value AS ?from)
      BIND(?p2 AS ?predicate)
      BIND(?node AS ?to)
    }
  }
}
ORDER BY ?from ?predicate ?to
LIMIT ${RAN_GRAPH_LIMITS.RELATIONSHIPS}`;

// Node basics tab: retains the provided type filter, label/comment and rank.
const nodeBasicsQuery = (graphIri) => `${PREFIX}
SELECT ?node ?type ?label ?comment ?rank WHERE {
  GRAPH <${graphIri}> {
    ?node a ?type .
    FILTER(?type IN (${typeValues}))
    OPTIONAL { ?node rdfs:label ?label . }
    OPTIONAL { ?node rdfs:comment ?comment . }
    BIND(0.5 AS ?rank)
  }
}`;

// Edge basics tab: resolve labels for the four configured visual-graph predicates.
const edgeBasicsQuery = (graphIri) => `${PREFIX}
SELECT DISTINCT ?edge ?label WHERE {
  GRAPH <${graphIri}> { ?s ?edge ?o . FILTER(?edge IN (${edgeValues})) }
  OPTIONAL { ?edge rdfs:label ?label . FILTER(LANG(?label) = "" || LANGMATCHES(LANG(?label), "en")) }
}`;

// Node extra tab: all non-observation properties of the configured visual node classes.
const nodeExtraQuery = (graphIri) => `${PREFIX}
SELECT ?node ?p ?value WHERE {
  GRAPH <${graphIri}> {
    ?node a ?type ; ?p ?value .
    FILTER(?type IN (${typeValues}))
    FILTER(!STRSTARTS(STR(?node), "${OBS_PREFIX}"))
  }
} ORDER BY ?node ?p
 LIMIT ${RAN_GRAPH_LIMITS.NODE_PROPERTIES}`;

export const RAN_VISUAL_CONFIG_QUERIES = (state = 'current') => {
  const graph = state === 'target' ? TARGET_GRAPH : CURRENT_GRAPH;
  return [
    { key: 'starting', label: 'Starting point', description: 'Find Site, O-Cloud Host, O-Cloud DU Host, O-CU and O-DU resources in the selected graph.', query: startingPointQuery(graph) },
    { key: 'expansion', label: 'Graph expansion', description: 'Expand locatedAt, hostedOn, containsNode and connectsToCUCP relationships in both directions.', query: graphExpansionQuery(graph) },
    { key: 'node', label: 'Node basics', description: 'Apply node type, label, comment and rank metadata.', query: nodeBasicsQuery(graph) },
    { key: 'edge', label: 'Edge basics', description: 'Resolve readable labels for the configured relationship predicates.', query: edgeBasicsQuery(graph) },
    { key: 'extra', label: 'Node extra', description: 'Retrieve properties used in node details and hover information.', query: nodeExtraQuery(graph) },
  ];
};

const latestHeadQuery = (graphIri) => `${PREFIX}
SELECT (MAX(?t) AS ?h) WHERE {
  GRAPH <${graphIri}> { ?o a ran:Observation ; ran:observedAt ?t }
}`;
const latestPerSeriesQuery = (graphIri, since) => `${PREFIX}
SELECT ?e ?m ?v ?t WHERE {
  GRAPH <${graphIri}> {
    { SELECT ?e ?m (MAX(?t0) AS ?t) WHERE {
        ?o0 a ran:Observation ; ran:observes ?e ; ran:metric ?m ; ran:observedAt ?t0 .
        FILTER(?t0 >= "${since}"^^xsd:dateTime)
      } GROUP BY ?e ?m
    }
    ?o a ran:Observation ; ran:observes ?e ; ran:metric ?m ; ran:observedAt ?t ; ran:value ?v .
  }
} ORDER BY ?e ?m
 LIMIT ${RAN_GRAPH_LIMITS.TELEMETRY_ROWS}`;

export async function loadRANTelemetry({ graphIri = CURRENT_GRAPH, maxAgeMinutes = 30 } = {}) {
  const [headRows, metrics] = await Promise.all([
    runRANSparql(latestHeadQuery(graphIri)),
    runRANSparql(`${PREFIX}
      SELECT ?metric (COUNT(DISTINCT ?e) AS ?entities) (COUNT(*) AS ?readings) WHERE {
        GRAPH <${graphIri}> { ?o a ran:Observation ; ran:observes ?e ; ran:metric ?metric }
      } GROUP BY ?metric ORDER BY ?metric`),
  ]);
  const head = headRows[0]?.h?.value || null;
  let latest = [];
  if (head) {
    const headTime = Date.parse(head);
    if (!Number.isFinite(headTime)) throw new Error(`Invalid latest RAN observation timestamp: ${head}`);
    const since = new Date(headTime - maxAgeMinutes * 60 * 1000).toISOString();
    latest = await runRANSparql(latestPerSeriesQuery(graphIri, since));
  }
  // Some repositories contain repeated rows at the same timestamp; retain one per entity/metric.
  const newest = new Map();
  latest.forEach((r) => {
    const key = `${r.e.value}|${r.m.value}`;
    const old = newest.get(key);
    if (!old || Date.parse(r.t.value) >= Date.parse(old.observedAt)) {
      newest.set(key, { entity: r.e.value, metric: r.m.value, value: numeric(r.v.value), observedAt: r.t.value });
    }
  });
  return {
    head,
    latest: [...newest.values()],
    metrics: metrics.map((r) => ({ metric: r.metric.value, entities: Number(r.entities.value), readings: Number(r.readings.value) })),
  };
}

const metricPredicate = {
  cpu_percent: 'cpuPercent', load_percent: 'loadPercent', session_load_percent: 'sessionLoadPercent',
  utilisation_percent: 'utilisationPercent', active_users: 'activeUsers',
  throughput_mbps: 'throughputMbps', p5_throughput_mbps: 'p5ThroughputMbps', latency_ms: 'latencyMs',
  ping_pong_pct: 'pingPongRate', ho_failure_pct: 'handoverFailureRate',
};

export async function loadRANTargetComparison() {
  const values = Object.entries(metricPredicate).map(([metric, predicate]) => `("${metric}" ran:${predicate})`).join(' ');
  const query = `${PREFIX}
SELECT ?element ?metric ?current ?target (?target - ?current AS ?change) WHERE {
  VALUES (?metric ?pred) { ${values} }
  GRAPH <${TARGET_GRAPH}> { ?element ?pred ?target }
  OPTIONAL {
    GRAPH <${CURRENT_GRAPH}> {
      ?o ran:observes ?element ; ran:metric ?metric ; ran:observedAt ?at ; ran:value ?current .
      FILTER NOT EXISTS { ?o2 ran:observes ?element ; ran:metric ?metric ; ran:observedAt ?at2 . FILTER(?at2 > ?at) }
    }
  }
} ORDER BY DESC(?change)`;
  const rows = await runRANSparql(query);
  return rows.map((r) => ({ element: r.element.value, metric: r.metric.value, current: numeric(r.current?.value), target: numeric(r.target?.value), change: numeric(r.change?.value) }));
}

const cellInventoryQuery = (graphIri) => `${PREFIX}
SELECT DISTINCT ?cell ?label ?comment WHERE {
  GRAPH <${graphIri}> {
    ?cell a ran:Cell .
    OPTIONAL { ?cell rdfs:label ?label }
    OPTIONAL { ?cell rdfs:comment ?comment }
  }
} ORDER BY ?label ?cell
 LIMIT ${RAN_GRAPH_LIMITS.CELLS}`;

export async function loadRANTopology(state = 'current') {
  const graphIri = state === 'target' ? TARGET_GRAPH : CURRENT_GRAPH;
  const [startRows, expansionRows, extraRows, edgeRows, cellRows, telemetry, countRows] = await Promise.all([
    runRANSparql(startingPointQuery(graphIri)),
    runRANSparql(graphExpansionQuery(graphIri)),
    runRANSparql(nodeExtraQuery(graphIri)),
    runRANSparql(edgeBasicsQuery(graphIri)),
    runRANSparql(cellInventoryQuery(graphIri)),
    state === 'current' ? loadRANTelemetry({ graphIri }) : Promise.resolve({ head: null, latest: [], metrics: [] }),
    runRANSparql(`${PREFIX} SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graphIri}> { ?s ?p ?o . FILTER(!STRSTARTS(STR(?s), "${OBS_PREFIX}")) } }`),
  ]);

  const nodeMap = new Map();
  const edgeMap = new Map();
  const attributes = new Map();
  const labels = new Map(edgeRows.filter((r) => r.label?.value).map((r) => [r.edge.value, r.label.value]));
  const ensureNode = (iri) => {
    if (!iri) return;
    if (!nodeMap.has(iri)) nodeMap.set(iri, { id: iri, label: localName(iri), group: 'resource', title: iri });
  };
  const ensureAttributes = (iri) => { if (!attributes.has(iri)) attributes.set(iri, {}); return attributes.get(iri); };

  // Node basics query determines the principal visual nodes and their display metadata.
  startRows.forEach((r) => {
    const iri = r.node.value;
    ensureNode(iri);
    const node = nodeMap.get(iri);
    node.type = localName(r.type.value);
    node.group = node.type.toLowerCase();
    if (r.label?.value) node.label = r.label.value;
    if (r.comment?.value) node.comment = r.comment.value;
    node.rank = r.rank?.value ? Number(r.rank.value) : 0.5;
  });

  // Cells are retained as a What-if inventory; the GraphDB visual config's main node classes remain Site/Host/CU/DU.
  cellRows.forEach((r) => {
    const iri = r.cell.value;
    ensureNode(iri);
    nodeMap.get(iri).type = 'Cell';
    nodeMap.get(iri).group = 'cell';
    if (r.label?.value) nodeMap.get(iri).label = r.label.value;
    if (r.comment?.value) nodeMap.get(iri).comment = r.comment.value;
  });

  // Node extra query supplies properties for tooltips without turning literals into graph nodes.
  extraRows.forEach((r) => {
    const iri = r.node.value;
    ensureNode(iri);
    const value = r.value.value;
    ensureAttributes(iri)[localName(r.p.value)] = value;
    if (r.p.value.endsWith('#label') || r.p.value.endsWith('/label')) nodeMap.get(iri).label = value;
    if (r.p.value.endsWith('#comment') || r.p.value.endsWith('/comment')) nodeMap.get(iri).comment = value;
  });

  // Graph expansion query supplies only the configured site/host/CU/DU relationships.
  expansionRows.forEach((r) => {
    const from = r.from.value, to = r.to.value, predicate = r.predicate.value;
    ensureNode(from); ensureNode(to);
    const key = `${from}|${predicate}|${to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, {
      id: key, from, to, label: labels.get(predicate) || localName(predicate),
      title: predicate, arrows: 'to', kind: localName(predicate),
    });
  });

  // Overlay the newest live observations on the corresponding Current graph nodes.
  telemetry.latest.forEach(({ entity, metric, value, observedAt }) => {
    ensureAttributes(entity)[metric] = value;
    ensureAttributes(entity)[`${metric}_observedAt`] = observedAt;
    ensureNode(entity);
  });
  attributes.forEach((values, iri) => {
    const node = nodeMap.get(iri);
    if (node) node.title = `${node.label}\n${iri}\n${Object.entries(values).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  });

  const getMetric = (iri, ...names) => {
    const values = attributes.get(iri) || {};
    for (const name of names) if (values[name] != null) return numeric(values[name]);
    return null;
  };
  const nodes = [...nodeMap.values()];
  const duMetrics = nodes.filter((n) => n.type === 'O_DU').map((n) => ({
    du: n.id, cpu: getMetric(n.id, 'cpuPercent', 'cpu_percent'),
    host: getMetric(n.id, 'hostedOn'), site: getMetric(n.id, 'locatedAt'),
  }));
  const cells = nodes.filter((n) => n.type === 'Cell').map((n) => ({
    cell: n.id, name: n.label || localName(n.id), load: getMetric(n.id, 'loadPercent', 'load_percent'),
    users: getMetric(n.id, 'activeUsers', 'active_users'), handoverFailure: getMetric(n.id, 'handoverFailureRate', 'ho_failure_pct'),
    throughput: getMetric(n.id, 'p5ThroughputMbps', 'throughputMbps', 'p5_throughput_mbps', 'throughput_mbps'),
    pingPong: getMetric(n.id, 'pingPongRate', 'ping_pong_pct'),
    du: null,
  }));
  const duByCell = new Map(expansionRows.filter((r) => localName(r.predicate.value) === 'containsNode').map((r) => [r.to.value, r.from.value]));
  cells.forEach((cell) => { cell.du = duByCell.get(cell.cell) || null; });

  return {
    state, graphIri, tripleCount: Number(countRows[0]?.count?.value ?? 0),
    nodes, edges: [...edgeMap.values()], duMetrics, cells, telemetry,
    visualConfig: RAN_VISUAL_CONFIG_QUERIES(state),
  };
}

export async function runRANWhatIf(mode, scenario) {
  const response = await fetch(`/ran-whatif/${mode}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, sourceGraph: CURRENT_GRAPH, targetGraph: TARGET_GRAPH, repository: REPOSITORY }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { narration: text }; }
  if (!response.ok || data.ok === false) throw new Error(data.error || data.stderr || data.narration || `RAN what-if service HTTP ${response.status}`);
  return data;
}

const latestReadingsQuery = `${PREFIX}
SELECT ?e ?m ?v ?t WHERE {
  { SELECT ?e ?m (MAX(?t0) AS ?latest) WHERE {
      GRAPH <${CURRENT_GRAPH}> {
        ?o0 a ran:Observation ; ran:observes ?e ; ran:metric ?m ; ran:observedAt ?t0 .
        FILTER(?t0 >= "2000-01-01T00:00:00Z"^^xsd:dateTime)
      }
    } GROUP BY ?e ?m
  }
  GRAPH <${CURRENT_GRAPH}> {
    ?o a ran:Observation ; ran:observes ?e ; ran:metric ?m ; ran:observedAt ?t ; ran:value ?v .
    FILTER(?t = ?latest)
  }
} ORDER BY ?e ?m`;

export const RAN_QUERY_PRESETS = [
  { id: 'Q1.1', stage: 'Stage 1 — Current topology', title: 'Network topology triples', query: graphTriplesQuery(CURRENT_GRAPH) },
  { id: 'Q1.2', stage: 'Stage 1 — Current topology', title: 'GraphDB visual starting nodes', query: startingPointQuery(CURRENT_GRAPH) },
  { id: 'Q1.3', stage: 'Stage 1 — Current topology', title: 'Graph expansion relationships', query: graphExpansionQuery(CURRENT_GRAPH) },
  { id: 'Q2.1', stage: 'Stage 2 — Live telemetry', title: 'Newest observation timestamp', query: latestHeadQuery(CURRENT_GRAPH) },
  { id: 'Q2.2', stage: 'Stage 2 — Live telemetry', title: 'Newest reading per entity and metric', query: latestReadingsQuery },
  { id: 'Q2.3', stage: 'Stage 2 — Live telemetry', title: 'Telemetry metrics summary', query: `${PREFIX} SELECT ?metric (COUNT(DISTINCT ?e) AS ?entities) (COUNT(*) AS ?readings) WHERE { GRAPH <${CURRENT_GRAPH}> { ?o a ran:Observation ; ran:observes ?e ; ran:metric ?metric } } GROUP BY ?metric ORDER BY ?metric` },
  { id: 'Q3.1', stage: 'Stage 3 — Target topology', title: 'Target graph triple count', query: `${PREFIX} SELECT (COUNT(*) AS ?triples) WHERE { GRAPH <${TARGET_GRAPH}> { ?s ?p ?o } }` },
  { id: 'Q3.2', stage: 'Stage 3 — Target topology', title: 'Target starting nodes', query: startingPointQuery(TARGET_GRAPH) },
  { id: 'Q3.3', stage: 'Stage 3 — Target topology', title: 'Target graph expansion', query: graphExpansionQuery(TARGET_GRAPH) },
  { id: 'Q4.1', stage: 'Stage 4 — Current vs Target', title: 'Current vs Target KPI comparison', query: `${PREFIX}
SELECT ?element ?metric ?current ?target (?target - ?current AS ?change) WHERE {
  VALUES (?metric ?pred) { ("cpu_percent" ran:cpuPercent) ("load_percent" ran:loadPercent) ("session_load_percent" ran:sessionLoadPercent) ("utilisation_percent" ran:utilisationPercent) ("active_users" ran:activeUsers) ("throughput_mbps" ran:throughputMbps) ("p5_throughput_mbps" ran:p5ThroughputMbps) ("latency_ms" ran:latencyMs) ("ping_pong_pct" ran:pingPongRate) ("ho_failure_pct" ran:handoverFailureRate) }
  GRAPH <${TARGET_GRAPH}> { ?element ?pred ?target }
  OPTIONAL { GRAPH <${CURRENT_GRAPH}> { ?o ran:observes ?element ; ran:metric ?metric ; ran:observedAt ?at ; ran:value ?current . FILTER NOT EXISTS { ?o2 ran:observes ?element ; ran:metric ?metric ; ran:observedAt ?at2 . FILTER(?at2 > ?at) } } }
} ORDER BY DESC(?change)` },
  { id: 'Q4.2', stage: 'Stage 4 — Current vs Target', title: 'Target node metadata', query: nodeBasicsQuery(TARGET_GRAPH) },
  { id: 'Q4.3', stage: 'Stage 4 — Current vs Target', title: 'Target KPI properties', query: nodeExtraQuery(TARGET_GRAPH) },
];

// Site-level traffic-ingestion view. All measurements are read from the RAN
// Current named graph; missing ontology fields remain null instead of being fabricated.
export async function loadRANSiteIngestion() {
const graphRows = await runRANSparql(`${PREFIX}
    SELECT ?s ?p ?o WHERE {
      GRAPH <${CURRENT_GRAPH}> {
        ?s ?p ?o .
        FILTER(!STRSTARTS(STR(?s), "${OBS_PREFIX}"))
      }
    }`);
const telemetry = await loadRANTelemetry({ graphIri: CURRENT_GRAPH });
const props = new Map();
const types = new Map();
const put = (id, predicate, value) => {
if (!props.has(id)) props.set(id, {});
const key = localName(predicate).toLowerCase();
const current = props.get(id)[key];
if (key === 'type' || key === 'label' || current == null) props.get(id)[key] = value;
};
graphRows.forEach((r) => {
const id = r.s.value;
const pred = r.p.value;
const value = r.o.value;
put(id, pred, value);
if (pred.endsWith('#type') || pred.endsWith('/type')) {
const type = localName(value);
if (!types.has(id)) types.set(id, new Set());
types.get(id).add(type);
}
});
const idsOf = (type) => [...types.entries()].filter(([, set]) => set.has(type)).map(([id]) => id);
const sites = idsOf('Site').map((id) => ({ id, label: props.get(id)?.label || localName(id) }));
const dus = idsOf('O_DU').map((id) => ({ id, p: props.get(id) || {} }));
const cus = idsOf('OCU').map((id) => ({ id, p: props.get(id) || {} }));
const metricValues = new Map();
telemetry.latest.forEach((r) => {
const id = r.entity.startsWith(RAN_NS) ? r.entity : `${RAN_NS}${r.entity}`;
if (!metricValues.has(id)) metricValues.set(id, {});
metricValues.get(id)[String(r.metric).toLowerCase()] = Number(r.value);
});
const read = (id, names) => {
const p = props.get(id) || {};
const m = metricValues.get(id) || {};
for (const name of names) {
const key = name.toLowerCase();
if (m[key] != null && Number.isFinite(m[key])) return m[key];
if (p[key] != null && Number.isFinite(Number(p[key]))) return Number(p[key]);
}
return null;
};
const relation = (id, names) => {
const p = props.get(id) || {};
for (const name of names) if (p[name.toLowerCase()]) return p[name.toLowerCase()];
return null;
};
const siteFor = (id) => {
const direct = relation(id, ['locatedAt', 'site']);
if (direct && sites.some((x) => x.id === direct)) return direct;
const host = relation(id, ['hostedOn', 'host']);
return host ? relation(host, ['locatedAt', 'site']) : null;
};
const clusters = [];
sites.forEach((site) => {
const siteDus = dus.filter((du) => siteFor(du.id) === site.id);
const siteCus = cus.filter((cu) => siteFor(cu.id) === site.id || siteDus.some((du) => relation(du.id, ['connectsToCUCP', 'cu', 'servedBy']) === cu.id));
siteCus.forEach((cu) => {
const linked = siteDus.filter((du) => relation(du.id, ['connectsToCUCP', 'cu', 'servedBy']) === cu.id);
const members = linked.length ? linked : (siteCus.length === 1 ? siteDus : []);
const duCpuValues = members.map((du) => read(du.id, ['cpu_percent', 'cpuPercent', 'cpu'])).filter((v) => v != null);
const duPrbValues = members.map((du) => read(du.id, ['prb_dl_percent', 'dlPrbPercent', 'prbDl', 'dlPrb'])).filter((v) => v != null);
const cpus = members.map((du) => read(du.id, ['allocated_cores', 'allocatedCores', 'coresUsed'])).filter((v) => v != null);
const total = read(cu.id, ['total_cores', 'totalCores', 'serverCores']);
const used = read(cu.id, ['cores_used', 'coresUsed', 'allocated_cores', 'allocatedCores']);
const maxCpu = duCpuValues.length ? Math.max(...duCpuValues) : null;
const cuCpu = read(cu.id, ['cpu_percent', 'cpuPercent', 'cpu']);
const threshold = read(cu.id, ['cpu_threshold_percent', 'cpuThresholdPercent', 'overloadThresholdPercent']);
const limit = threshold ?? 85;
const status = maxCpu == null && cuCpu == null ? 'NO DATA' : Math.max(maxCpu ?? 0, cuCpu ?? 0) >= limit ? 'OVERLOAD' : 'NORMAL';
clusters.push({ id: cu.id, site: site.id, label: props.get(cu.id)?.label || localName(cu.id), duCount: members.length, host: members.map((du) => localName(relation(du.id, ['hostedOn', 'host']) || '')).filter(Boolean).join(', ') || null, duCpu: duCpuValues.length ? Math.max(...duCpuValues) : null, duPrb: duPrbValues.length ? duPrbValues.reduce((a, b) => a + b, 0) / duPrbValues.length : null, cuCpu, coresUsed: used ?? (cpus.length ? cpus.reduce((a, b) => a + b, 0) : null), totalCores: total, status });
});
});
const thresholdValues = [...props.values()].map((p) => p.cputhresholdpercent ?? p.overloadthresholdpercent).filter((v) => v != null && Number.isFinite(Number(v)));
const threshold = thresholdValues.length ? Number(thresholdValues[0]) : 85;
const siteSummaries = sites.map((site) => {
const members = dus.filter((du) => siteFor(du.id) === site.id);
const userCounts = members.map((du) => read(du.id, ['active_users', 'activeUsers', 'users'])).filter((v) => v != null);
const throughput = members.map((du) => read(du.id, ['throughput_mbps', 'throughputMbps', 'dlThroughputMbps'])).filter((v) => v != null);
const capacities = members.map((du) => read(du.id, ['dl_capacity_mbps', 'dlCapacityMbps', 'duDlCapacityMbps', 'throughputCapacityMbps'])).filter((v) => v != null);
const cpu = members.map((du) => read(du.id, ['cpu_percent', 'cpuPercent', 'cpu'])).filter((v) => v != null);
const users = userCounts.reduce((a, b) => a + b, 0);
const totalThroughput = throughput.reduce((a, b) => a + b, 0);
return { ...site, users: userCounts.length ? users : null, perUeMbps: users > 0 && throughput.length ? totalThroughput / users : null, dlCapacityMbps: capacities.length ? capacities.reduce((a, b) => a + b, 0) : null, peakCpu: cpu.length ? Math.max(...cpu) : null };
});
return { sites: siteSummaries, clusters, readings: telemetry.latest.length, head: telemetry.head, threshold };
}
