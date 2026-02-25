# Real-World Industrial Datasets for CollatrEdge Testing & Simulation

> **Purpose:** Catalogue freely available, real-world (or high-fidelity simulated) industrial datasets that can drive realistic data-replay simulators for testing CollatrEdge, an industrial IoT data collection agent.
>
> **Companion document:** [research-public-datasources-for-test-and-demo.md](./research-public-datasources-for-test-and-demo.md) — covers live public OPC-UA/Modbus servers and simulators.
>
> **Last updated:** 2026-02-25

---

## Summary Table

| # | Dataset | Category | Sensors / Variables | Duration | Format | Size | License | Relevance |
|---|---------|----------|-------------------|----------|--------|------|---------|-----------|
| 1 | [Condition Monitoring of Hydraulic Systems](#1-condition-monitoring-of-hydraulic-systems) | Process / PdM | 17 sensors (pressure, flow, temp, vibration, motor power) | 2,205 cycles × 60s | Tab-delimited TXT | 73 MB | CC BY 4.0 | ★★★★★ |
| 2 | [Petrobras 3W Oil Well Dataset](#2-petrobras-3w-oil-well-dataset) | Oil & Gas Process | 8 sensors per well (pressure, temp, flow, density) | Varies per well; 1,984 instances total | CSV/Parquet | ~2 GB | Apache 2.0 / CC BY 4.0 | ★★★★★ |
| 3 | [Tennessee Eastman Process (TEP)](#3-tennessee-eastman-process-tep) | Chemical Process | 52 variables (22 continuous + 19 composition + 12 manipulated) | 500 samples per run × 22 runs | DAT/CSV | ~150 MB | Open/Academic | ★★★★★ |
| 4 | [NASA C-MAPSS Turbofan Degradation](#4-nasa-c-mapss-turbofan-engine-degradation) | PdM / Prognostics | 21 sensors per engine + 3 operating conditions | 100–400 cycles per unit; 4 subsets | TXT | ~35 MB | Public Domain (NASA) | ★★★★ |
| 5 | [CWRU Bearing Fault Data](#5-cwru-bearing-fault-dataset) | Condition Monitoring | Vibration accelerometer (drive end, fan end, base) | Short recordings per condition; 12k/48k Hz | MATLAB (.mat) | ~600 MB | Open/Academic | ★★★★ |
| 6 | [IMS/NASA Bearing Dataset](#6-imsnasa-bearing-run-to-failure-dataset) | Condition Monitoring | 4 bearings × 2 accelerometers; 20 kHz | 3 test sets; 35 days continuous | ASCII/CSV | ~6 GB | Public Domain (NASA) | ★★★★★ |
| 7 | [FEMTO/PRONOSTIA Bearing](#7-femtopronostia-bearing-accelerated-life) | Condition Monitoring | Vibration (2 acc.) + temperature; 25.6 kHz | 17 bearings, varied run lengths | CSV | ~2 GB | Public Domain (NASA) | ★★★★ |
| 8 | [Paderborn University Bearing](#8-paderborn-university-bearing-dataset) | Condition Monitoring | Vibration + motor current; 64 kHz | 32 bearings, 4 operating conditions | MATLAB (.mat) | ~20 GB | Open/Academic | ★★★★ |
| 9 | [SKAB – Skoltech Anomaly Benchmark](#9-skab--skoltech-anomaly-benchmark) | IIoT Benchmark | 8 sensors (vibration, current, pressure, temp, flow, voltage) | 35 experiments | CSV | ~50 MB | IDSSL | ★★★★★ |
| 10 | [CNC Mill Tool Wear](#10-cnc-mill-tool-wear-dataset) | Manufacturing | 48 signals (force, vibration, AE, current) per pass | 18 experiments, ~50 passes each | CSV | ~500 MB | Open (Kaggle) | ★★★★ |
| 11 | [NASA Milling Wear](#11-nasa-milling-wear-dataset) | Manufacturing | 6 signals (force, vibration, AE) at varied speeds/feeds | 16 cases × multiple cuts | MATLAB (.mat) | ~150 MB | Public Domain (NASA) | ★★★ |
| 12 | [DAMADICS Actuator Benchmark](#12-damadics-actuator-benchmark) | Process Control | 32 signals (pressure, flow, temp, valve, actuator) at 1 Hz | 25 days continuous | MAT / CSV (Kaggle) | ~100 MB | Open/Academic | ★★★★★ |
| 13 | [SECOM Semiconductor Process](#13-secom-semiconductor-manufacturing-dataset) | Manufacturing Quality | 590 sensor features per wafer | 1,567 instances | CSV | ~20 MB | CC BY 4.0 | ★★★ |
| 14 | [Bosch Production Line](#14-bosch-production-line-performance) | Manufacturing Quality | 4,264 features (numerical + categorical + date) | 1,184,687 parts | CSV | 14.3 GB | Kaggle Competition | ★★★ |
| 15 | [Combined Cycle Power Plant](#15-combined-cycle-power-plant) | Energy / Power Gen | 4 ambient variables + 1 output (MW) | 9,568 hourly points over 6 years | XLSX/CSV | ~0.5 MB | CC BY 4.0 | ★★★ |
| 16 | [Steel Industry Energy Consumption](#16-steel-industry-energy-consumption) | Energy / Industrial | 10 variables (power, reactive power, CO₂, power factor, load type) | 35,040 15-min samples (~1 year) | CSV | ~3 MB | CC BY 4.0 | ★★★★ |
| 17 | [SWaT – Secure Water Treatment](#17-swat--secure-water-treatment-dataset) | Water Treatment / CPS | 51 sensors + actuators (flow, level, pressure, pH, conductivity) | 11 days (7 normal + 4 attack) at 1s | CSV | ~1 GB | Academic (request) | ★★★★ |
| 18 | [WADI – Water Distribution](#18-wadi--water-distribution-dataset) | Water Distribution | 123 sensors and actuators | 16 days at 1s | CSV | ~1.5 GB | Academic (request) | ★★★★ |
| 19 | [BATADAL – Water Network Attacks](#19-batadal--water-network-attack-detection) | Water Distribution | 43 sensors (tank levels, pressures, flows, pump/valve states) | ~1 year hourly | CSV | ~10 MB | Open | ★★★★ |
| 20 | [Kelmarsh Wind Farm SCADA](#20-kelmarsh-wind-farm-scada) | Energy / Wind | ~99 variables per turbine × 6 turbines (power, wind, temp, pitch, yaw) | 5 years at 10-min | CSV | ~2 GB | CC BY 4.0 | ★★★★ |
| 21 | [Pump Sensor Data](#21-pump-sensor-data) | Industrial PdM | 52 sensor signals + machine status | 220,320 rows at ~1 min | CSV | ~120 MB | Open (Kaggle) | ★★★★ |
| 22 | [MetroPT – Metro Air Production Unit](#22-metropt--metro-air-production-unit) | Transport PdM | 15 signals (analog pressure/temp/current + digital + GPS) | 6 months, 1s resolution | CSV/Parquet | ~1.5 GB | CC BY 4.0 | ★★★★★ |
| 23 | [Gas Sensor Array Drift](#23-gas-sensor-array-drift-dataset) | Chemical Sensors | 16 MOX sensors × 8 features each (128 total) | 36 months; 13,910 measurements | DAT | ~20 MB | CC BY 4.0 | ★★★ |
| 24 | [Control Loop Datasets (GIMSCOP)](#24-control-loop-datasets-gimscop) | Process Control | SISO control loops (SP, PV, OP); multiple loops | 2.5 days of raw data; multiple loop datasets | CSV | ~50 MB | Open/Academic | ★★★★ |
| 25 | [Numenta Anomaly Benchmark (NAB)](#25-numenta-anomaly-benchmark-nab) | IIoT Benchmark | 58 univariate time series (machine temp, CPU, traffic, etc.) | Varies (1K–22K points each) | CSV | ~20 MB | AGPL-3.0 | ★★★ |
| 26 | [APS Failure at Scania Trucks](#26-aps-failure-at-scania-trucks) | Automotive PdM | 170 anonymized sensor features | 76,000 records (train + test) | CSV | ~50 MB | CC BY 4.0 | ★★★ |
| 27 | [Modbus/ICS Network Captures](#27-modbusics-network-pcap-captures) | ICS Protocol | Modbus TCP packet captures, normal + attack traffic | Varied | PCAP | ~1 GB combined | Various open | ★★★ |
| 28 | [Appliances Energy Prediction](#28-appliances-energy-prediction) | Building Energy / IoT | 29 variables (temp, humidity × 9 rooms + weather + energy) | 4.5 months at 10-min | CSV | ~5 MB | CC BY 4.0 | ★★★ |

---

## Detailed Dataset Descriptions

### Category 1: Industrial Process Datasets

#### 1. Condition Monitoring of Hydraulic Systems

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/447/condition+monitoring+of+hydraulic+systems  
- **What it contains:** Multi-sensor data from a hydraulic test rig consisting of a primary working circuit and secondary cooling-filtration circuit. The system performs 60-second load cycles, measuring:
  - 6 pressure sensors (PS1–PS6) at 100 Hz  
  - 1 motor power sensor (EPS1) at 100 Hz  
  - 2 volume flow sensors (FS1, FS2) at 10 Hz  
  - 4 temperature sensors (TS1–TS4) at 1 Hz  
  - 1 vibration sensor (VS1) at 1 Hz  
  - 3 virtual sensors (cooling efficiency, cooling power, efficiency factor) at 1 Hz  
- **Duration:** 2,205 load cycles  
- **Format:** Tab-delimited text files, one per sensor type  
- **Size:** 73.1 MB (20 files)  
- **License:** CC BY 4.0  
- **Data quality:** No missing values. Four fault conditions (cooler, valve, pump leakage, accumulator) with multiple severity grades. Includes stable/unstable flag.  
- **CollatrEdge relevance:** ★★★★★ — This is a near-perfect match. Multi-rate sensor data (100 Hz, 10 Hz, 1 Hz) maps directly to Modbus holding registers. Pressure, flow, temperature, and vibration are the bread and butter of industrial monitoring. Different fault severities provide realistic degradation patterns. Can drive a simulator with correlated multi-sensor outputs where faults cause cross-sensor effects.

---

#### 2. Petrobras 3W Oil Well Dataset

- **Source:** Petrobras (GitHub)  
- **URL:** https://github.com/petrobras/3W  
- **What it contains:** The first realistic, public dataset of rare undesirable events in offshore oil wells. Sensor data from real production wells including:
  - Pressure (downhole, annular, production)
  - Temperature (downhole, annular)
  - Flow rate, density
  - Various well operating parameters
- **Coverage:** 1,984 labeled instances from 3 sources: real events, simulated events, hand-drawn events. Covers 8 event types (e.g., abrupt BSW increase, flow instability, severe slugging, rapid productivity loss).
- **Duration:** Real events collected 2012–2018 from 21 wells  
- **Format:** CSV and Parquet  
- **Size:** ~2 GB  
- **License:** Apache 2.0 (code), CC BY 4.0 (data)  
- **Data quality:** Real production data with actual anomalies. Contains NaNs, gaps, and sensor noise typical of subsea instrumentation. Labeled with event types and timestamps.
- **CollatrEdge relevance:** ★★★★★ — Oil and gas is a prime CollatrEdge target market. Real pressure/temperature/flow data with genuine anomalies. Multi-variate time series with noise and gaps makes for excellent simulator input. Event labels allow testing anomaly-pattern replay.

---

#### 3. Tennessee Eastman Process (TEP)

- **Source:** Kaggle / IEEE DataPort / Harvard Dataverse  
- **URL:** https://www.kaggle.com/datasets/averkij/tennessee-eastman-process-simulation-dataset  
- **What it contains:** Simulated data from a realistic chemical process (based on actual Eastman Chemical plant) with:
  - 22 continuous process measurements (temperatures, pressures, flows, levels, compositions)
  - 19 composition measurements
  - 12 manipulated variables (valve positions, setpoints)
  - 21 different fault types + normal operation
- **Duration:** 500 samples per simulation run (3-minute sample rate), 22 simulation sets for training and 22 for testing  
- **Format:** DAT text files (space-delimited), also available as CSV on Kaggle  
- **Size:** ~150 MB  
- **License:** Open academic use  
- **Data quality:** High-fidelity simulation with realistic noise, coupling, and nonlinear dynamics. Industry gold standard for fault detection research since 1993.
- **CollatrEdge relevance:** ★★★★★ — The benchmark dataset for chemical process control. 52 variables map perfectly to Modbus/OPC-UA registers. 21 fault types provide rich testing scenarios. Correlated multi-variable behaviour is exactly what a real plant looks like. Use this to build a "virtual chemical plant" simulator.

---

#### 4. NASA C-MAPSS Turbofan Engine Degradation

- **Source:** NASA Prognostics Data Repository  
- **URL:** https://phm-datasets.s3.amazonaws.com/NASA/6.+Turbofan+Engine+Degradation+Simulation+Data+Set.zip  
- **Alt URL:** https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data  
- **What it contains:** Run-to-failure simulation of turbofan engines using the Commercial Modular Aero-Propulsion System Simulation (C-MAPSS). Each engine unit has:
  - 3 operational settings
  - 21 sensor readings (temperatures, pressures, speeds, ratios, flow rates)
  - Engines start healthy and degrade to failure
- **Subsets:**  
  - FD001: 100 engines, 1 condition, 1 fault mode  
  - FD002: 260 engines, 6 conditions, 1 fault mode  
  - FD003: 100 engines, 1 condition, 2 fault modes  
  - FD004: 248 engines, 6 conditions, 2 fault modes  
- **Format:** Space-delimited text  
- **Size:** ~35 MB  
- **License:** Public Domain (NASA)  
- **Data quality:** Clean simulation data with realistic degradation trends. No missing values, but sensor noise is realistic. Some sensors are nearly constant (useful for testing that CollatrEdge handles low-variability channels).
- **CollatrEdge relevance:** ★★★★ — Excellent for testing degradation trend detection. 21 sensors with different behaviours (some trending, some noisy, some nearly constant) give a great range of register types. Multiple engines allow replay of many different degradation scenarios.

---

### Category 2: Predictive Maintenance / Condition Monitoring

#### 5. CWRU Bearing Fault Dataset

- **Source:** Case Western Reserve University Bearing Data Center  
- **URL:** https://engineering.case.edu/bearingdatacenter  
- **What it contains:** Vibration data from a 2 HP Reliance Electric motor with seeded bearing faults:
  - Drive end accelerometer (12 kHz and 48 kHz)
  - Fan end accelerometer (12 kHz)
  - Base accelerometer
  - Fault types: inner race, outer race, ball; fault diameters: 0.007", 0.014", 0.021", 0.028"
  - Motor loads: 0–3 HP  
- **Format:** MATLAB (.mat) files; also available in NumPy format on GitHub  
- **Size:** ~600 MB  
- **License:** Open academic use  
- **Data quality:** Clean lab-controlled data. Short recordings per condition (not continuous time series). Widely used benchmark — over 3,000 citations.
- **CollatrEdge relevance:** ★★★★ — High-frequency vibration data can be downsampled and replayed as if coming from a vibration monitoring unit. Different fault types and severities allow building rich test scenarios. However, short recordings mean you need to loop or stitch for continuous simulation.

---

#### 6. IMS/NASA Bearing Run-to-Failure Dataset

- **Source:** Center for Intelligent Maintenance Systems, University of Cincinnati; hosted by NASA  
- **URL:** https://phm-datasets.s3.amazonaws.com/NASA/4.+Bearings.zip  
- **What it contains:** Run-to-failure experiments on Rexnord ZA-2115 bearings:
  - 4 bearings on a loaded shaft (6,000 lb radial load, 2,000 RPM)
  - 2 accelerometers per bearing (x and y axis)
  - 20,480 data points per file at 20 kHz sample rate
  - 3 test sets: Set 1 (34 days), Set 2 (9 days), Set 3 (~6 days)
  - Files recorded every 10 minutes (1-second snapshots)
- **Format:** ASCII text files, one per recording  
- **Size:** ~6 GB  
- **License:** Public Domain (NASA)  
- **Data quality:** Real run-to-failure data with genuine degradation signatures. Bearing 3 in Set 1 showed outer race failure; Bearing 1 showed inner race failure. Natural noise, no synthetic cleanliness.
- **CollatrEdge relevance:** ★★★★★ — Real, long-duration run-to-failure data. The 10-minute recording cadence mimics how a real SCADA/IIoT system would poll vibration data. Perfect for testing trending and degradation detection. Replay this as periodic vibration snapshots in a simulator.

---

#### 7. FEMTO/PRONOSTIA Bearing Accelerated Life

- **Source:** FEMTO-ST Institute, Besançon, France; hosted by NASA  
- **URL:** https://phm-datasets.s3.amazonaws.com/NASA/10.+FEMTO+Bearing.zip  
- **What it contains:** Accelerated degradation tests on bearings:
  - 2 accelerometers (horizontal, vertical) at 25.6 kHz
  - 1 temperature sensor
  - 17 bearings across 3 operating conditions (load/speed combinations)
  - 6 training bearings (full run-to-failure) + 11 test bearings (truncated)
- **Format:** CSV files  
- **Size:** ~2 GB  
- **License:** Public Domain (NASA)  
- **Data quality:** Accelerated life test — bearings fail faster than in the field, but the degradation physics is real. Temperature data adds a correlated slow variable to the fast vibration data.
- **CollatrEdge relevance:** ★★★★ — Multi-sensor (vibration + temperature) makes for richer simulation than vibration-only datasets. Accelerated failure means shorter test scenarios. Good for testing CollatrEdge's handling of mixed-rate data.

---

#### 8. Paderborn University Bearing Dataset

- **Source:** Chair of Design and Drive Technology (KAt), Paderborn University, Germany  
- **URL:** https://mb.uni-paderborn.de/en/kat/research/bearing-datacenter/data-sets-and-download  
- **What it contains:** Bearing condition monitoring data including **both vibration and motor current signals**:
  - Vibration signal at 64 kHz
  - Motor current signal at 64 kHz
  - 32 bearings: 6 healthy, 12 with artificial damage, 14 with accelerated lifetime damage (real wear)
  - 4 operating conditions: {1500 RPM, 900 RPM} × {0.7 Nm, 0.1 Nm load} + radial force variations
- **Format:** MATLAB (.mat) files  
- **Size:** ~20 GB  
- **License:** Open academic use (cite paper)  
- **Data quality:** Exceptionally well-documented with damage fact sheets per bearing. Combination of artificial and real-wear damage. Motor current data is a unique addition — most bearing datasets only have vibration.
- **CollatrEdge relevance:** ★★★★ — The motor current signal is important — many industrial IoT deployments monitor current (via CT clamps) rather than installing accelerometers. This dataset lets us build a simulator that outputs both vibration and electrical signals, which maps to different Modbus register banks.

---

#### 9. SKAB – Skoltech Anomaly Benchmark

- **Source:** Skoltech (Skolkovo Institute of Science and Technology)  
- **URL:** https://github.com/waico/SKAB  
- **Alt URL:** https://www.kaggle.com/datasets/yuriykatser/skoltech-anomaly-benchmark-skab  
- **What it contains:** Data from an industrial water circulation testbed with:
  - Accelerometer1RMS, Accelerometer2RMS (vibration, g)
  - Current (motor amperage, A)
  - Pressure (bar)
  - Temperature (engine body, °C)
  - Thermocouple (fluid temperature, °C)
  - Voltage (motor, V)
  - RateRMS (flow rate, L/min)
  - Labels: anomaly (0/1) and changepoint (0/1)
- **Duration:** 35 experiments, each a single anomaly scenario  
- **Format:** CSV with datetime index  
- **Size:** ~50 MB  
- **License:** IDSSL (open)  
- **Data quality:** Real testbed data with labeled anomalies and changepoints. Clean timestamps. Two markup types (outlier and changepoint).
- **CollatrEdge relevance:** ★★★★★ — **This is the single best dataset for CollatrEdge simulation.** It has exactly the types of sensors an IIoT gateway would read (pressure, temperature, flow, vibration, current, voltage), all from a real physical system. 8 sensors × 1s resolution = perfect for replaying through Modbus holding registers. Labeled anomalies let us verify detection.

---

#### 10. CNC Mill Tool Wear Dataset

- **Source:** University of Michigan SMART Lab  
- **URL:** https://www.kaggle.com/datasets/shasun/tool-wear-detection-in-cnc-mill  
- **What it contains:** 18 CNC milling experiments on 2" × 2" × 1.5" wax blocks:
  - 48 time-series signals per machining pass: X/Y/Z forces, X/Y/Z vibration, spindle current, spindle speed, acoustic emission
  - Metadata: material, feed rate, clamp pressure
  - Labels: worn/unworn tool, adequate/inadequate clamping
- **Format:** CSV  
- **Size:** ~500 MB  
- **License:** Open (Kaggle)  
- **Data quality:** Real CNC machine data with practical machining variations. Includes both normal and abnormal conditions.
- **CollatrEdge relevance:** ★★★★ — Force, vibration, and current data from a CNC machine is directly relevant to manufacturing IoT. Maps to register types for spindle monitoring systems.

---

#### 11. NASA Milling Wear Dataset

- **Source:** UC Berkeley BEST Lab, hosted by NASA  
- **URL:** https://phm-datasets.s3.amazonaws.com/NASA/3.+Milling.zip  
- **What it contains:** Milling machine experiments recording tool wear (VB) at different:
  - Cutting speeds, feed rates, depth of cut
  - 6 sensor signals: AC spindle current, DC spindle current, table vibration, spindle vibration, acoustic emission (time + frequency)
  - 16 test cases with progressive wear measurements
- **Format:** MATLAB (.mat) files  
- **Size:** ~150 MB  
- **License:** Public Domain (NASA)  
- **Data quality:** Lab-controlled experiments with measured wear progression.
- **CollatrEdge relevance:** ★★★ — Good supplementary dataset for CNC/machining simulation. Smaller and simpler than the Michigan CNC dataset.

---

### Category 3: Energy & Utilities

#### 12. DAMADICS Actuator Benchmark

- **Source:** Warsaw University of Technology (DAMADICS EU project); data from Lublin Sugar Factory  
- **URL:** https://iair.mchtr.pw.edu.pl/Damadics  
- **Alt URL (Kaggle):** https://www.kaggle.com/datasets/afrniomelo/damadics-actuator-benchmark-lublin-sugar-factory  
- **What it contains:** Real process data from a sugar factory evaporation station:
  - 32 signals sampled at 1 Hz over 25 days continuous operation
  - Includes: control valve position, pressures, flows, temperatures, actuator signals
  - 19 simulated fault types for the control valve/actuator system
  - Both real plant data AND a MATLAB/Simulink simulation model
- **Format:** MATLAB (.mat) files, also CSV on Kaggle  
- **Size:** ~100 MB  
- **License:** Open/Academic  
- **Data quality:** Real continuous industrial process data from an operating factory. 1 Hz sample rate is typical for SCADA systems. The combination of real data + simulation model is powerful.
- **CollatrEdge relevance:** ★★★★★ — This is exactly what industrial SCADA looks like: 32 channels at 1 Hz from a real process. Perfect mapping to Modbus registers. 25 days of continuous operation provides realistic patterns (day/night cycles, batch operations, shutdowns). The fault simulation adds testing scenarios.

---

#### 15. Combined Cycle Power Plant

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/294/combined+cycle+power+plant  
- **What it contains:** Hourly measurements from a 480 MW combined cycle power plant over 6 years:
  - Temperature (T): 1.81–37.11 °C
  - Ambient Pressure (AP): 992.89–1033.30 mbar
  - Relative Humidity (RH): 25.56–100.16%
  - Exhaust Vacuum (V): 25.36–81.56 cm Hg
  - Net Electrical Energy Output (EP): 420.26–495.76 MW
- **Duration:** 9,568 data points, 2006–2011  
- **Format:** XLSX (also available as CSV)  
- **Size:** 0.5 MB  
- **License:** CC BY 4.0  
- **Data quality:** Clean, no missing values. Real power plant data. Small but well-characterized.
- **CollatrEdge relevance:** ★★★ — Simple but genuine power plant data. Good for a basic "power station" simulator. Only 4 input variables limits complexity but perfect for a quick demo.

---

#### 16. Steel Industry Energy Consumption

- **Source:** UCI Machine Learning Repository / Mendeley Data  
- **URL:** https://archive.ics.uci.edu/dataset/851/steel+industry+energy+consumption  
- **What it contains:** Energy consumption data from a DAEWOO steel company in South Korea, collected via IoT sensors:
  - Industry Energy Consumption (kWh)
  - Lagging/Leading Current Reactive Power (kVarh)
  - CO₂ emissions (ppm)
  - Lagging/Leading Current Power Factor (%)
  - Time-of-day, day-of-week, weekday/weekend
  - Load Type: Light/Medium/Maximum Load
- **Duration:** 35,040 records at 15-minute intervals (~1 year)  
- **Format:** CSV  
- **Size:** ~3 MB  
- **License:** CC BY 4.0  
- **Data quality:** Real IoT-collected data with natural patterns. Power factor and reactive power data are particularly interesting — these are often monitored via Modbus energy meters.
- **CollatrEdge relevance:** ★★★★ — Directly maps to what an energy meter connected via Modbus would report. Power factor, reactive power, kWh, and load type are standard Modbus register mappings for industrial energy monitoring.

---

#### 17. SWaT – Secure Water Treatment Dataset

- **Source:** iTrust, Singapore University of Technology and Design (SUTD)  
- **URL:** https://itrust.sutd.edu.sg/itrust-labs_datasets/  
- **What it contains:** Data from a scaled-down, industry-compliant water treatment plant:
  - 51 sensors and actuators across 6 process stages
  - Sensors: flow meters, level sensors, pressure gauges, pH meters, conductivity meters, ORP sensors
  - Actuators: pumps, valves (on/off states)
  - 7 days normal operation + 4 days with 36 different cyber-physical attacks
  - 1-second sampling rate
- **Format:** CSV  
- **Size:** ~1 GB  
- **License:** Academic (requires registration and approval)  
- **Data quality:** High-fidelity testbed data with realistic process dynamics. Attack labels with detailed descriptions. Some gaps during attack scenarios.
- **CollatrEdge relevance:** ★★★★ — Water treatment is a prime IIoT market. 51 channels at 1s = realistic SCADA polling scenario. The attack scenarios are bonus — they create anomalous patterns that test robustness. **Note:** Requires registration, not instant download.

---

#### 18. WADI – Water Distribution Dataset

- **Source:** iTrust, SUTD  
- **URL:** https://itrust.sutd.edu.sg/itrust-labs_datasets/  
- **What it contains:** Water distribution testbed data complementing SWaT:
  - 123 sensors and actuators
  - Flow, pressure, level, chemical dosing, pump states, valve positions
  - 14 days normal + 2 days with attacks
  - 1-second sampling
- **Format:** CSV  
- **Size:** ~1.5 GB  
- **License:** Academic (requires registration and approval)  
- **Data quality:** Larger and more complex than SWaT. Real process dynamics.
- **CollatrEdge relevance:** ★★★★ — 123 channels is a substantial register map. Same access caveat as SWaT.

---

#### 19. BATADAL – Water Network Attack Detection

- **Source:** BATADAL Competition  
- **URL:** https://www.batadal.net/data.html  
- **Alt URL:** https://www.kaggle.com/datasets/minhbtnguyen/batadal-a-dataset-for-cyber-attack-detection  
- **What it contains:** Data from the C-Town water distribution network (simulated via EPANET):
  - 43 sensors: tank levels, junction pressures, pipe flows, pump/valve states
  - 3 datasets: normal training, attack training (with labels), attack test
  - Hourly resolution
  - 7 different attack scenarios
- **Format:** CSV  
- **Size:** ~10 MB  
- **License:** Open  
- **Data quality:** Simulated but based on a realistic network model. Hourly resolution is slower than typical SCADA polling but sufficient. Labels are clean.
- **CollatrEdge relevance:** ★★★★ — Freely downloadable (unlike SWaT/WADI). Water infrastructure sensors map directly to Modbus registers (level = float32, pump = coil, valve = coil). Small size makes it easy to work with.

---

#### 20. Kelmarsh Wind Farm SCADA

- **Source:** Zenodo (published by Cubico Sustainable Investments)  
- **URL:** https://zenodo.org/records/5841834  
- **What it contains:** 10-minute SCADA data from 6 Senvion MM92 wind turbines:
  - ~99 variables per turbine including: active power, wind speed, rotor speed, blade pitch angle, nacelle direction, yaw error, generator RPM, bearing temperatures, gearbox oil temperature, hydraulic pressure, reactive power, grid frequency
  - Also includes event/alarm logs and static turbine data
- **Duration:** 5 years (2016–2021)  
- **Format:** CSV  
- **Size:** ~2 GB  
- **License:** CC BY 4.0  
- **Data quality:** Real operational SCADA data with natural gaps, curtailment periods, and maintenance events. Event logs provide context for anomalous readings.
- **CollatrEdge relevance:** ★★★★ — Wind turbine SCADA is a major IIoT application. ~600 variables across 6 turbines provides a rich register map. 10-minute resolution is standard for wind SCADA. 5 years of data allows testing of seasonal patterns and long-term drift.

---

#### 21. Pump Sensor Data

- **Source:** Kaggle  
- **URL:** https://www.kaggle.com/datasets/nphantawee/pump-sensor-data  
- **What it contains:** Sensor data from a water pump system for predictive maintenance:
  - 52 sensor channels (anonymized: sensor_00 to sensor_51)
  - Machine status labels: NORMAL, BROKEN, RECOVERING
  - ~1-minute resolution
- **Duration:** 220,320 rows (~4 months)  
- **Format:** CSV  
- **Size:** ~120 MB  
- **License:** Open (Kaggle)  
- **Data quality:** Real pump data with labeled machine states. Some sensors have constant or near-zero values (realistic — not all sensors are always active). Contains the transition from normal to broken state.
- **CollatrEdge relevance:** ★★★★ — 52 sensors from a real pump system is a realistic register map. The NORMAL → BROKEN → RECOVERING cycle is exactly what predictive maintenance systems need to handle. Anonymized sensor names are a limitation for demo purposes.

---

#### 22. MetroPT – Metro Air Production Unit

- **Source:** University of Porto, published in Scientific Data  
- **URL:** https://zenodo.org/records/6854240  
- **Alt URL:** https://archive.ics.uci.edu/dataset/791/metropt+3+dataset  
- **What it contains:** Sensor data from the Air Production Unit (APU) of a Porto Metro train:
  - Analog sensors: pressures (TP2, TP3, H1, DV_pressure), temperatures (oil_temperature, motor_current), electrical (COMP — compressor state)
  - Digital signals: control signals, discrete valve/motor states
  - GPS data: latitude, longitude, speed
  - Known failure events documented in maintenance reports
- **Duration:** January–June 2022, ~26 trips/day  
- **Format:** CSV (MetroPT), Parquet (MetroPT-3)  
- **Size:** ~1.5 GB  
- **License:** CC BY 4.0  
- **Data quality:** Real operational data with ground-truth anomalies from maintenance reports. Mixed analog/digital signals. Natural noise including GPS jitter, pressure fluctuations from door operations, and environmental temperature effects.
- **CollatrEdge relevance:** ★★★★★ — Mixed analog/digital signals at 1-second resolution is exactly what a real IIoT deployment collects. Pressure, temperature, current + digital control signals map naturally to Modbus holding registers + coils. Ground-truth failures make it perfect for testing and demo.

---

### Category 4: Manufacturing Quality & Production

#### 13. SECOM Semiconductor Manufacturing Dataset

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/179/secom  
- **What it contains:** Data from a semiconductor wafer fabrication line:
  - 590 sensor features per wafer (process parameters, measurements)
  - Pass/Fail label for each wafer
  - Timestamps for each instance
- **Duration:** 1,567 instances  
- **Format:** Space-delimited text / CSV  
- **Size:** ~20 MB  
- **License:** CC BY 4.0  
- **Data quality:** Real production data with ~4.5% missing values (tagged as NaN). Highly imbalanced classes (~6.6% fail rate). Many features are near-constant or redundant. This "messiness" is realistic.
- **CollatrEdge relevance:** ★★★ — High-dimensional sensor data from a real fab. The 590 features could map to a large register space. However, it's per-wafer (event-based) rather than continuous time series. Better for quality monitoring use cases than continuous SCADA simulation.

---

#### 14. Bosch Production Line Performance

- **Source:** Kaggle Competition  
- **URL:** https://www.kaggle.com/c/bosch-production-line-performance  
- **What it contains:** Real data from Bosch automotive manufacturing:
  - 4,264 features: numerical measurements, categorical attributes, and timestamps
  - 1,184,687 parts (train set)
  - Binary label: Pass/Fail (0.58% failure rate)
  - Data structured as: numerical (measurement values), categorical (station/feature names), date (timestamps per station)
- **Format:** CSV (compressed)  
- **Size:** 14.3 GB  
- **License:** Kaggle Competition rules  
- **Data quality:** Real manufacturing data, anonymized. Very sparse (many NaN values — parts skip stations). Massive scale.
- **CollatrEdge relevance:** ★★★ — Extremely large and realistic but anonymized and event-based rather than continuous time series. The sparsity patterns are interesting for testing missing-data handling. Better suited for production analytics than SCADA simulation.

---

### Category 5: Open IIoT / Industry 4.0 Benchmarks

#### 23. Gas Sensor Array Drift Dataset

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/224/gas+sensor+array+drift+dataset  
- **What it contains:** Long-term drift data from 16 metal-oxide chemical sensors:
  - 6 target gases: Ethanol, Ethylene, Ammonia, Acetaldehyde, Acetone, Toluene
  - Concentrations: 5–1000 ppmv
  - 8 features extracted per sensor (128 total features)
  - Data collected over 36 months (10 batches)
- **Duration:** 13,910 measurements over 3 years  
- **Format:** DAT text files  
- **Size:** ~20 MB  
- **License:** CC BY 4.0  
- **Data quality:** Real sensor drift over 3 years. This is the quintessential sensor drift dataset — the sensors' response characteristics change over time, requiring recalibration.
- **CollatrEdge relevance:** ★★★ — Sensor drift is a critical real-world problem. This dataset can teach simulators to generate realistic drift patterns. However, it's batch-based rather than continuous time series.

---

#### 24. Control Loop Datasets (GIMSCOP)

- **Source:** GIMSCOP, Federal University of Rio Grande do Sul (UFRGS), Brazil  
- **URL:** https://www.ufrgs.br/gimscop/repository/sisoviewer/datasets/  
- **What it contains:** Multiple industrial control loop datasets:
  - **SISO-RAW:** Raw data from an oil & gas company — 2.5 days with non-constant sampling time, includes setpoint (SP), process variable (PV), and controller output (OP) for multiple loops
  - **SISO-INTERPOLATED:** Same data resampled to uniform timesteps
  - **Oscillation detection datasets:** Labeled control loops (oscillating vs. non-oscillating)
  - Real loops from chemical, oil & gas, and process industries
- **Format:** CSV  
- **Size:** ~50 MB  
- **License:** Open/Academic  
- **Data quality:** Real industrial control loop data with natural oscillation, stiction, and control problems. Non-constant sampling in the RAW set is particularly realistic.
- **CollatrEdge relevance:** ★★★★ — Control loops (SP/PV/OP triplets) are fundamental to industrial automation. These map directly to Modbus registers: PV = input register, SP = holding register, OP = holding register. Non-constant sampling tests CollatrEdge's robustness.

---

#### 25. Numenta Anomaly Benchmark (NAB)

- **Source:** Numenta  
- **URL:** https://github.com/numenta/NAB  
- **What it contains:** 58 time series from real-world sources:
  - Machine temperature sensors
  - CPU utilization metrics
  - Network traffic data
  - AWS CloudWatch metrics
  - Twitter volume data
  - NYC taxi demand
  - Labeled anomaly windows
- **Duration:** 1,000–22,000 data points per series  
- **Format:** CSV (timestamp + value)  
- **Size:** ~20 MB  
- **License:** AGPL-3.0  
- **Data quality:** Mix of real-world and artificial anomalies. Some series are from actual IT infrastructure monitoring. Labeled with anomaly windows, not just point labels.
- **CollatrEdge relevance:** ★★★ — The machine temperature and CPU series are relevant to industrial monitoring. Good for testing anomaly detection but limited industrial scope. Better as a supplementary benchmark.

---

#### 26. APS Failure at Scania Trucks

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/421/aps+failure+at+scania+trucks  
- **Alt URL:** https://www.kaggle.com/datasets/uciml/aps-failure-at-scania-trucks-data-set  
- **What it contains:** Data from heavy Scania trucks:
  - 170 anonymized sensor features from the Air Pressure System (APS)
  - Binary classification: APS-related failure vs. not
  - Training set: 60,000 instances; Test set: 16,000 instances
- **Format:** CSV  
- **Size:** ~50 MB  
- **License:** CC BY 4.0  
- **Data quality:** Real vehicle data with significant missing values (~8% of entries). Imbalanced classes (1,000/59,000 positive in training). Features are anonymized histograms and counters.
- **CollatrEdge relevance:** ★★★ — Real sensor data from heavy vehicles but highly anonymized. Better for ML benchmarking than simulator building due to lack of physical interpretability.

---

#### 27. Modbus/ICS Network PCAP Captures

- **Source:** Multiple (IEEE DataPort, IMPACT, University of New Brunswick, GitHub)  
- **URLs:**
  - IEEE DataPort: https://ieee-dataport.org/documents/cyber-security-modbus-ics-dataset
  - UNB CIC: https://www.unb.ca/cic/datasets/modbus-2023.html
  - GitHub ICS-Security-Tools: https://github.com/ITI/ICS-Security-Tools/blob/master/pcaps/README.md
- **What it contains:** Network packet captures of industrial protocols:
  - Modbus TCP traffic (normal and attack)
  - S7comm (Siemens) traffic
  - DNP3 traffic
  - Both benign operational traffic and various cyber attack scenarios
- **Format:** PCAP files  
- **Size:** ~1 GB combined across sources  
- **License:** Various open licenses  
- **Data quality:** Captures include both lab-generated and testbed traffic. Protocol-level data rather than process-level sensor readings.
- **CollatrEdge relevance:** ★★★ — Not directly usable for data replay simulation, but valuable for understanding real Modbus traffic patterns (register polling frequency, function codes used, response times). Could inform protocol-level simulator configuration.

---

#### 28. Appliances Energy Prediction

- **Source:** UCI Machine Learning Repository  
- **URL:** https://archive.ics.uci.edu/dataset/374/appliances+energy+prediction  
- **What it contains:** Smart home monitoring data:
  - Temperature and humidity from 9 rooms via ZigBee wireless sensors
  - Energy consumption (appliances and lights)
  - Weather station data (outdoor temp, humidity, wind, visibility, pressure)
  - 29 variables total at 10-minute intervals
- **Duration:** 4.5 months (19,735 instances)  
- **Format:** CSV  
- **Size:** ~5 MB  
- **License:** CC BY 4.0  
- **Data quality:** Real sensor data with ZigBee network characteristics. Some measurement noise from wireless transmission.
- **CollatrEdge relevance:** ★★★ — Good example of distributed IoT sensor network. Multiple temperature/humidity sensors are analogous to building HVAC monitoring via Modbus. Small scale but realistic patterns.

---

## Recommended for CollatrEdge Simulation

Based on the research above, these are the **top 8 datasets** for building realistic simulators that exercise CollatrEdge's capabilities:

### Tier 1: Must-Have (build simulators with these first)

| # | Dataset | Why |
|---|---------|-----|
| 1 | **SKAB (Skoltech Anomaly Benchmark)** | Perfect sensor mix (pressure, temp, flow, vibration, current, voltage) from a real testbed. 8 channels at ~1s resolution. Labeled anomalies. Small enough to iterate quickly. Maps 1:1 to Modbus holding registers. |
| 2 | **Condition Monitoring of Hydraulic Systems** | 17 multi-rate sensors (100 Hz/10 Hz/1 Hz) from a real hydraulic rig. Tests CollatrEdge's ability to handle different polling rates. Four fault types with severity grades. CC BY 4.0. |
| 3 | **MetroPT (Metro Air Production Unit)** | Mixed analog + digital signals from a real compressor. Pressure, temperature, current, and control signals at 1s. Ground-truth failures from maintenance reports. Perfect for a "compressor monitoring" demo. |
| 4 | **DAMADICS Actuator Benchmark** | 32 real process signals at 1 Hz from an operating sugar factory. 25 days continuous. Exactly what SCADA looks like. Control valve + actuator focus is highly relevant to process industries. |

### Tier 2: High-Value (build these next)

| # | Dataset | Why |
|---|---------|-----|
| 5 | **Petrobras 3W (Oil Well)** | Real oil well data with genuine anomalies. Pressure/temp/flow at realistic rates. Oil & gas is a key CollatrEdge market. CC BY 4.0. |
| 6 | **Tennessee Eastman Process** | Industry gold standard for chemical process simulation. 52 correlated variables with 21 fault types. Build a "virtual chemical plant" simulator with this. |
| 7 | **IMS/NASA Bearing Run-to-Failure** | Long-duration vibration degradation data (35 days). 10-minute polling cadence is realistic. Tests trending and degradation detection. |
| 8 | **Steel Industry Energy Consumption** | Real IoT-collected power/energy data from a steel plant. kWh, reactive power, power factor = standard energy meter Modbus registers. Shows daily/weekly load patterns. |

### Implementation Strategy

For each recommended dataset, a simulator should:

1. **Load the real data** and replay it as time-series through a virtual Modbus/OPC-UA server
2. **Map each sensor column to a specific register type:**
   - Analog process values (pressure, temperature, flow) → Float32 holding registers
   - Digital states (pump on/off, valve open/close) → Coils or discrete inputs
   - Counters (energy meters, production counts) → Unsigned 32-bit holding registers
   - Status codes → Unsigned 16-bit holding registers
3. **Introduce realistic imperfections:**
   - Use actual data gaps from the dataset (don't interpolate them away)
   - Add occasional communication timeouts
   - Vary polling response times
4. **Provide configurable time compression** so a 25-day dataset can be replayed in minutes or hours
5. **Tag anomaly/fault periods** so test assertions can verify CollatrEdge captures the right data around events

### Data Quality as a Feature

These datasets were specifically chosen because they contain real-world imperfections:
- **Missing values:** SECOM (~4.5%), APS Scania (~8%), 3W (production gaps)
- **Sensor drift:** Gas Sensor Array (36 months of drift), bearing degradation trends
- **Noise:** All vibration datasets, MetroPT (GPS jitter, door operations)
- **Non-uniform sampling:** GIMSCOP SISO-RAW, Petrobras 3W
- **Outliers and spikes:** Hydraulic system pressure spikes, SKAB anomalies

These imperfections are features, not bugs — they test that CollatrEdge handles messy real data correctly.

---

## Additional Resources

### Curated Dataset Collections
- **Awesome Industrial Datasets:** https://github.com/jonathanwvd/awesome-industrial-datasets — comprehensive catalogue of 100+ industrial datasets
- **Awesome Bearing Datasets:** https://github.com/VictorBauler/awesome-bearing-dataset — bearing fault detection datasets
- **OpenWindSCADA:** https://github.com/sltzgs/OpenWindSCADA — curated list of open wind turbine SCADA datasets
- **NASA PCoE Data Repository:** https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/ — prognostics datasets
- **PHM Society Data Repository:** https://data.phmsociety.org/ — challenge datasets for prognostics and health management

### Makinarocks Industrial Machine Datasets
- https://github.com/makinarocks/awesome-industrial-machine-datasets — another curated list with data explanations
