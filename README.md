# Digital Twin Console — GraphDB UI

This React/Vite app reads the 5G Core and Transport ontology graphs directly from separate GraphDB repositories. The 5G Core view uses `5g_core`; the Transport view uses `site_consolidation`.

## Run locally (Windows)

1. Install Node.js 18+.
2. Start the SSH tunnel in a separate PowerShell/Putty terminal and keep it open:

   ```powershell
   ssh -N -L 7200:127.0.0.1:7200 ubuntu@10.161.4.175
   ```

   If the server-side GraphDB is bound only to its loopback interface, `127.0.0.1:7200` on the remote side is correct. Enter your SSH password when prompted. The tunnel must be active before connecting the UI.

3. In this project directory:

   ```powershell
   npm install
   npm run dev
   ```

4. Open `http://localhost:4000`.

The Vite dev server proxies `/graphdb/*` to `http://127.0.0.1:7200`, so browser requests use the local UI origin and avoid GraphDB CORS restrictions.

## GraphDB repositories

Repository names can be configured in `.env`:

- `VITE_GRAPHDB_REPOSITORY=5g_core` for the 5G Core application.
- `VITE_GRAPHDB_TRANSPORT_REPOSITORY=site_consolidation` for the Transport application.

Both repositories are queried through the same local GraphDB proxy. Transport's Ontology Graph reads these named graphs:

- Current: `http://example.com/sct/graph/current`
- Target: `http://example.com/sct/graph/target-view`
- Planned: `http://example.com/sct/graph/planned-view/{source}-to-{destination}/{version}`

Choose **Planned state**, enter source and destination site IDs and a plan version, then select **Load planned graph**. The UI reads the existing planned named graph; it does not create or modify a consolidation plan in GraphDB. The default planned graph selection is `SITE-KOE-02` to `SITE-KOE-01`, version `1`.

The 5G Core application continues to query its current, telemetry, and target named graphs in `5g_core`.
In Transport, the Ontology Graph uses `site_consolidation`; the existing Data Ingestion, What-If, and Site Intelligence tabs continue to use the configured Transport backend.

## Data notes

- The 5G Core default graph is the original topology and is read only.
- The Python script writes live/simulated CPU and session values to the telemetry named graph.
- It copies the default graph into the target named graph only when the simulated CPU threshold is crossed, then exits. Target state is therefore a scenario snapshot, not a continuously changing graph.
- The dashboard polls GraphDB every five seconds. If the Python process is not running, the UI can still display the graph values already stored in GraphDB.

## GraphDB access

The repository should be accessible at `http://127.0.0.1:7200/repositories/5g_core` through the SSH tunnel. If GraphDB requires authentication, configure the Vite proxy to add credentials or set up a local backend proxy; do not place production credentials in frontend code.

---

## Transport site-consolidation What-if API

The Transport What-if page uses the read-only `/transport-api/preview` endpoint and the `/transport-api/execute` endpoint. The Vite dev server proxies these routes to a small Python HTTP bridge.

Place `site_consolidation_backend.py` and `site_consolidation_api.py` in the project root (both are included in this archive). On the Ubuntu host where GraphDB is reachable at `http://127.0.0.1:7200`, start the bridge in one terminal:

```bash
python3 -m pip install requests
python3 site_consolidation_api.py
```

Start the React app in another terminal:

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4000
```

The preview endpoint only reads the `site_consolidation` repository. Execute invokes `site_consolidation_backend.py` as a subprocess; that engine performs its configured GraphDB updates. Do not expose the Python bridge publicly; it binds to `127.0.0.1` and is intended to be accessed through the local Vite proxy. Review the engine's GraphDB URL/repository settings before execution.

Site Intelligence runs SPARQL directly against the `site_consolidation` repository through the Vite `/graphdb` proxy. Query groups are numbered sequentially Q1.1–Q1.3, Q2.1–Q2.3, Q3.1–Q3.3 and Q4.1–Q4.3. Planned/target queries return no rows until those graphs exist.

## Independent RAN Digital Twin use case

RAN is a separate route (`/ran`) and uses the GraphDB host `10.161.4.199` with repository `Traffic_Steering` by default (matching the GraphDB repository shown in the supplied screenshot). The React application remains on `10.161.4.175`. Its GraphDB requests use the `/ran-graphdb` proxy, existing ingestion/intelligence API requests use `/ran-api` (backend port 8000), and the GraphDB what-if engine uses `/ran-whatif` (adapter port 8010).

The RAN application retains its separate Data Ingestion, Ontology Graph, What-if, and RAN Intelligence sections. The detailed graph and Python engine setup follows below.

## RAN GraphDB graph visualization and Python what-if engine

RAN uses its own GraphDB host and repository. The React application runs on the existing UI host `10.161.4.175`; the RAN GraphDB and Python engine run on `10.161.4.199`.

### RAN GraphDB settings

Set these Vite variables in the UI project's `.env` (the target graph must match the `target_graph` configured in the RAN engine's `.env`):

```dotenv
VITE_GRAPHDB_RAN_REPOSITORY=Traffic_Steering
VITE_GRAPHDB_RAN_CURRENT_GRAPH=http://example.com/ran-dt/graph/current
VITE_GRAPHDB_RAN_TARGET_GRAPH=http://example.com/ran-dt/graph/target
```

The RAN graph page queries the Current and Target named graphs separately. Current includes the baseline topology and telemetry observations; Target is the derived network and projected KPI snapshot written by `graphdb_whatif.py`. The topology view follows the five visual-graph configuration sections supplied from GraphDB. Its main visual node types are Site, OCloudHost, OCloudDUHost, OCU and O_DU, with relationship expansion over locatedAt, hostedOn, containsNode and connectsToCUCP. Cells are also queried separately for the What-if selector and inventory.

The browser implementation follows the supplied SPARQL data model and GraphDB Visual Graph configuration. It implements the five visual sections: Starting point, Graph expansion, Node basics, Edge basics and Node extra. The starting point filters Site, OCloudHost, OCloudDUHost, OCU and O_DU types; expansion uses locatedAt, hostedOn, containsNode and connectsToCUCP in both directions. Current and Target are queried independently.

- `sparql/graph_construct.rq`: Current network RDF, excluding subjects under `ran:obs/`.
- `sparql/starting_point.rq`: Starting resources of types Site, OCloudHost, OCloudDUHost, OCU and O_DU.
- `sparql/graph_expansion.rq`: Bidirectional expansion over locatedAt, hostedOn, containsNode and connectsToCUCP.
- `sparql/node_basics.rq`, `sparql/edge_basics.rq`, `sparql/node_extra.rq`: Node type/label/comment/rank, edge labels and node properties.
- `sparql/telemetry_head.rq`: newest observation timestamp.
- `sparql/telemetry_latest_per_series.rq`: newest reading per entity and metric since the newest timestamp minus the configured telemetry age (30 minutes by default).
- `sparql/target_view.rq`: Current-versus-Target comparison using the exact KPI predicate list and newest Current observation logic supplied with `graphdb_whatif.py`.

The Current graph view overlays newest telemetry values on visual nodes. The Target graph displays the projected topology and values written by the engine, with a Current-vs-Target comparison table. The engine installs/refreshes `target-view` using the same source and target graph IRIs passed by the UI.

### Install/start the What-if bridge on 10.161.4.199

`graphdb_whatif.py` is the engine supplied by the backend team. It imports the application's `backend/dtwin` package, so it must run inside the actual RAN application project tree, alongside that backend package. This React ZIP includes the engine copy under `scripts/graphdb_whatif.py` and the HTTP adapter `ran_whatif_api.py`, but does not include the private `backend/dtwin` application package.

On `10.161.4.199`, copy these two files into the root of the existing RAN backend project:

- `scripts/graphdb_whatif.py` (create the `scripts` directory if needed)
- `ran_whatif_api.py`

Use the same Python virtual environment that runs the RAN backend, and ensure its backend requirements include `requests` and `rdflib`. Configure the RAN project's existing `.env` so its `GRAPHDB_URL` points to the local GraphDB service and `GRAPHDB_REPOSITORY=Traffic_Steering`. Also ensure its configured `current_graph`, `target_graph`, and `ran_ns` match the graph IRIs and namespace above. Do not point the engine at the UI host's GraphDB.

Start the adapter from the RAN project root:

```bash
RAN_WHATIF_PYTHON=/path/to/ran/.venv/bin/python \
GRAPHDB_URL=http://127.0.0.1:7200 \
GRAPHDB_REPOSITORY=Traffic_Steering \
python3 ran_whatif_api.py
```

The adapter listens on `0.0.0.0:8010`. Allow the UI host `10.161.4.175` to reach `10.161.4.199:8010`. The Vite proxy `/ran-whatif` forwards to that service. Keep the existing RAN backend on port `8000` for telemetry ingestion controls and other existing API pages.

### What-if behaviour

- **Run what-if analysis** calls the Python engine with `--dry-run`. It reads Current topology and newest live readings from GraphDB, computes the selected DU/Cell traffic surge, prints the projected impact, and writes nothing.
- **Execute what-if** calls the same engine without `--dry-run`. The engine builds/replaces the configured Target named graph and refreshes the GraphDB `target-view` saved query. It refuses to write into Current or Ontology.
- The UI passes entity IDs (the local IDs after the `http://example.com/ran-dt/` namespace) to match the engine's `TwinState` identifiers.
- After a successful execution, the graph page can switch to **Target state** to render the projected topology and KPI values. Switch back to **Current state** for the live baseline.

The engine needs the current network graph and recent telemetry in the configured Current graph. If it reports that the graph is empty or no recent observations exist, first start the existing RAN backend/telemetry simulator and verify the configured graph IRIs in the backend `.env`.

### RAN proxy/network requirements

The UI host `10.161.4.175` must reach `10.161.4.199` on ports `7200`, `8000`, and `8010`. The browser continues to access the React UI through the existing SSH tunnel to `10.161.4.175`; do not expose GraphDB or the What-if adapter directly to the public internet.


### Step-by-step RAN deployment (Core and Transport remain local to 10.161.4.175)

1. On `10.161.4.175`, merge the following values into the existing React project's `.env` (do not replace other Core/Transport settings):

```dotenv
VITE_GRAPHDB_RAN_REPOSITORY=Traffic_Steering
VITE_GRAPHDB_RAN_CURRENT_GRAPH=http://example.com/ran-dt/graph/current
VITE_GRAPHDB_RAN_TARGET_GRAPH=http://example.com/ran-dt/graph/target
```

2. From `10.161.4.175`, verify network reachability to RAN GraphDB and its What-if adapter host:

```bash
curl -I http://10.161.4.199:7200
curl -i http://10.161.4.199:8010/health
```

3. On `10.161.4.199`, verify that the repository exists and that the Current named graph contains the expected topology classes. Run in GraphDB Workbench or with curl:

```bash
curl -sG 'http://127.0.0.1:7200/repositories/Traffic_Steering' \
  -H 'Accept: application/sparql-results+json' \
  --data-urlencode 'query=SELECT ?type (COUNT(?node) AS ?count) WHERE { GRAPH <http://example.com/ran-dt/graph/current> { ?node a ?type . FILTER(?type IN (<http://example.com/ran-dt/Site>, <http://example.com/ran-dt/OCloudHost>, <http://example.com/ran-dt/OCloudDUHost>, <http://example.com/ran-dt/OCU>, <http://example.com/ran-dt/O_DU>)) } } GROUP BY ?type'
```

If this returns no rows, the backend team must load the topology into the configured Current graph or confirm the actual class and graph IRIs. The UI deliberately does not invent nodes or silently switch to the default graph.

4. On `10.161.4.199`, place `scripts/graphdb_whatif.py` and `ran_whatif_api.py` inside the actual RAN backend project root, alongside its private `backend/dtwin` package. Use the same virtual environment as the RAN backend. Install the adapter dependencies if needed:

```bash
python -m pip install requests rdflib
```

5. Start the What-if adapter from that backend project root, using the actual virtualenv path:

```bash
RAN_WHATIF_PYTHON=/path/to/ran/.venv/bin/python \
GRAPHDB_URL=http://127.0.0.1:7200 \
GRAPHDB_REPOSITORY=Traffic_Steering \
RAN_CURRENT_GRAPH=http://example.com/ran-dt/graph/current \
python3 ran_whatif_api.py
```

The adapter listens on port `8010`. Its `/health` response checks GraphDB connectivity and reports the Current graph triple count. `script_exists=true` alone is not enough; verify `graphdb_connected=true` as well.

6. On `10.161.4.175`, install and start the React app:

```bash
npm install
npm run build
npm run dev -- --host 0.0.0.0 --port 4000
```

7. From Windows, create the existing UI SSH tunnel and open the app:

```bash
ssh -N -L 4000:127.0.0.1:4000 ubuntu@10.161.4.175
```

Open `http://localhost:4000`, select RAN, then Ontology Graph. Choose Current or Target state. The graph uses the named graph IRIs above. Run Preview first; Execute writes only to Target.

**Isolation:** The RAN route uses `/ran-graphdb` to proxy to `10.161.4.199:7200` and `/ran-whatif` to proxy to `10.161.4.199:8010`. Existing Core `/graphdb` and Transport `/transport-api` proxies remain pointed at `127.0.0.1` on `10.161.4.175`; their repository and backend configuration is not changed by the RAN update.


*******************************
