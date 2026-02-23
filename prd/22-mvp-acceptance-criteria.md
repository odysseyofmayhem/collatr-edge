## 22. MVP Acceptance Criteria

Five scenarios that define "done" for the MVP. Thresholds are starting points — adjustable post-kickoff based on observed data.

### Scenario 1: Basic Data Collection

**Given** a CollatrEdge instance configured with an OPC-UA input plugin pointing at a live OPC-UA server (or simulator),
**When** the operator runs `collatr-edge run`,
**Then** live values appear in the Web UI within **60 seconds**.

### Scenario 2: Persistence Survives Power Loss

**Given** a CollatrEdge instance actively collecting OPC-UA data to the local store,
**When** the process is killed with `SIGKILL` (simulating power loss),
**And** the process is restarted,
**Then** data loss is **≤1 second**, the local store has zero corruption, and collection resumes automatically.

### Scenario 3: 24-Hour Standalone Operation

**Given** a CollatrEdge instance running on a Raspberry Pi 4 in `local_network` mode,
**When** it runs continuously for **24 hours** collecting at default intervals,
**Then** RSS stays **≤200MB**, there are **zero data gaps** in the local store, and no restarts or interventions are required.

### Scenario 4: CSV Export

**Given** a local store containing at least 24 hours of collected data,
**When** the operator exports a **1-hour range** via the Web UI or CLI,
**Then** the CSV file includes both **UTC and local timezone** timestamp columns, and the export completes in **<5 seconds**.

### Scenario 5: First-Run Setup

**Given** a freshly installed CollatrEdge binary with no existing configuration,
**When** the operator runs `collatr-edge config init`, edits the generated TOML to point at an OPC-UA server, and runs `collatr-edge run`,
**Then** live OPC-UA values are visible in the Web UI within **30 seconds** of starting the process.
