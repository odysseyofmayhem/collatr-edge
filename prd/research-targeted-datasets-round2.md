# Targeted Dataset Research — Round 2

**Date:** 2026-02-25  
**Purpose:** Fill specific gaps identified in Round 1 dataset research, targeting datasets that match the data patterns of Collatr's target customers as defined in the customer profiles document.  
**Companion documents:**
- [research-real-world-industrial-datasets.md](./research-real-world-industrial-datasets.md) — Round 1 (28 datasets, broad survey)
- [research-target-customer-data-profiles.md](./research-target-customer-data-profiles.md) — Target customer signal definitions

---

## Summary Table

| # | Dataset | Sector Match | Key Signals | Duration | Format | Size | License | Relevance |
|---|---------|-------------|-------------|----------|--------|------|---------|-----------|
| R2-1 | [Injection Molding Quality (iGuzzini)](#r2-1-injection-molding-quality-prediction-iguzzini) | Auto/Aero (IM) | Melt temp, mould temp, fill time, cycle time, injection pressure, clamp force | 1,451 shots over 5 production days | CSV | ~1 MB | Open/Academic | ★★★★ |
| R2-2 | [Pharma Tablet Compression (Big Data)](#r2-2-pharma-tablet-compression-big-data-collection) | Pharma | Compression force, turret speed, fill depth, tablet weight, hardness | 1,005 batches, Nov 2018–Apr 2021 | CSV | ~500 MB | CC BY 4.0 | ★★★★★ |
| R2-3 | [MSD Continuous Pharma Manufacturing](#r2-3-msd-continuous-pharmaceutical-manufacturing) | Pharma | ~75 process parameters incl. tablet press forces, displacement, feeder speeds | 120 hours continuous | CSV | ~2 GB | Academic (MSOM Challenge) | ★★★★★ |
| R2-4 | [Bosch CNC Machining (Brownfield)](#r2-4-bosch-cnc-machining-brownfield) | Auto/Aero (CNC) | 3-axis vibration at 2 kHz, 3 machines × 15 processes | Oct 2018–Aug 2021, 6 timeframes | HDF5 | ~1 GB | CC BY 4.0 | ★★★★ |
| R2-5 | [Hannover Milling Tool Wear](#r2-5-hannover-milling-tool-wear-multivariate) | Auto/Aero (CNC) | 3-axis force (25 kHz), spindle/feed torque & position (500 Hz), wear labels | 9 tools from new to EOL, 6,418 samples | HDF5 | ~10 GB | CC BY 4.0 | ★★★★★ |
| R2-6 | [QIT-CEMC End Milling Tool Wear](#r2-6-qit-cemc-end-milling-whole-life-cycle) | Auto/Aero (CNC) | 3-axis force, torque, vibration, sound; Ti6Al4V milling | Full lifecycle, multiple tools | CSV/MAT | ~5 GB | CC BY 4.0 | ★★★★ |
| R2-7 | [PHM 2010 CNC Milling Challenge](#r2-7-phm-2010-cnc-milling-challenge) | Auto/Aero (CNC) | Dynamometer forces (3-axis), vibration (3-axis), AE; 6 cutters | 315 cycles per tool to failure | CSV | ~500 MB | Open/Academic | ★★★★ |
| R2-8 | [NUAA Ideahouse Tool Wear](#r2-8-nuaa-ideahouse-tool-wear) | Auto/Aero (CNC) | Vibration, spindle current, power; variable cutting conditions | Multiple tools, variable conditions | CSV | ~2 GB | Open (IEEE DataPort) | ★★★★ |
| R2-9 | [MU-TCM Face Milling (Mondragon)](#r2-9-mu-tcm-face-milling-mondragon) | Auto/Aero (CNC) | Internal CNC signals (motor torque, current, power) + external (force, vibration) | Multiple cutting conditions & materials | CSV/Parquet | ~3 GB | CC BY 4.0 | ★★★★★ |
| R2-10 | [Haas VF-1 Milling (Poland)](#r2-10-haas-vf-1-milling-tool-life-dataset) | Auto/Aero (CNC) | 8 vibration sensors + 12 current transformers; 14 tools to failure | 968 cycles, 14 tool lifecycles | CSV | ~2 GB | CC BY 4.0 | ★★★★ |
| R2-11 | [AI4I 2020 Predictive Maintenance](#r2-11-ai4i-2020-predictive-maintenance) | General Manufacturing | Air temp, process temp, rotational speed, torque, tool wear; 5 failure modes | 10,000 data points | CSV | ~0.5 MB | CC BY 4.0 | ★★★ |
| R2-12 | [Cold Chain Milk](#r2-12-cold-chain-milk-temperature-data) | Food & Bev | Temperature over time through cold chain stages | Short time series | CSV | ~1 MB | Open (Kaggle) | ★★ |
| R2-13 | [ULT Refrigeration (COVID Vaccine)](#r2-13-ultralow-temperature-refrigeration-dataset) | Food & Bev / Pharma | 6+ thermocouple temperatures, compressor data, environmental conditions | Multiple test scenarios | CSV | ~100 MB | CC BY 4.0 | ★★★ |
| R2-14 | [Biopharmaceutical Manufacturing (Kaggle)](#r2-14-biopharmaceutical-manufacturing-batch-data) | Pharma | 100 batches: on-line process sensors, off-line lab results, Raman spectroscopy | 100 batches | CSV | ~200 MB | Open (Kaggle) | ★★★★ |
| R2-15 | [R2R Web Tension Digital Twin](#r2-15-roll-to-roll-web-tension-digital-twin-data) | Packaging/Printing | Web tension step responses, PI controller gains, OPC UA communication data | Controller optimization trials | Video + data | Small | CC BY 4.0 | ★★ |

---

## Detailed Dataset Descriptions

### Priority 1: Packaging / Printing / Labelling

#### R2-15. Roll-to-Roll Web Tension Digital Twin Data

- **Source:** Mendeley Data (Korea University of Science and Technology)
- **URL:** https://data.mendeley.com/datasets/zhm6t5vdpm/1
- **What it contains:** Supplementary data from a PhD thesis on AI Digital Twin of a Roll-to-Roll (R2R) printing system. Demonstrates autonomous Bayesian optimization of a PI web tension controller through a Digital Twin communicating with a physical R2R system via **OPC UA protocol**. Includes web tension step response data, controller gain optimization parameters (Kp, Ki), and quality scores derived from time constant, overshoot, and settling time.
- **Format:** Data files + video
- **Size:** Small (supplementary)
- **License:** CC BY 4.0
- **Collatr target sector:** Packaging/Printing — directly relevant to web tension control
- **Signals covered:** `web_tension` (step responses), controller tuning parameters
- **Data quality notes:** This is controller optimization data, not continuous production time series. Valuable for understanding R2R dynamics but limited as a replay dataset.
- **Relevance:** ★★ — Provides real web tension dynamics data and demonstrates OPC UA communication with R2R equipment, but too small and narrow for a full packaging line simulator.

**⚠️ KEY FINDING — Packaging/Printing data gap:** After exhaustive searching across Kaggle, Zenodo, IEEE DataPort, Mendeley Data, GitHub, academic paper supplements, and manufacturer sources, **no public dataset exists** containing:
- Flexographic press operational data (line speed, web tension, registration error, dryer temps)
- Print quality metrics (colour density, dot gain, registration)
- Laminator / slitter / rewinder operational data
- Coding/marking equipment data
- Packaging line OEE with machine state transitions

This is our **most critical gap** and the strongest argument for building a custom simulator. The packaging/printing industry is highly proprietary — equipment vendors (BOBST, W&H, Soma) don't publish sample data, and academic research in this area focuses on material science rather than process monitoring.

---

### Priority 2: Food & Beverage Manufacturing

#### R2-12. Cold Chain Milk Temperature Data

- **Source:** Kaggle
- **URL:** https://www.kaggle.com/datasets/u201411546/data-sets-cold-chain-milk
- **What it contains:** Temperature and time data from the cold chain of milk, tracking temperature through different supply chain stages.
- **Format:** CSV
- **Size:** ~1 MB
- **License:** Open (Kaggle)
- **Collatr target sector:** Food & Bev — cold chain monitoring
- **Signals covered:** `room_temperature` (cold storage analogue), time series temperature data
- **Data quality notes:** Very small dataset, primarily for cold chain logistics rather than manufacturing. Simple temperature-over-time traces.
- **Relevance:** ★★ — Demonstrates cold chain temperature patterns but far too simple for a manufacturing cold room monitoring simulator. Lacks compressor state, door events, defrost cycles, or multi-zone data.

#### R2-13. Ultralow Temperature Refrigeration Dataset

- **Source:** Scientific Data (Nature), University of Memphis
- **URL:** https://www.nature.com/articles/s41597-022-01167-y
- **What it contains:** Experimental and simulation data from an ultralow temperature refrigeration container for vaccine distribution. Includes:
  - 6+ thermocouple temperature measurements at different locations in container
  - Compressor operational data
  - Environmental conditions (ambient temperature, humidity)
  - CFD simulation results
  - Multiple test scenarios including steady-state and transient conditions
- **Duration:** Multiple test scenarios
- **Format:** CSV and simulation output files
- **Size:** ~100 MB
- **License:** CC BY 4.0
- **Collatr target sector:** Food & Bev (cold chain) / Pharma (cold storage)
- **Signals covered:** `room_temperature` (multiple zones), `compressor_state`, environmental conditions
- **Data quality notes:** Real experimental data with simulation validation. Focused on ultra-low temps (-80°C) rather than food manufacturing temps (-25 to +15°C), but the refrigeration dynamics and sensor patterns transfer well.
- **Relevance:** ★★★ — Good for understanding refrigeration system dynamics and multi-point temperature monitoring. The temperature ranges don't match food manufacturing cold rooms exactly, but compressor cycling patterns are applicable.

**⚠️ KEY FINDING — Food & Bev manufacturing data gap:** No public datasets found containing:
- Oven/baking line multi-zone temperature profiles with conveyor speeds
- Filling line data (fill weights per item, reject rates, line speed)
- CIP (Clean-in-Place) cycle data (temperature, flow, conductivity, chemical concentration)
- Mixing/blending batch process parameters
- Eurotherm-style temperature controller data
- BRC/food safety compliance monitoring data
- Checkweigher data streams

The food manufacturing industry is extremely protective of process data. BRC auditors see this data, but it's never published publicly. The Scorpion® profilers from Reading Thermal collect exactly the oven profile data we need, but it's proprietary to each bakery.

---

### Priority 3: Automotive / Aerospace (CNC / Machining)

**This is where Round 2 delivers the most value.** The CNC machining dataset landscape has expanded significantly since 2023–2025, driven by tool condition monitoring research.

#### R2-4. Bosch CNC Machining (Brownfield)

- **Source:** Bosch Research (GitHub)
- **URL:** https://github.com/boschresearch/CNC_Machining
- **What it contains:** Real-world industrial vibration data from brownfield CNC milling machines:
  - **3-axis accelerometer data** (Bosch CISS Sensor) at **2 kHz** sampling rate
  - Data from **3 different CNC milling machines** (M01, M02, M03)
  - **15 different machining processes** (OP00–OP14) per machine
  - Both **normal ("good") and anomalous ("bad")** labeled data
  - 6 timeframes spanning **Oct 2018 to Aug 2021** (~3 years)
- **Format:** HDF5 (.h5) files
- **Size:** ~1 GB
- **License:** CC BY 4.0 (data), BSD-3-Clause (code)
- **Collatr target sector:** Auto/Aero — CNC machining
- **Signals covered:** `vibration_X/Y/Z` (direct), `machine_state` (via anomaly labels), multi-machine cross-comparison
- **Data quality notes:** Real brownfield data from an actual Bosch manufacturing facility. The "brownfield" aspect is particularly relevant — this reflects machines already in production rather than lab setups. Labeled anomalies enable testing of fault detection. Multiple machines allow cross-machine transfer learning testing.
- **Relevance:** ★★★★ — Excellent real-world CNC data with the brownfield context matching our target customers. The 3-machine × 15-process structure maps well to a multi-CNC-machine monitoring scenario. However, only vibration data — no spindle load, feed rate, or axis position signals.

#### R2-5. Hannover Milling Tool Wear (Multivariate)

- **Source:** Leibniz University Hannover, Mendeley Data
- **URL:** https://data.mendeley.com/datasets/zpxs87bjt8/3
- **Paper:** https://www.sciencedirect.com/science/article/pii/S2352340923006741
- **What it contains:** Comprehensive labeled multivariate time series from CNC milling:
  - **Process forces** recorded with dynamometer at **25 kHz** (Fx, Fy, Fz)
  - **Spindle and feed drive torque/force** from machine tool controls at **500 Hz**
  - **Position control deviation** of feed drives at 500 Hz
  - **9 end milling cutters** worn from unused (VB ≈ 0 µm) to end-of-life (VB ≈ 150 µm)
  - **3 different 5-axis milling centres** (same type, different units)
  - Identical workpieces, setups, and process parameters across machines
  - **6,418 sample files**, each labeled with wear (VB), machine (M), tool (T), run (R), cumulated contact time (C)
- **Format:** HDF5 (.h5) with CSV metadata (filelist.csv)
- **Size:** ~10 GB
- **License:** CC BY 4.0
- **Collatr target sector:** Auto/Aero — CNC machining (Mettis, Sertec, ASG Group)
- **Signals covered:** `spindle_load` (via torque), `feed_rate` (via force/position), `vibration` (via force dynamics), `tool_life_remaining` (via VB wear labels), `machine_state` (tool lifecycle phases)
- **Data quality notes:** Exceptionally well-structured. The multi-machine design directly tests cross-machine monitoring — critical for Collatr's cross-site benchmarking use case. Wear labels at regular intervals provide ground truth for tool wear prediction. The combination of dynamometer forces (external sensor) and CNC controller signals (internal) allows testing both approaches.
- **Relevance:** ★★★★★ — The best CNC machining dataset found. Multi-machine, multi-tool, full lifecycle, with both external sensor data and internal CNC controller signals. Directly maps to the auto/aero customer profile signals. The 500 Hz internal signals (spindle torque, feed drive data) are particularly valuable — they match what CollatrEdge would collect via OPC-UA from a real CNC controller.

#### R2-6. QIT-CEMC End Milling Whole Life Cycle

- **Source:** Scientific Data (Nature), Qingdao Institute of Technology
- **URL:** https://www.nature.com/articles/s41597-024-04345-2
- **Data:** https://zenodo.org/records/13752756 (or Figshare)
- **What it contains:** Full lifecycle tool wear dataset for coated end mills machining Ti6Al4V:
  - **Cutting force and torque** via rotary dynamometer (direct measurement)
  - **3-axis vibration** (accelerometers)
  - **Sound** (microphone)
  - Complex **circumferential milling paths** (non-linear, realistic)
  - Multiple tools worn from new to end-of-life
  - Measured wear (VB) at regular intervals
- **Format:** CSV and MATLAB files
- **Size:** ~5 GB
- **License:** CC BY 4.0
- **Collatr target sector:** Auto/Aero — CNC machining (aerospace materials)
- **Signals covered:** `spindle_load` (via torque), cutting forces (3-axis), `vibration_X/Y/Z`, acoustic emission
- **Data quality notes:** Ti6Al4V (aerospace-grade titanium alloy) is exactly what Mettis Aerospace and similar targets machine. The circumferential milling paths generate periodic signals more representative of real parts than simple linear passes. Multi-modal (force + vibration + sound) is valuable.
- **Relevance:** ★★★★ — Directly relevant to aerospace machining targets. The Ti6Al4V material context makes this particularly credible for Mettis/ASG conversations. Complements the Hannover dataset by adding different cutting conditions and materials.

#### R2-7. PHM 2010 CNC Milling Challenge

- **Source:** PHM Society / IEEE DataPort
- **URL:** https://ieee-dataport.org/documents/2010-phm-society-conference-data-challenge
- **Alt URL:** https://www.kaggle.com/datasets/rabahba/phm-data-challenge-2010
- **What it contains:** Data from a high-speed CNC milling machine (Röders Tech RFM760):
  - **3-axis dynamometer** (cutting forces Fx, Fy, Fz)
  - **3-axis accelerometer** (vibration)
  - **Acoustic emission** sensor
  - **6 three-flute carbide cutters** (c1–c6) used until significant wear
  - **315 cutting cycles** per tool
  - Dry milling of stainless steel workpieces
- **Format:** CSV
- **Size:** ~500 MB
- **License:** Open/Academic
- **Collatr target sector:** Auto/Aero — high-speed CNC machining
- **Signals covered:** Cutting forces, `vibration_X/Y/Z`, acoustic emission
- **Data quality notes:** Industry-standard benchmark dataset with widespread use in tool wear research. Well-documented experimental conditions. Wear measurements provided for 3 training tools; 3 test tools require prediction (challenge format).
- **Relevance:** ★★★★ — Established benchmark. High-speed milling is directly relevant to auto/aero supply chain. 6 tools with run-to-failure provides good simulator variety. However, lacks CNC controller signals (spindle load, feed rate override) that CollatrEdge would typically collect.

#### R2-8. NUAA Ideahouse Tool Wear

- **Source:** NUAA (Nanjing University of Aeronautics and Astronautics), IEEE DataPort
- **URL:** https://ieee-dataport.org/open-access/tool-wear-dataset-nuaaideahouse
- **What it contains:** Tool wear data under **variable cutting conditions**:
  - **Vibration** signals
  - **Spindle current** and **power**
  - Both sidewall machining (fixed conditions) and closed pocket machining (varying conditions)
  - Variable cutting parameters, tool geometries, and workpiece materials
- **Format:** CSV
- **Size:** ~2 GB
- **License:** Open (IEEE DataPort)
- **Collatr target sector:** Auto/Aero — CNC machining under varying conditions
- **Signals covered:** `vibration`, `spindle_load` (via current/power), variable process parameters
- **Data quality notes:** The variable cutting conditions aspect is important — real manufacturing involves constant parameter changes. The spindle current and power signals map directly to what CollatrEdge would read from CNC controllers via OPC-UA.
- **Relevance:** ★★★★ — The variable condition focus fills a gap left by constant-condition datasets. Spindle current/power are realistic CNC monitoring signals.

#### R2-9. MU-TCM Face Milling (Mondragon Unibertsitatea)

- **Source:** Scientific Data (Nature), Mondragon Unibertsitatea
- **URL:** https://www.nature.com/articles/s41597-025-05168-5
- **Data:** Mondragon Unibertsitatea eBiltegia repository
- **What it contains:** Modern TCM dataset from a LAGUN L1000 CNC vertical machining centre:
  - **Internal CNC signals**: motor torque, current, power from spindle and feed axes (accessed from CNC controller)
  - **External signals**: 3-axis force (dynamometer), vibration (accelerometers)
  - **Multiple cutting conditions** and **materials** (steel grades)
  - Tool wear measurements at regular intervals
  - State-of-the-art milling cutters and workpiece materials
- **Format:** CSV/Parquet
- **Size:** ~3 GB
- **License:** CC BY 4.0
- **Collatr target sector:** Auto/Aero — CNC machining
- **Signals covered:** `spindle_load` (torque, current, power), `feed_rate` (via feed axis signals), `vibration_X/Y/Z`, cutting forces, `tool_life_remaining` (wear labels)
- **Data quality notes:** This is the most modern and comprehensive CNC dataset found. The explicit inclusion of **internal CNC signals** (motor torque, current, power from the controller) alongside external sensors is unique. Most datasets only have external sensors. The internal signals are exactly what CollatrEdge would read via OPC-UA or MTConnect.
- **Relevance:** ★★★★★ — The gold standard for CNC monitoring simulation. Internal CNC signals mapped to registers are precisely what CollatrEdge collects. Multiple cutting conditions and materials match the job-shop reality of auto/aero suppliers. Published in 2025 — the most recent and well-documented dataset available.

#### R2-10. Haas VF-1 Milling Tool Life Dataset

- **Source:** Scientific Data (Nature), Polish research team
- **URL:** https://www.nature.com/articles/s41597-025-04923-y
- **What it contains:** Data from a 3-axis Haas VF-1 milling machine:
  - **8 vibration sensors** at multiple locations on the machine
  - **12 current transformers** monitoring spindle and axis motor currents
  - **14 cutting tools** used from initial state until failure
  - **968 milling cycles** recorded
  - Raw and aggregated data available
- **Format:** CSV with raw and aggregated versions
- **Size:** ~2 GB
- **License:** CC BY 4.0
- **Collatr target sector:** Auto/Aero — CNC machining
- **Signals covered:** `vibration` (8 channels), `motor_current` (12 channels — spindle + axes), tool lifecycle
- **Data quality notes:** 14 tools to failure provides extensive degradation data. The 12 current transformer channels are particularly valuable — motor current monitoring via CT clamps is a common retrofit IIoT approach (mapped to Modbus registers). Haas machines are common in UK auto/aero job shops.
- **Relevance:** ★★★★ — The current transformer data directly maps to Modbus float32 registers from retrofit CT clamps. 14 tool lifecycles provide good statistical coverage. Haas VF-1 is a recognisable machine in our target customer base.

#### R2-1. Injection Molding Quality Prediction (iGuzzini)

- **Source:** GitHub (AIRT Lab, Università Politecnica delle Marche)
- **URL:** https://github.com/airtlab/machine-learning-for-quality-prediction-in-plastic-injection-molding
- **Paper:** https://www.mdpi.com/2078-2489/13/6/272
- **What it contains:** 1,451 injection molding shots from iGuzzini Illuminazione:
  - **13 process parameters per shot**: melt temperature, mould temperature, filling time, plasticizing time, cycle time, injection pressure (max, integral, at transfer), clamp force, cushion, injection speed, holding pressure
  - **Quality class label** per part (Good/Bad categorisation)
  - Data from 5 different production days (Sept 2019, Feb 2020, May 2020)
- **Format:** CSV (data.csv)
- **Size:** ~1 MB
- **License:** Open/Academic (cite paper)
- **Collatr target sector:** Auto/Aero — injection moulding (Nifco UK, Sertec)
- **Signals covered:** `barrel_temperature_zone_N` (melt temp), `mould_temperature`, `cycle_time`, `injection_pressure`, `clamp_force`, `shot_weight` (cushion proxy), `injection_speed`
- **Data quality notes:** Real production data from an operating factory. Per-shot (event-driven) data rather than continuous time series. The 5 production days provide day-to-day variability. Small but well-characterized with clear physical interpretability.
- **Relevance:** ★★★★ — Directly maps to the injection moulding signals in our customer profile. The 13 parameters cover most of the EUROMAP 77 data points. Per-shot nature matches how injection moulding data is typically logged. However, no continuous time series (no barrel temperature evolution over time within a cycle).

---

### Priority 4: Pharmaceutical / Life Sciences

#### R2-2. Pharma Tablet Compression Big Data Collection

- **Source:** Scientific Data (Nature), Lek Pharmaceuticals (Sandoz/Novartis)
- **URL:** https://www.nature.com/articles/s41597-022-01203-x
- **Data:** Zenodo or Figshare (linked from paper)
- **What it contains:** Comprehensive pharmaceutical manufacturing dataset:
  - **1,005 production batches** of a cholesterol-lowering medicine (film-coated tablets)
  - **Incoming raw material quality** data (excipient analysis: lactose, cellulose, starch)
  - **Tablet compression process time series**: tablet press speed, compaction force, fill depth — **recorded every second** of the manufacturing process
  - **Intermediate product testing** (tablet cores: weight, hardness, thickness, friability)
  - **Final product quality** testing results
  - **4 different product strengths**, 9 batch sizes
  - Data spans **November 2018 to April 2021** (~2.5 years)
- **Format:** CSV (exported from tablet press SQL database and laboratory databases)
- **Size:** ~500 MB
- **License:** CC BY 4.0
- **Collatr target sector:** Pharma — tablet press monitoring (Sterling Pharma Solutions, Bespak, Almac)
- **Signals covered:** `compression_force_main`, `turret_speed` (tablet press speed), `tablet_weight`, `tablet_hardness`, `tablet_thickness`, `feeder_speed` (fill depth), `tablets_produced`, `reject_count`
- **Data quality notes:** Real production data from a GMP-regulated pharmaceutical facility. The time series from the tablet press SQL database is gold — it's exactly what a CollatrEdge would pull from a tablet press via OPC-UA. 2.5 years of seasonal variation included. Raw material variability adds a realistic confounding factor.
- **Relevance:** ★★★★★ — **The single best pharma manufacturing dataset found.** Covers the full data chain from incoming materials through process time series to final product quality. The tablet press time series at 1-second resolution maps perfectly to OPC-UA polling. 1,005 batches provide statistical significance. This directly supports a pharma demo scenario.

#### R2-3. MSD Continuous Pharmaceutical Manufacturing

- **Source:** MSOM (Manufacturing & Service Operations Management), MSD/Merck
- **URL:** https://pubsonline.informs.org/doi/10.1287/msom.2024.0860
- **What it contains:** Data from a continuous tablet production setting at MSD:
  - **~300 million data points** across **~75 process parameters**
  - **120 hours** of continuous manufacturing
  - Parameters include: precompression force, main compression force, precompression displacement sigma, feeder speeds, tablet press speed, blend concentrations, granulator parameters
  - Data from the full continuous manufacturing train (feeder → blender → granulator → dryer → tablet press)
- **Format:** CSV
- **Size:** ~2 GB
- **License:** Academic (MSOM 2024 Data-Driven Research Challenge — registration required)
- **Collatr target sector:** Pharma — continuous manufacturing (advanced pharma)
- **Signals covered:** `compression_force_main`, `compression_force_pre`, `turret_speed`, `feeder_speed`, multiple process parameters across the manufacturing train
- **Data quality notes:** Exceptionally rich — 300 million data points from continuous manufacturing. This is the state of the art in pharma manufacturing data publication. The continuous manufacturing context (vs. traditional batch) is increasingly relevant. Access may require challenge registration.
- **Relevance:** ★★★★★ — Unparalleled in scope and quality for pharma manufacturing. 75 parameters over 120 continuous hours is far more data than typically available from pharma. The continuous manufacturing setting matches the industry trajectory. The main caveat is access restrictions.

#### R2-14. Biopharmaceutical Manufacturing Batch Data

- **Source:** Kaggle
- **URL:** https://www.kaggle.com/datasets/stephengoldie/big-databiopharmaceutical-manufacturing
- **What it contains:** 100 batches of biopharmaceutical manufacturing data:
  - **On-line sensor data** (process parameters during manufacturing)
  - **Off-line lab results** (quality testing)
  - **Raman spectroscopy** data (process analytical technology / PAT)
  - Batch process data typical of bioreactor operations
- **Format:** CSV
- **Size:** ~200 MB
- **License:** Open (Kaggle)
- **Collatr target sector:** Pharma — batch reactor monitoring
- **Signals covered:** `reactor_temperature`, `agitator_speed`, `pH`, `dissolved_oxygen`, `batch_phase`, process analytical technology (Raman)
- **Data quality notes:** Biopharmaceutical (not small molecule) manufacturing, which is a different process from our primary pharma targets. However, the batch reactor monitoring patterns (temperature profiles, agitation, pH, DO) are similar to chemical API manufacturing. Raman data adds a PAT dimension.
- **Relevance:** ★★★★ — Good batch process reactor data that maps to the chemical reactor signals in our pharma customer profile. The on-line/off-line data combination mirrors real pharma data workflows. 100 batches provides reasonable statistical coverage.

**Partial gap — Pharma environmental monitoring:** No public dataset found with continuous cleanroom monitoring data (temperature, humidity, differential pressure, particle counts). Pharmaceutical companies classify this data as GxP-regulated and never publish it. The SWaT water treatment dataset (Round 1) is the closest analogue in terms of sensor types and regulatory monitoring requirements.

---

### Priority 5: General Production / OEE

#### R2-11. AI4I 2020 Predictive Maintenance

- **Source:** UCI Machine Learning Repository
- **URL:** https://archive.ics.uci.edu/dataset/601/ai4i+2020+predictive+maintenance+dataset
- **Alt URL:** https://www.kaggle.com/datasets/stephanmatzka/predictive-maintenance-dataset-ai4i-2020
- **What it contains:** Synthetic dataset reflecting real predictive maintenance data:
  - **10,000 data points** with 6 features
  - **Air temperature** [K], **process temperature** [K], **rotational speed** [rpm], **torque** [Nm], **tool wear** [min]
  - **Machine failure** label with 5 independent failure modes: tool wear failure, heat dissipation failure, power failure, overstrain failure, random failure
  - 3 product quality types (L/M/H)
- **Format:** CSV
- **Size:** ~0.5 MB
- **License:** CC BY 4.0
- **Collatr target sector:** General manufacturing
- **Signals covered:** `motor_speed` (rotational speed), `motor_torque`, `process_temperature`, `machine_state` (failure modes)
- **Data quality notes:** Synthetic but physically modelled — failure modes are based on real physics (e.g., heat dissipation = f(temp_diff, speed)). Clean, no missing values. Small enough to iterate quickly. The 5 failure modes map to different "fault" states in a machine state model.
- **Relevance:** ★★★ — Useful as a quick reference for machine failure patterns. The temperature-speed-torque-wear combination is a simplified version of what any rotating machinery produces. However, synthetic nature limits realism, and event-based (not continuous time series) format is a limitation.

---

## Gap Analysis

### What we STILL can't find public datasets for

| Gap | Severity | Target Sector | Why It's Missing | Mitigation |
|-----|----------|--------------|-----------------|------------|
| **Flexographic press data** (line speed, web tension, registration, dryer temps, impression counts) | 🔴 CRITICAL | Packaging/Printing | Highly proprietary; press manufacturers (BOBST, W&H, Soma) don't publish; no academic research in this area focuses on process data | **Must build custom simulator** — use web tension dynamics from R2R research + control loop patterns from DAMADICS (Round 1) |
| **Packaging line OEE** (machine state transitions, good/waste counts, changeover events) | 🔴 CRITICAL | Packaging/Printing | No manufacturer publishes this; OEE data is considered competitive intelligence | **Must synthesize** — use machine state models with realistic transition probabilities derived from industry benchmarks (world-class OEE = 85%, typical = 60%) |
| **Baking/oven multi-zone temperatures** with conveyor speed | 🔴 HIGH | Food & Bev | Scorpion® profiler data is proprietary; bakery process data is trade secret | **Must synthesize** — use Eurotherm register patterns from DAMADICS + thermal dynamics from power plant data (Round 1) |
| **Filling line data** (fill weight per item, reject rates, seal temperature) | 🔴 HIGH | Food & Bev | Checkweigher vendors (Mettler Toledo, Ishida) don't publish; per-item data is competitive | **Must synthesize** — use statistical process control theory (normal distribution with drift + occasional step changes) |
| **CIP cycle data** (temperature, flow, conductivity phases) | 🟡 MEDIUM | Food & Bev | CIP is a multi-step sequence; no public process data found | **Must synthesize** — the SWaT dataset (Round 1) provides analogous multi-phase water treatment process data to model on |
| **Cleanroom environmental monitoring** (temp, humidity, ΔP, particle counts) | 🟡 MEDIUM | Pharma | GxP-regulated data; pharmaceutical companies never publish | **Partially mitigate** with Appliances Energy data (Round 1) for temp/humidity patterns + synthesize ΔP and particles |
| **Vacuum furnace heat treatment** (temperature profiles, vacuum levels, quench data) | 🟡 MEDIUM | Auto/Aero | No public datasets; Nadcap data is classified | **Must synthesize** — use Eurotherm register patterns + thermal ramp/soak/quench models from metallurgy literature |
| **Stamping press tonnage** (per-stroke force, die temperature) | 🟡 MEDIUM | Auto/Aero | Academic research exists but datasets are not published | **Must synthesize** — periodic force waveforms + slow drift patterns for die wear |
| **Energy per-machine** (real-time kW per individual machine on a production line) | 🟢 LOW | Cross-sector | Steel Energy dataset (Round 1) provides partial coverage; per-machine granularity is rare | Steel dataset + synthetic per-machine disaggregation |
| **Coding/marking equipment** (ink levels, print head temp, fault codes) | 🟢 LOW | Packaging/Printing | Domino/Videojet don't publish; niche equipment | **Must synthesize** — simple consumable depletion curves + random fault events |

### Coverage Summary by Sector

| Sector | Signal Coverage from Public Datasets | Assessment |
|--------|-------------------------------------|------------|
| **Packaging/Printing** | ≤5% — only a tangential R2R tension reference | 🔴 Almost entirely needs custom simulation |
| **Food & Bev** | ~10% — cold chain temps, some refrigeration dynamics | 🔴 Mostly needs custom simulation |
| **Auto/Aero (CNC)** | ~70% — excellent coverage of vibration, forces, motor current, tool wear | 🟢 Well-covered; ready for simulator build |
| **Auto/Aero (IM)** | ~40% — one good injection moulding dataset, but per-shot not continuous | 🟡 Partial; needs supplementary synthesis |
| **Pharma (tablet)** | ~60% — two excellent tablet press datasets with time series | 🟢 Good coverage for tablet compression |
| **Pharma (env)** | ≤5% — no cleanroom monitoring data found | 🔴 Needs custom simulation |
| **Pharma (reactor)** | ~30% — batch bioreactor data available; chemical reactor less covered | 🟡 Partial; TEP (Round 1) fills chemical process gap |
| **Process Manufacturing** | ~20% — some energy data; no glass/sugar/flooring specific data | 🟡 Mixed; sector-specific needs synthesis |
| **General OEE/States** | ~15% — AI4I provides simplified version; real OEE data almost non-existent | 🔴 Machine state models need synthesis |

---

## Recommended Simulator Design

### Architecture: Layered Real + Synthetic Approach

Based on both rounds of research, the recommended approach is a **layered simulator** that combines real dataset replay with synthetic generation:

```
Layer 1: REAL DATA REPLAY
├── CNC Machine Cell          ← Hannover (R2-5) + Bosch (R2-4) + MU-TCM (R2-9)
├── Compressor/Hydraulics     ← SKAB + MetroPT + Hydraulic Systems (Round 1)
├── Process Control Loops     ← DAMADICS + GIMSCOP (Round 1)
├── Tablet Press              ← Pharma Big Data (R2-2) + MSD (R2-3)
└── Energy Monitoring         ← Steel Industry (Round 1)

Layer 2: SYNTHETIC GENERATION (physics-based)
├── Flexographic Press        ← Model from control theory + web dynamics
├── Laminator / Slitter       ← Derived from press model, simpler dynamics
├── Baking Oven               ← Thermal dynamics + zone control model
├── Filling Line              ← Statistical process control + counting
├── Cold Room / Refrigeration ← Compressor cycling + door event model
├── CIP System                ← Sequential phase model
├── Cleanroom Environment     ← HVAC dynamics + pressure cascade model
├── Vacuum Furnace            ← Thermal ramp/soak/quench model
└── Injection Moulder         ← Extended from iGuzzini (R2-1) with cycle model

Layer 3: UNIVERSAL OVERLAY (applies to all machines)
├── Machine State Transitions ← Markov chain: Running→Idle→Setup→Fault→Maintenance
├── Production Counters       ← Good/waste/total with realistic ratios
├── Energy per Machine        ← Base load + proportional to speed/output
├── Fault Events              ← Random with realistic MTBF distributions
├── Shift Patterns            ← 3-shift, 5-day pattern with shift quality variation
└── Noise & Imperfections     ← Communication drops, sensor drift, outlier spikes
```

### Phase 1: Packaging Production Line Demo (40 Signals)

The demo dataset spec in the customer profiles doc requires 40 signals from a packaging production line. Here's how to source each one:

| Signal | Data Source Strategy |
|--------|---------------------|
| `press.line_speed` | **Synthetic** — ramp-up/steady-state/ramp-down profiles based on web dynamics literature |
| `press.web_tension` | **Synthetic** — tension control loop model (reference: R2R research papers, web tension dynamics from IntechOpen chapter) |
| `press.registration_error_x/y` | **Synthetic** — correlated with speed changes + random drift; bounded ±0.5mm |
| `press.ink_viscosity` | **Synthetic** — slow drift with temperature correlation; excursions tied to refills |
| `press.ink_temperature` | **Synthetic** — ambient-correlated with process heat; range 18–35°C |
| `press.dryer_temp_zone_1/2/3` | **Hybrid** — use DAMADICS (Round 1) temperature controller dynamics for PV/SP/OP patterns; zone-to-zone correlation |
| `press.dryer_setpoint_zone_1/2/3` | **Synthetic** — step changes at job changeovers |
| `press.impression/good/waste_count` | **Synthetic** — counters derived from line speed × time; waste correlated with registration error excursions |
| `press.machine_state` | **Synthetic** — Markov chain with realistic transition probabilities and durations |
| `press.main_drive_current/speed` | **Hybrid** — use Paderborn bearing dataset (Round 1) motor current patterns; speed correlated with line_speed |
| `press.nip_pressure` | **Synthetic** — steady-state with slow drift |
| `press.unwind/rewind_diameter` | **Synthetic** — linear decrease/increase correlated with speed; step changes at reel changes |
| `laminator.*` | **Synthetic** — derived from press model with simpler dynamics |
| `slitter.*` | **Synthetic** — high-speed variant of press model |
| `coder.*` | **Synthetic** — simple state machine with consumable depletion curves |
| `env.ambient_temp/humidity` | **Replay** — Appliances Energy dataset (Round 1) provides real temp/humidity patterns |
| `energy.line_power/kwh` | **Hybrid** — Steel Industry dataset (Round 1) patterns scaled to packaging line; kWh is integral of power |
| `vibration.main_drive_x/y/z` | **Replay** — SKAB (Round 1) or Bosch CNC (R2-4) vibration data, downsampled; trending for degradation from IMS bearing (Round 1) |

### Phase 2: Food & Bev Overlay

Extend the packaging simulator by adding:
- Multi-zone oven temperatures (Eurotherm register model from DAMADICS)
- Fill weight statistical process control (Gaussian with drift)
- Cold room monitoring (refrigeration cycling from ULT dataset R2-13)
- CIP cycle state machine (modeled on SWaT phase transitions, Round 1)

### Phase 3: CNC Machine Monitoring

This phase has the best real data coverage:
- **Primary replay:** Hannover dataset (R2-5) — spindle/feed drive signals at 500 Hz downsampled to 1s
- **Supplementary:** Bosch CNC (R2-4) for cross-machine patterns
- **Internal CNC signals:** MU-TCM (R2-9) for realistic motor torque/current from CNC controller
- **Add synthetic:** Part counter, machine state enum, cycle time, program name
- **Tool wear trending:** All datasets provide wear progression data — generate tool_life_remaining signal

### Phase 4: Pharma Environmental + Tablet Press

- **Tablet press:** Direct replay from Pharma Big Data (R2-2) — 1s time series of compression force, speed, etc.
- **Cleanroom:** Synthetic — temperature/humidity based on Appliances Energy patterns (Round 1), with tighter control bands (±0.5°C instead of ±2°C); differential pressure as a slow-varying setpoint-tracking signal; particle counts as Poisson process with rare excursions
- **Water system:** Synthetic — conductivity + TOC as slow-varying quality signals

### Key Design Principles

1. **Realistic imperfections matter more than perfection.** Include communication drops (5s gaps every few hours), sensor noise, counter rollovers, and slow drift. These test CollatrEdge's robustness.

2. **Correlated signals trump isolated signals.** When line speed increases, motor current increases, web tension fluctuates, dryer temps change, and waste increases slightly. Model these correlations.

3. **Time compression is essential.** A 90-day dataset at full resolution is 4.5 GB. Support 1×, 10×, 100×, and 1000× playback speeds.

4. **Register mapping should be explicit.** Each simulated signal should map to a specific Modbus register or OPC-UA node, with documented data type, byte order, and scaling. This makes the simulator output directly usable for CollatrEdge integration testing.

5. **The demo must tell a story.** Within the 40-signal packaging line, embed a sequence of realistic events: shift changes, job changeovers, an ink viscosity excursion, a gradual bearing wear trend, a web break, and an energy spike on cold start. These become the "aha moments" in the demo.

---

## Appendix: Datasets from Round 1 Re-evaluated for Sector Fit

These Round 1 datasets map to specific sectors better than initially assessed:

| Round 1 Dataset | Best Sector Fit | Why |
|----------------|----------------|-----|
| **SKAB** | Cross-sector (pressure, temp, flow) | 8 sensors = small production cell monitoring |
| **DAMADICS** | Food & Bev (sugar factory) + Packaging | Real sugar factory data; control valve patterns apply to any process industry |
| **Tennessee Eastman** | Process Manufacturing (chemical) + Pharma (API reactor) | 52 variables from chemical process; closest proxy for batch reactor monitoring |
| **MetroPT** | Cross-sector (compressor monitoring) | Mixed analog/digital signals from compressor; applies to compressed air systems in any factory |
| **IMS/NASA Bearing** | Packaging/Printing (main drive bearings) + Auto/Aero (spindle bearings) | Long-duration vibration degradation data applicable to any rotating machinery |
| **Steel Industry Energy** | Cross-sector (energy monitoring) | Per-machine energy data patterns apply across all manufacturing |
| **Hydraulic Systems** | Auto/Aero (hydraulic presses) + Process Manufacturing | Hydraulic press monitoring; relevant to stamping, injection moulding |
| **SWaT** | Food & Bev (CIP proxy) + Pharma (water systems) | Multi-phase water treatment process mirrors CIP and WFI system monitoring |

---

*Research conducted 2026-02-25. Searches covered Kaggle, UCI ML Repository, IEEE DataPort, Zenodo, Mendeley Data, GitHub, Nature Scientific Data, MSOM/INFORMS, academic paper repositories, and equipment manufacturer sources. All URLs verified at time of research.*
