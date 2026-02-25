# Research: Target Customer Data Profiles

**Date:** 2026-02-25  
**Purpose:** Define what types of industrial data Collatr's target customers actually collect, so we can source realistic test datasets, build meaningful simulators, and design demo scenarios that resonate with buyers.  
**Audience:** Engineering (simulator design), Product (demo scenarios), Sales (customer conversations)  
**Sources:** Collatr marketing prospect research (Streams 1–6), Close the Loop papers, protocol & integration research, CollatrEdge PRD

---

## Table of Contents

1. [Sector 1: Packaging, Printing & Labelling](#sector-1-packaging-printing--labelling)
2. [Sector 2: Food & Beverage Manufacturing](#sector-2-food--beverage-manufacturing)
3. [Sector 3: Pharmaceutical & Life Sciences](#sector-3-pharmaceutical--life-sciences)
4. [Sector 4: Automotive & Aerospace Supply Chain](#sector-4-automotive--aerospace-supply-chain)
5. [Sector 5: Process Manufacturing (Glass, Chemicals, Sugar, Flooring)](#sector-5-process-manufacturing)
6. [Cross-Sector Common Signals](#cross-sector-common-signals)
7. [The Demo Dataset Spec](#the-demo-dataset-spec)
8. [Priority Ranking](#priority-ranking)

---

## Sector 1: Packaging, Printing & Labelling

**Target customers:** Roberts Mart, Reflex Group, Wipak UK, Coveris UK, SAICA Pack, Parkside Flexibles, ProAmpac UK, Augustus Martin  
**Revenue range:** £20m–£300m  
**Why this sector first:** Doubly Good's deepest domain knowledge (Domino Printing Sciences), high density of UK SME targets, high capital investment with poor data capture, and Domino coding equipment on virtually every line providing a natural entry point.

### Typical Equipment

| Equipment | Vendors | Controllers/PLCs | Protocol |
|-----------|---------|-------------------|----------|
| **Flexographic presses** (CI & stack) | BOBST, Soma, Windmöller & Hölscher (W&H), KYMC | Siemens S7-1200/1500, Beckhoff TwinCAT, B&R | OPC-UA, EtherCAT, Modbus TCP |
| **Digital inkjet presses** | Screen Truepress, HP Indigo | Proprietary controllers with HTTP/REST APIs | HTTP/REST, OPC-UA |
| **Laminators** (solvent, solvent-free, water-based) | Comexi, Nordmeccanica, BOBST | Siemens S7-1500, Schneider Modicon | OPC-UA, Modbus TCP |
| **Slitters / rewinders** | Atlas (Bobst group), Comexi, Kampf | Siemens, Beckhoff | OPC-UA, Modbus TCP |
| **Extruders** (blown film, cast film) | W&H, Reifenhäuser, Macchi | Siemens S7-1500, Rockwell ControlLogix | OPC-UA, Modbus TCP, EtherNet/IP |
| **Corrugators** | Fosber, BHS | Siemens, proprietary controllers | OPC-UA, Modbus TCP |
| **Coding & marking** (inkjet, laser, thermal transfer) | Domino, Markem-Imaje, Videojet | Proprietary controllers with serial/Ethernet | HTTP/REST, Modbus TCP, proprietary serial |
| **Finishing equipment** (die cutters, folder gluers) | Grafotronic, BOBST | Siemens, Beckhoff | OPC-UA, Modbus TCP |
| **Environmental / HVAC** | Various | BACnet controllers, Modbus RTU sensors | Modbus TCP/RTU, BACnet |

### Data Signals

#### Flexographic Press (Primary Equipment)

| Signal Name | Typical Range | Units | Sample Rate | Protocol | Modbus Register Pattern | OPC-UA Node Pattern |
|-------------|---------------|-------|-------------|----------|------------------------|---------------------|
| `line_speed` | 50–400 | m/min | 1s | OPC-UA, Modbus | HR 100–101 (float32) | `ns=2;s=Press1.LineSpeed` |
| `web_tension` | 20–500 | N | 500ms | OPC-UA, Modbus | HR 102–103 (float32) | `ns=2;s=Press1.WebTension` |
| `registration_error_x` | -0.5–+0.5 | mm | 500ms | OPC-UA | — | `ns=2;s=Press1.RegError.X` |
| `registration_error_y` | -0.5–+0.5 | mm | 500ms | OPC-UA | — | `ns=2;s=Press1.RegError.Y` |
| `ink_viscosity` | 15–60 | seconds (Zahn cup) | 30s | Modbus | HR 110–111 (float32) | `ns=2;s=Press1.Ink.Viscosity` |
| `ink_temperature` | 18–35 | °C | 10s | Modbus | HR 112–113 (float32) | `ns=2;s=Press1.Ink.Temp` |
| `dryer_temperature_zone_N` | 40–120 | °C | 5s | Modbus | HR 120+N*2 (float32) | `ns=2;s=Press1.Dryer.Zone[N].Temp` |
| `dryer_setpoint_zone_N` | 40–120 | °C | Event-driven | Modbus | HR 140+N*2 (float32) | `ns=2;s=Press1.Dryer.Zone[N].Setpoint` |
| `impression_count` | 0–999,999,999 | count | 1s (counter) | Modbus | HR 200–201 (uint32) | `ns=2;s=Press1.ImpressionCount` |
| `good_count` | 0–999,999,999 | count | 1s (counter) | Modbus | HR 202–203 (uint32) | `ns=2;s=Press1.GoodCount` |
| `waste_count` | 0–999,999 | count | 1s (counter) | Modbus | HR 204–205 (uint32) | `ns=2;s=Press1.WasteCount` |
| `machine_state` | 0–5 | enum (0=Off, 1=Setup, 2=Running, 3=Idle, 4=Fault, 5=Maintenance) | Event-driven | OPC-UA, Modbus | HR 210 (uint16) | `ns=2;s=Press1.State` |
| `motor_current_main_drive` | 0–200 | A | 1s | Modbus | HR 300–301 (float32) | `ns=2;s=Press1.MainDrive.Current` |
| `motor_speed_main_drive` | 0–3000 | RPM | 1s | Modbus | HR 302–303 (float32) | `ns=2;s=Press1.MainDrive.Speed` |
| `nip_pressure` | 0–10 | bar | 5s | Modbus | HR 310–311 (float32) | `ns=2;s=Press1.NipPressure` |
| `unwind_diameter` | 50–1500 | mm | 10s | Modbus | HR 320–321 (float32) | `ns=2;s=Press1.Unwind.Diameter` |
| `rewind_diameter` | 50–1500 | mm | 10s | Modbus | HR 322–323 (float32) | `ns=2;s=Press1.Rewind.Diameter` |

#### Laminator

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `nip_roller_temperature` | 30–80 | °C | 5s | Modbus TCP |
| `nip_pressure` | 1–8 | bar | 5s | Modbus TCP |
| `adhesive_weight` | 1.0–5.0 | g/m² | 30s | Modbus TCP |
| `oven_temperature_zone_N` | 40–100 | °C | 5s | Modbus TCP |
| `web_speed` | 50–400 | m/min | 1s | Modbus TCP |
| `web_tension_primary` | 20–300 | N | 500ms | OPC-UA |
| `web_tension_secondary` | 20–300 | N | 500ms | OPC-UA |
| `solvent_retention` | 0–5 | mg/m² | Event (lab test) | HTTP/REST |

#### Slitter / Rewinder

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `slitting_speed` | 100–800 | m/min | 1s | Modbus TCP |
| `web_tension` | 10–200 | N | 500ms | OPC-UA |
| `blade_pressure` | 0–5 | bar | 5s | Modbus TCP |
| `reel_count` | 0–9999 | count | Event | Modbus TCP |
| `trim_waste_width` | 0–50 | mm | Event | Modbus TCP |

#### Extruder (Blown/Cast Film)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `barrel_temperature_zone_N` | 150–280 | °C | 5s | Modbus TCP |
| `die_temperature` | 180–260 | °C | 5s | Modbus TCP |
| `melt_pressure` | 50–400 | bar | 1s | Modbus TCP |
| `screw_speed` | 10–150 | RPM | 1s | Modbus TCP |
| `screw_torque` | 0–100 | % | 1s | Modbus TCP |
| `film_thickness` | 10–200 | µm | 1s (gauge) | HTTP/REST, Modbus |
| `film_width` | 200–3000 | mm | 10s | Modbus TCP |
| `line_speed` | 20–200 | m/min | 1s | Modbus TCP |
| `bubble_diameter` (blown) | 200–3000 | mm | 5s | Modbus TCP |
| `frost_line_height` (blown) | 100–1000 | mm | 5s | Modbus TCP |
| `haul_off_speed` | 20–200 | m/min | 1s | Modbus TCP |

#### Coding & Marking (Domino/Markem-Imaje)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `printer_state` | 0–4 | enum (0=Off, 1=Ready, 2=Printing, 3=Fault, 4=Standby) | Event-driven | HTTP/REST |
| `prints_total` | 0–999,999,999 | count | Event | HTTP/REST |
| `ink_level` | 0–100 | % | 60s | HTTP/REST |
| `solvent_level` | 0–100 | % | 60s | HTTP/REST |
| `printhead_temperature` | 25–50 | °C | 30s | HTTP/REST |
| `fault_code` | 0–999 | code | Event-driven | HTTP/REST |

### Register/Tag Patterns

**Modbus (typical Siemens/Schneider PLC behind a flexo press):**
```
Holding Registers (FC03):
  HR 100-101: Line Speed         (float32, ABCD, m/min)
  HR 102-103: Web Tension        (float32, ABCD, N)
  HR 110-111: Ink Viscosity      (float32, ABCD, s)
  HR 112-113: Ink Temperature    (float32, ABCD, °C)
  HR 120-129: Dryer Temps Z1-Z5  (float32, ABCD, °C)
  HR 200-201: Impression Count   (uint32, ABCD)
  HR 202-203: Good Count         (uint32, ABCD)
  HR 204-205: Waste Count        (uint32, ABCD)
  HR 210:     Machine State      (uint16, enum)
  HR 300-303: Main Drive Current & Speed (float32, ABCD)

Coils (FC01):
  Coil 0: Running
  Coil 1: Fault Active
  Coil 2: Emergency Stop
  Coil 3: Web Break Detected
```

**OPC-UA (typical namespace structure):**
```
Root
└── Objects
    └── Press1 (ns=2)
        ├── LineSpeed         (Double, m/min)
        ├── WebTension        (Double, N)
        ├── State             (UInt16, enum)
        ├── ImpressionCount   (UInt32, counter)
        ├── GoodCount         (UInt32, counter)
        ├── WasteCount        (UInt32, counter)
        ├── Registration
        │   ├── ErrorX        (Double, mm)
        │   └── ErrorY        (Double, mm)
        ├── Ink
        │   ├── Viscosity     (Double, s)
        │   └── Temperature   (Double, °C)
        ├── Dryer
        │   ├── Zone1
        │   │   ├── Temperature  (Double, °C)
        │   │   └── Setpoint     (Double, °C)
        │   ├── Zone2 ...
        │   └── Zone5 ...
        ├── MainDrive
        │   ├── Current       (Double, A)
        │   ├── Speed         (Double, RPM)
        │   └── Torque        (Double, %)
        └── Unwind
            └── Diameter      (Double, mm)
```

### Key Analytics Use Cases

| Use Case | Signals Involved | What Collatr Does |
|----------|-----------------|-------------------|
| **OEE monitoring** | `machine_state`, `good_count`, `waste_count`, `line_speed`, job changeover timestamps | Calculate Availability × Performance × Quality in real-time; trend over shifts/days/weeks |
| **Waste/scrap reduction** | `waste_count`, `registration_error_x/y`, `web_tension`, `ink_viscosity`, `dryer_temperature` | Correlate waste events with process parameters; identify which variables drift before waste increases |
| **Predictive maintenance — drives** | `motor_current`, `motor_speed`, `vibration` (retrofit sensor) | Detect bearing wear signatures (increasing current at constant speed), predict motor failure |
| **Print quality correlation** | `registration_error`, `web_tension`, `ink_viscosity`, `ink_temperature`, `line_speed` | Identify which process variables most affect print registration; alert when conditions likely to produce defects |
| **Energy monitoring** | `motor_current` × voltage (calculated kW), per-machine and per-line | Track energy per impression, benchmark across shifts, identify energy waste during idle periods |
| **Downtime analysis** | `machine_state` transitions with timestamps | Categorise downtime (planned/unplanned, setup, fault, material), identify Pareto of downtime causes |
| **Cross-site benchmarking** | All OEE signals across sites | For multi-site operators (Reflex, SAICA, ProAmpac): which site runs best on which product? |

### Compliance / Regulatory

| Standard | Requirement | Data Implication |
|----------|-------------|------------------|
| **BRC Packaging** (BRCGS) | Traceability, process control records, calibration | Timestamped production data, batch/lot correlation, temperature records for food-contact packaging |
| **ISO 22000** (food safety) | HACCP monitoring points for food-contact packaging | Temperature, pressure records at critical control points |
| **FSC / PEFC** (chain of custody) | Material traceability | Batch/reel tracking through production |
| **EN 15593** (hygiene for packaging) | Production environment monitoring | Temperature, humidity in production area |

---

## Sector 2: Food & Beverage Manufacturing

**Target customers:** Compleat Food Group, Müller UK, Warburtons, Greencore, Raynor Foods, Premier Foods, Cranswick, Samworth Brothers  
**Revenue range:** £50m–£2.1bn (sweet spot: £50m–£700m)  
**Why this sector:** UK's largest manufacturing sector, massive productivity gap (£7–14bn per FDF), strong Made Smarter engagement, high regulatory pressure (BRC, SALSA), and most prospects lack IIoT infrastructure despite significant capital investment.

### Typical Equipment

| Equipment | Vendors | Controllers/PLCs | Protocol |
|-----------|---------|-------------------|----------|
| **Mixing/blending** | Silverson, GEA, SPX Flow | Allen-Bradley CompactLogix, Siemens S7-1200 | Modbus TCP, EtherNet/IP, OPC-UA |
| **Ovens / baking lines** | Baker Perkins, Spooner, Rademaker | Eurotherm temperature controllers, Siemens S7-1500 | Modbus TCP (Eurotherm), OPC-UA |
| **Filling / packaging lines** | Ishida, Multivac, Bosch/Syntegon, Harpak-ULMA | Siemens S7-1200/1500, Rockwell CompactLogix, Omron NX | OPC-UA, EtherNet/IP, Modbus TCP |
| **Conveyor systems** | Intralox, FlexLink, Dorner | SEW-Eurodrive, Lenze, Nord | Modbus TCP, PROFINET |
| **Weighing / checkweighing** | Ishida, Mettler Toledo, Loma, CEIA | Proprietary controllers | HTTP/REST, Modbus TCP, serial |
| **Metal detectors / X-ray** | Loma, Mettler Toledo, Ishida | Proprietary controllers | HTTP/REST, Modbus TCP |
| **Refrigeration** | Star Refrigeration, Johnson Controls, Carrier | Allen-Bradley, Danfoss controllers | Modbus TCP, BACnet |
| **CIP (Clean-in-Place)** | Ecolab, GEA, SPX Flow | Allen-Bradley, Siemens | Modbus TCP, OPC-UA |
| **Coding & marking** | Domino, Markem-Imaje, Videojet | Proprietary | HTTP/REST |
| **Robotic pick & place** | ABB, Fanuc, KUKA, Universal Robots | Robot controllers | OPC-UA, HTTP/REST |

### Data Signals

#### Baking / Oven Line (e.g., Warburtons, Premier Foods)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `oven_temperature_zone_N` | 150–280 | °C | 5s | Modbus TCP (Eurotherm) |
| `oven_setpoint_zone_N` | 150–280 | °C | Event-driven | Modbus TCP |
| `belt_speed` | 0.5–5.0 | m/min | 1s | Modbus TCP |
| `humidity_zone_N` | 30–90 | %RH | 10s | Modbus TCP |
| `product_temperature_core` | -5–95 | °C | 5s (probe) | Modbus TCP |
| `steam_injection_rate` | 0–100 | % | 5s | Modbus TCP |
| `bake_time` | 10–60 | minutes | Calculated | — |
| `energy_consumption` | 0–500 | kWh | 60s | Modbus TCP, HTTP/REST (smart meter) |

#### Filling / Packaging Line

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `line_speed` | 10–300 | packs/min | 1s | OPC-UA, Modbus TCP |
| `fill_weight` | 50–5000 | g | Per item (event) | HTTP/REST, Modbus TCP |
| `fill_weight_deviation` | -10–+10 | g | Per item (event) | HTTP/REST |
| `seal_temperature` | 100–250 | °C | 5s | Modbus TCP |
| `seal_pressure` | 1–6 | bar | 5s | Modbus TCP |
| `seal_dwell_time` | 0.5–5.0 | seconds | 5s | Modbus TCP |
| `reject_count` | 0–9999 | count | Event | Modbus TCP |
| `metal_detector_trips` | 0–99 | count | Event | HTTP/REST |
| `gas_mix_ratio_CO2` | 20–80 | % | 10s (MAP packaging) | Modbus TCP |
| `gas_mix_ratio_N2` | 20–80 | % | 10s | Modbus TCP |
| `vacuum_level` | -0.9–0 | bar | 5s (thermoformer) | Modbus TCP |
| `film_usage` | 0–999,999 | m | Counter | Modbus TCP |
| `packs_produced` | 0–999,999 | count | Counter | Modbus TCP |
| `machine_state` | 0–5 | enum | Event-driven | OPC-UA, Modbus TCP |

#### Mixing / Blending

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `mixer_speed` | 0–3000 | RPM | 1s | Modbus TCP |
| `mixer_torque` | 0–100 | % | 1s | Modbus TCP |
| `batch_temperature` | -5–95 | °C | 5s | Modbus TCP |
| `batch_weight` | 0–5000 | kg | 5s (load cell) | Modbus TCP |
| `ingredient_dosing_weight_N` | 0–1000 | kg | Event | Modbus TCP |
| `mix_time` | 0–3600 | seconds | Timer | — |
| `pH` | 2–12 | — | 30s | Modbus TCP (4-20mA via ADC) |
| `viscosity` | 10–100,000 | cP | 30s | Modbus TCP |

#### Refrigeration / Cold Storage

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `room_temperature` | -25–+15 | °C | 60s | Modbus TCP, BACnet |
| `setpoint` | -25–+15 | °C | Event | Modbus TCP |
| `compressor_state` | 0/1 | bool | Event | Modbus TCP |
| `compressor_suction_pressure` | 0–20 | bar | 30s | Modbus TCP |
| `compressor_discharge_pressure` | 5–30 | bar | 30s | Modbus TCP |
| `evaporator_temperature` | -30–+10 | °C | 30s | Modbus TCP |
| `defrost_state` | 0/1 | bool | Event | Modbus TCP |
| `door_open` | 0/1 | bool | Event | Modbus TCP (digital input) |
| `energy_consumption` | 0–500 | kWh | 60s | Modbus TCP |

#### Checkweigher / Quality Inspection

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `actual_weight` | 50–5000 | g | Per item | HTTP/REST |
| `target_weight` | 50–5000 | g | Per batch | HTTP/REST |
| `tolerance_high` | +1–+20 | g | Per batch | HTTP/REST |
| `tolerance_low` | -1–-20 | g | Per batch | HTTP/REST |
| `overweight_count` | 0–9999 | count | Counter | HTTP/REST |
| `underweight_count` | 0–9999 | count | Counter | HTTP/REST |
| `reject_count` | 0–9999 | count | Counter | HTTP/REST |
| `total_count` | 0–999,999 | count | Counter | HTTP/REST |
| `throughput` | 10–300 | items/min | 1s | HTTP/REST |

### Register/Tag Patterns

**Modbus (typical Eurotherm temperature controller on baking oven):**
```
Holding Registers (FC03):
  HR 1:   Process Variable (PV) — current temperature (int16, ×10, °C)
  HR 2:   Setpoint (SP)         — target temperature (int16, ×10, °C)
  HR 3:   Output Power          — heater output (int16, 0–1000 = 0–100.0%)
  HR 4:   Working Setpoint      — active SP after ramp (int16, ×10, °C)
  HR 5:   Alarm Status          — bitmask (uint16)
  HR 6:   Module Status         — bitmask (uint16)

Note: Eurotherm uses slave IDs for zone addressing.
Typical oven: Slave 1 = Zone 1, Slave 2 = Zone 2, etc.
Byte order: ABCD (big-endian, Modbus standard)
```

**Modbus (Allen-Bradley CompactLogix via Modbus TCP gateway — filling line):**
```
Holding Registers (FC03):
  HR 0-1:   Line Speed       (float32, CDAB — A-B word-swap)
  HR 2-3:   Fill Weight       (float32, CDAB)
  HR 4-5:   Seal Temperature  (float32, CDAB)
  HR 6-7:   Seal Pressure     (float32, CDAB)
  HR 10-11: Packs Produced    (uint32, CDAB)
  HR 12-13: Reject Count      (uint32, CDAB)
  HR 20:    Machine State     (uint16)
  HR 21:    Fault Code        (uint16)

Coils (FC01):
  Coil 0: Running
  Coil 1: In Fault
  Coil 2: CIP Active
  Coil 3: Recipe Loaded

Note: Allen-Bradley uses CDAB (word-swapped) byte order by default
```

**OPC-UA (typical Siemens S7-1500 on a bakery line):**
```
Root
└── Objects
    └── BakingLine1 (ns=3)
        ├── Oven
        │   ├── Zone1
        │   │   ├── Temperature    (Double, °C)
        │   │   ├── Setpoint       (Double, °C)
        │   │   └── OutputPower    (Double, %)
        │   ├── Zone2 ...
        │   └── Zone6 ...
        ├── Conveyor
        │   ├── Speed              (Double, m/min)
        │   └── Running            (Boolean)
        ├── Proofer
        │   ├── Temperature        (Double, °C)
        │   ├── Humidity           (Double, %RH)
        │   └── DwellTime          (Double, minutes)
        ├── Production
        │   ├── GoodCount          (UInt32)
        │   ├── RejectCount        (UInt32)
        │   ├── BatchNumber        (String)
        │   └── ProductCode        (String)
        └── CIP
            ├── Active             (Boolean)
            ├── Phase              (UInt16, enum)
            └── Temperature        (Double, °C)
```

### Key Analytics Use Cases

| Use Case | Signals Involved | What Collatr Does |
|----------|-----------------|-------------------|
| **OEE per line** | `machine_state`, `packs_produced`, `reject_count`, `line_speed` | Real-time OEE; trend by shift, product, day-of-week |
| **Giveaway reduction** | `fill_weight`, `target_weight`, `fill_weight_deviation` | Statistical process control — detect overfill drift, calculate £ of giveaway per shift |
| **Bake quality correlation** | `oven_temperature_zone_N`, `belt_speed`, `humidity`, `product_temperature_core` | Correlate bake parameters with downstream quality rejects; identify optimal parameter windows |
| **Energy per unit** | `energy_consumption` (oven, refrigeration, compressed air), `packs_produced` | Track kWh per pack/tonne; identify energy waste during changeovers and idle |
| **Cold chain compliance** | `room_temperature`, `door_open` events, `defrost_state` | Continuous temperature logging for BRC/SALSA compliance; alert on excursions; generate audit reports |
| **Predictive maintenance — seals** | `seal_temperature`, `seal_pressure`, `seal_dwell_time`, reject rates | Detect degrading seal bars (temperature drift, inconsistent pressure) before they cause rejects |
| **CIP effectiveness** | `cip_temperature`, `cip_duration`, `chemical_concentration` | Validate CIP cycles meet specifications; flag incomplete cleans |

### Compliance / Regulatory

| Standard | Requirement | Data Implication |
|----------|-------------|------------------|
| **BRC Global Standard for Food Safety** (Issue 9) | HACCP monitoring, traceability, temperature records, cleaning records | Continuous temperature logging at CCPs; batch traceability linking ingredient lots to finished packs; CIP records |
| **SALSA** (Safe and Local Supplier Approval) | For smaller suppliers — traceability, basic HACCP monitoring | Simplified temperature and batch records |
| **Red Tractor** | Farm-to-fork traceability for meat/dairy products | Batch tracking, temperature records |
| **Retailer codes of practice** (Tesco, M&S, Sainsbury's) | Supplier audit requirements often exceed BRC | Detailed process data, environmental monitoring, energy reporting |
| **UK Food Information Regulations** | Allergen management, labelling accuracy | Production data linked to coding equipment for label verification |
| **Net Zero / ESG reporting** | Scope 1 & 2 emissions | Energy consumption by process, refrigerant leak detection |

---

## Sector 3: Pharmaceutical & Life Sciences

**Target customers:** Sterling Pharma Solutions, Bespak, Almac Group, Piramal Pharma Solutions (UK), Kindeva Drug Delivery, Ipsen Biopharm, Wockhardt UK  
**Revenue range:** £100m–£800m  
**Why this sector:** Extremely data-intensive, heavy regulatory pressure (GxP data integrity), brownfield sites with legacy equipment, and regulatory requirements create *pull demand* for solutions like Collatr.

### Typical Equipment

| Equipment | Vendors | Controllers/PLCs | Protocol |
|-----------|---------|-------------------|----------|
| **Chemical reactors** (batch, CSTR) | De Dietrich, Pfaudler, Büchi | Siemens S7-1500 with WinCC, DeltaV (Emerson), Honeywell Experion | OPC-UA, Modbus TCP, proprietary DCS |
| **Tablet presses** | Korsch, Fette Compacting, IMA | Proprietary controllers with OPC-UA interfaces | OPC-UA, HTTP/REST |
| **Coating pans** | Thomas Engineering, GEA, IMA | Siemens, Allen-Bradley | Modbus TCP, OPC-UA |
| **Filling lines** (vials, syringes, ampoules) | Syntegon (Bosch), IMA, Bausch+Ströbel | Siemens S7-1500, Rockwell | OPC-UA, PROFINET |
| **Lyophilisers** (freeze dryers) | SP Scientific, GEA, Telstar | Siemens, proprietary controllers | OPC-UA, Modbus TCP |
| **Autoclaves / sterilisers** | Getinge, Fedegari, Belimed | Proprietary controllers with validation interfaces | Modbus TCP, HTTP/REST |
| **Environmental monitoring systems** | Vaisala, Rotronic, Particle Measuring Systems | BMS/BACnet, proprietary wireless (Vaisala viewLinc) | Modbus TCP, BACnet, HTTP/REST |
| **HVAC / cleanroom AHUs** | Various (controlled by BMS) | Honeywell, Siemens BMS, Johnson Controls | BACnet, Modbus TCP |
| **Water systems** (PW, WFI) | MECO, Veolia, Evoqua | Siemens, Allen-Bradley | Modbus TCP, OPC-UA |
| **Blister packaging** | IMA, Marchesini, Uhlmann | Siemens S7-1200/1500 | OPC-UA, Modbus TCP |

### Data Signals

#### Cleanroom Environmental Monitoring (CRITICAL for Annex 1 compliance)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `room_temperature` | 18–25 | °C | 60s | Modbus TCP, BACnet |
| `room_humidity` | 30–65 | %RH | 60s | Modbus TCP, BACnet |
| `differential_pressure` | 10–60 | Pa | 30s | Modbus TCP, BACnet |
| `particle_count_0_5um` | 0–352,000 | particles/m³ | 60s (continuous) | HTTP/REST, Modbus TCP |
| `particle_count_5_0um` | 0–29,300 | particles/m³ | 60s (continuous) | HTTP/REST, Modbus TCP |
| `air_changes_per_hour` | 15–60 | ACH | 300s | BACnet |
| `room_classification` | A, B, C, D | grade | Static config | — |
| `airflow_velocity` | 0.36–0.54 | m/s (for Grade A) | 300s | BACnet |
| `door_open` | 0/1 | bool | Event | Modbus TCP (digital input) |
| `gowning_room_dp` | 5–15 | Pa | 30s | Modbus TCP |

#### Chemical Reactor (API Manufacturing)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `reactor_temperature` | -20–200 | °C | 5s | OPC-UA, Modbus TCP |
| `reactor_setpoint` | -20–200 | °C | Event-driven | OPC-UA |
| `jacket_temperature` | -30–250 | °C | 5s | OPC-UA, Modbus TCP |
| `reactor_pressure` | -1–10 | bar | 5s | Modbus TCP |
| `agitator_speed` | 0–500 | RPM | 5s | Modbus TCP |
| `agitator_torque` | 0–100 | % | 5s | Modbus TCP |
| `batch_volume` | 0–10,000 | L | 30s (level sensor) | Modbus TCP |
| `pH` | 0–14 | — | 30s | Modbus TCP (4-20mA) |
| `dissolved_oxygen` | 0–100 | % saturation | 30s | Modbus TCP (4-20mA) |
| `conductivity` | 0–200 | mS/cm | 30s | Modbus TCP (4-20mA) |
| `addition_rate` | 0–100 | L/hr | 5s | Modbus TCP |
| `vent_condenser_temperature` | -10–20 | °C | 30s | Modbus TCP |
| `batch_phase` | 0–10 | enum (charge, heat, react, cool, discharge) | Event | OPC-UA |
| `batch_id` | string | — | Per batch | OPC-UA |

#### Tablet Press

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `compression_force_main` | 5–100 | kN | Per tablet (high-speed) | OPC-UA |
| `compression_force_pre` | 1–20 | kN | Per tablet | OPC-UA |
| `ejection_force` | 0.5–10 | kN | Per tablet | OPC-UA |
| `turret_speed` | 10–120 | RPM | 1s | OPC-UA |
| `tablet_weight` | 50–1500 | mg | Per tablet (sampled) | OPC-UA |
| `tablet_hardness` | 20–300 | N | Sampled (per batch) | HTTP/REST (lab instrument) |
| `tablet_thickness` | 2–10 | mm | Per tablet (sampled) | OPC-UA |
| `feeder_speed` | 0–100 | % | 1s | OPC-UA |
| `tablets_produced` | 0–999,999 | count | Counter | OPC-UA |
| `reject_count` | 0–9999 | count | Counter | OPC-UA |
| `die_fill_depth` | 5–25 | mm | Event | OPC-UA |
| `punch_displacement` | 0–15 | mm | Per tablet (waveform data — post-MVP) | OPC-UA |

#### Water System (Purified Water / WFI)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `conductivity` | 0.05–1.3 | µS/cm | 60s | Modbus TCP |
| `TOC` | 0–500 | ppb | 60s | Modbus TCP |
| `temperature` | 15–85 | °C | 60s | Modbus TCP |
| `flow_rate` | 0–100 | m³/hr | 30s | Modbus TCP |
| `return_loop_pressure` | 1–6 | bar | 30s | Modbus TCP |
| `UV_intensity` | 0–100 | mJ/cm² | 60s | Modbus TCP |
| `ozone_concentration` | 0–200 | ppb | 60s (if ozonated) | Modbus TCP |
| `endotoxin_level` | 0–0.25 | EU/mL | Lab test (event) | HTTP/REST |

### Register/Tag Patterns

**Modbus (Vaisala viewLinc or similar environmental monitoring):**
```
Input Registers (FC04) — per sensor node:
  IR 0:   Temperature    (int16, ×100, °C — e.g., 2150 = 21.50°C)
  IR 1:   Humidity       (int16, ×100, %RH)
  IR 2:   Dewpoint       (int16, ×100, °C)
  IR 3:   Status         (uint16, bitmask — 0=OK, bit0=sensor fault, bit1=out of range)

Each sensor has a unique Modbus slave ID.
Typical cleanroom: 5–20 sensors per room, 10–50 rooms per facility.
```

**OPC-UA (DCS-connected reactor — Siemens WinCC OA or Emerson DeltaV):**
```
Root
└── Objects
    └── ReactorSuite (ns=4)
        ├── Reactor1
        │   ├── Temperature
        │   │   ├── PV             (Double, °C)
        │   │   ├── SP             (Double, °C)
        │   │   └── Output         (Double, %)
        │   ├── Pressure
        │   │   └── PV             (Double, bar)
        │   ├── Agitator
        │   │   ├── Speed          (Double, RPM)
        │   │   └── Torque         (Double, %)
        │   ├── Level
        │   │   └── PV             (Double, L)
        │   ├── Phase              (String, "Charging")
        │   └── BatchInfo
        │       ├── BatchID        (String)
        │       ├── ProductCode    (String)
        │       └── StartTime      (DateTime)
        ├── Reactor2 ...
        └── UtilityHeaders
            ├── Steam
            │   ├── Pressure       (Double, bar)
            │   └── Temperature    (Double, °C)
            └── ChilledWater
                ├── SupplyTemp     (Double, °C)
                └── ReturnTemp     (Double, °C)
```

### Key Analytics Use Cases

| Use Case | Signals Involved | What Collatr Does |
|----------|-----------------|-------------------|
| **Environmental excursion detection** | `room_temperature`, `room_humidity`, `differential_pressure`, `particle_count` | Real-time alerting when cleanroom parameters approach or breach limits; generate audit-ready excursion reports with full context |
| **Batch process analytics** | All reactor signals over batch lifecycle | Overlay batch profiles (golden batch comparison); detect process drift across campaigns |
| **Equipment utilisation** | `machine_state` for tablet press, filling line, reactor | OEE for pharma equipment; identify utilisation bottlenecks in multi-product facilities |
| **Predictive maintenance — vacuum pumps** | `vacuum_level`, `pump_current`, `pump_temperature` | Detect pump degradation before it affects production |
| **Water system compliance** | `conductivity`, `TOC`, `temperature`, `flow_rate` | Continuous monitoring with alerting on USP/EP limits; trend analysis for system health |
| **Energy per batch** | Energy consumption correlated with batch production | Track and reduce energy cost per kg of API or per 1000 tablets |
| **GxP data integrity** | All signals — tamper-evident storage, timestamped, audit trail | CollatrEdge's append-only local store with batch checksums provides ALCOA+ compatible data capture |

### Compliance / Regulatory

| Standard | Requirement | Data Implication |
|----------|-------------|------------------|
| **EU GMP Annex 1** (2023 revision) | Comprehensive environmental monitoring in sterile areas; continuous particle counting in Grade A/B; documented air pressure cascades | Continuous EM data capture with tamper-evident records; 30s–60s sample rates for environmental parameters |
| **EU GMP Annex 11** | Computerised system validation; data integrity; audit trails; ALCOA+ principles | CollatrEdge must provide: attributable, legible, contemporaneous, original, accurate data with audit trail |
| **MHRA GxP Data Integrity** | Electronic records must be attributable, legible, contemporaneous, original, accurate (ALCOA+) | Append-only local store, signed exports, hash chain tamper-evidence (post-MVP) |
| **FDA 21 CFR Part 11** | Electronic records and signatures | Audit trail, user authentication, system validation documentation |
| **ICH Q7** (API GMP) | Process monitoring and control records for API manufacturing | Reactor parameters, in-process testing, environmental data |
| **EU GMP Annex 15** | Qualification and validation — including equipment qualification | Equipment performance data for ongoing process verification |

---

## Sector 4: Automotive & Aerospace Supply Chain

**Target customers:** Sertec Group, Mettis Aerospace, ASG Group (Produmax + Arrowsmith), Grainger & Worrall, Wallwork Group, Nifco UK, Sarginsons Industries  
**Revenue range:** £20m–£500m (sweet spot: £50m–£250m)  
**Why this sector:** Data-rich precision manufacturing processes (CNC, forging, casting, heat treatment), strong regulatory drivers (AS9100, Nadcap, IATF 16949), and several prospects are actively investing in IIoT and digital twin technologies.

### Typical Equipment

| Equipment | Vendors | Controllers/PLCs | Protocol |
|-----------|---------|-------------------|----------|
| **CNC machining centres** (milling, turning, grinding) | DMG Mori, Mazak, Okuma, Haas, Doosan | Fanuc, Siemens SINUMERIK, Mitsubishi, Heidenhain | MTConnect (post-MVP), FOCAS (Fanuc), OPC-UA |
| **Stamping / pressing** | Schuler, AIDA, Komatsu, Nidec Minster | Siemens S7-1500, Rockwell GuardLogix | OPC-UA, Modbus TCP, EtherNet/IP |
| **Forging presses** | Schuler, SMS Group, Erie Press | Siemens, proprietary hydraulic controllers | OPC-UA, Modbus TCP |
| **Injection moulding** | Arburg, Engel, Krauss Maffei, Sumitomo Demag | Proprietary controllers with OPC-UA (EUROMAP 77) | OPC-UA (EUROMAP 77), Modbus TCP |
| **Vacuum furnaces / heat treatment** | Ipsen (furnace), ALD, Seco/Warwick, Solar Manufacturing | Eurotherm, Honeywell UDC, proprietary | Modbus TCP, OPC-UA |
| **Die casting** (HPDC, LPDC, gravity) | Bühler, Italpresse Gauss, Frech | Siemens S7-1500, proprietary | OPC-UA, Modbus TCP |
| **CMM / inspection** | Zeiss, Hexagon, Mitutoyo, Renishaw | Proprietary measurement software | HTTP/REST, file export (CSV/QIF) |
| **Welding** (MIG, TIG, spot, laser) | Fronius, Lincoln, ESAB, Trumpf | Weld controllers with data logging | OPC-UA, HTTP/REST, Modbus TCP |
| **Surface treatment** (plating, anodising, painting) | Various | PLCs controlling bath parameters | Modbus TCP |

### Data Signals

#### CNC Machining Centre

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `spindle_speed` | 0–24,000 | RPM | 1s | MTConnect, OPC-UA, FOCAS |
| `spindle_load` | 0–200 | % | 1s | MTConnect, OPC-UA, FOCAS |
| `feed_rate` | 0–15,000 | mm/min | 1s | MTConnect, OPC-UA |
| `feed_rate_override` | 0–200 | % | Event | MTConnect, OPC-UA |
| `axis_position_X` | -1000–+1000 | mm | 100ms (high-speed) | MTConnect, OPC-UA |
| `axis_position_Y` | -1000–+1000 | mm | 100ms | MTConnect, OPC-UA |
| `axis_position_Z` | -500–+500 | mm | 100ms | MTConnect, OPC-UA |
| `coolant_temperature` | 15–30 | °C | 30s | Modbus TCP |
| `coolant_level` | 0–100 | % | 300s | Modbus TCP |
| `tool_in_use` | 1–120 | tool number | Event | MTConnect, OPC-UA |
| `tool_life_remaining` | 0–100 | % | Event | MTConnect, OPC-UA |
| `part_count` | 0–999,999 | count | Event (per cycle) | MTConnect, OPC-UA |
| `cycle_time` | 10–3600 | seconds | Per part | MTConnect, OPC-UA |
| `program_name` | string | — | Event | MTConnect, OPC-UA |
| `machine_state` | enum | (ACTIVE, IDLE, STOPPED, FAULT) | Event | MTConnect, OPC-UA |
| `power_consumption` | 0–100 | kW | 1s | Modbus TCP (power meter) |
| `vibration_X/Y/Z` | 0–50 | mm/s RMS | 1s (retrofit sensor) | MQTT, Modbus TCP |

#### Stamping / Metal Pressing

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `press_tonnage` | 0–2000 | tonnes | Per stroke | OPC-UA, Modbus TCP |
| `strokes_per_minute` | 10–120 | SPM | 1s | Modbus TCP |
| `stroke_count` | 0–999,999,999 | count | Counter | Modbus TCP |
| `die_temperature` | 20–200 | °C | 10s | Modbus TCP |
| `ram_position` | 0–500 | mm | 500ms | OPC-UA |
| `cushion_pressure` | 0–500 | bar | Per stroke | OPC-UA |
| `part_present_sensor` | 0/1 | bool | Per stroke | Modbus TCP (DI) |
| `scrap_chute_sensor` | 0/1 | bool | Event | Modbus TCP (DI) |
| `lubricant_flow` | 0–50 | L/min | 30s | Modbus TCP |
| `vibration` | 0–100 | mm/s RMS | 1s | MQTT (retrofit sensor) |
| `noise_level` | 60–120 | dB(A) | 60s | MQTT (retrofit sensor) |

#### Vacuum Furnace / Heat Treatment

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `furnace_temperature` | 20–1300 | °C | 5s | Modbus TCP (Eurotherm/Honeywell) |
| `setpoint` | 20–1300 | °C | Event | Modbus TCP |
| `ramp_rate` | 0.1–50 | °C/min | 5s | Modbus TCP |
| `vacuum_level` | 0.001–1013 | mbar | 5s | Modbus TCP |
| `partial_pressure_N2` | 0–1013 | mbar | 10s | Modbus TCP |
| `partial_pressure_Ar` | 0–1013 | mbar | 10s | Modbus TCP |
| `quench_gas_pressure` | 0–20 | bar | 1s (during quench) | Modbus TCP |
| `quench_gas_temperature` | 0–200 | °C | 1s (during quench) | Modbus TCP |
| `load_thermocouple_N` | 20–1300 | °C | 5s (up to 12 TCs) | Modbus TCP |
| `cycle_phase` | 0–6 | enum (Pump Down, Heat Up, Soak, Quench, Temper, Cool) | Event | Modbus TCP |
| `cycle_id` | string | — | Per cycle | Manual/OPC-UA |
| `power_consumption` | 0–500 | kW | 60s | Modbus TCP (power meter) |
| `cooling_water_temperature` | 15–35 | °C | 60s | Modbus TCP |
| `cooling_water_flow` | 0–100 | L/min | 60s | Modbus TCP |

#### Injection Moulding

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `barrel_temperature_zone_N` | 150–350 | °C | 5s | OPC-UA (EUROMAP 77), Modbus TCP |
| `mould_temperature` | 20–200 | °C | 5s | Modbus TCP |
| `injection_pressure` | 0–2500 | bar | Per shot | OPC-UA |
| `holding_pressure` | 0–2000 | bar | Per shot | OPC-UA |
| `screw_position` | 0–500 | mm | 100ms | OPC-UA |
| `injection_speed` | 0–500 | mm/s | Per shot | OPC-UA |
| `cycle_time` | 5–300 | seconds | Per shot | OPC-UA |
| `shot_weight` | 1–5000 | g | Per shot (sampled) | OPC-UA |
| `cushion` | 0–50 | mm | Per shot | OPC-UA |
| `clamp_force` | 0–5000 | kN | Per shot | OPC-UA |
| `parts_produced` | 0–999,999 | count | Counter | OPC-UA |
| `reject_count` | 0–9999 | count | Counter | OPC-UA |
| `hydraulic_oil_temperature` | 30–60 | °C | 30s | Modbus TCP |

#### Foundry / Die Casting

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `melt_temperature` | 600–1600 | °C | 5s | Modbus TCP (thermocouple) |
| `pour_temperature` | 650–1500 | °C | Per pour event | Modbus TCP |
| `die_temperature` | 150–400 | °C | 10s | Modbus TCP |
| `injection_pressure` (HPDC) | 100–2000 | bar | Per shot | OPC-UA |
| `injection_speed` (HPDC) | 0.1–10 | m/s | Per shot | OPC-UA |
| `cycle_time` | 30–600 | seconds | Per cycle | OPC-UA, Modbus TCP |
| `vacuum_level` (vacuum casting) | 50–200 | mbar | 5s | Modbus TCP |
| `cooling_water_temperature` | 15–40 | °C | 30s | Modbus TCP |
| `furnace_power` | 0–500 | kW | 60s | Modbus TCP |
| `casting_count` | 0–999,999 | count | Counter | Modbus TCP |
| `scrap_count` | 0–9999 | count | Counter | Modbus TCP |

### Register/Tag Patterns

**Modbus (Eurotherm controller on vacuum furnace — Wallwork Group):**
```
Input Registers (FC04) — per zone (slave ID = zone):
  IR 1:   Process Variable      (int16, ×10, °C)
  IR 2:   Target Setpoint       (int16, ×10, °C)
  IR 3:   Output Power          (int16, 0-1000 = 0-100.0%)
  IR 4:   Working Output        (int16, %)
  IR 5:   Alarm Status          (uint16, bitmask)

Holding Registers (FC03):
  HR 10-11: Vacuum Level        (float32, ABCD, mbar)
  HR 12-13: Gas Pressure        (float32, ABCD, bar)
  HR 20:    Cycle Phase          (uint16, enum)
  HR 21:    Ramp Segment         (uint16)
```

**OPC-UA (Fanuc/Siemens CNC via MTConnect adapter or native OPC-UA):**
```
Root
└── Objects
    └── CNC_Cell_1 (ns=2)
        ├── Machine1
        │   ├── Controller
        │   │   ├── Mode           (String: "AUTOMATIC"|"MDI"|"MANUAL")
        │   │   ├── Execution      (String: "ACTIVE"|"IDLE"|"STOPPED"|"FEED_HOLD")
        │   │   ├── Program        (String, e.g., "O1234")
        │   │   └── PartCount      (UInt32)
        │   ├── Spindle
        │   │   ├── Speed          (Double, RPM)
        │   │   ├── Load           (Double, %)
        │   │   └── Override       (Double, %)
        │   ├── Axes
        │   │   ├── X
        │   │   │   ├── Position   (Double, mm)
        │   │   │   └── Load       (Double, %)
        │   │   ├── Y ...
        │   │   └── Z ...
        │   ├── Path
        │   │   ├── Feedrate       (Double, mm/min)
        │   │   └── FeedOverride   (Double, %)
        │   └── Coolant
        │       ├── State          (Boolean)
        │       └── Temperature    (Double, °C)
        └── Machine2 ...
```

### Key Analytics Use Cases

| Use Case | Signals Involved | What Collatr Does |
|----------|-----------------|-------------------|
| **CNC OEE and utilisation** | `machine_state`, `cycle_time`, `part_count`, `spindle_load` | Real-time machine utilisation across 50–150+ CNC machines; identify idle time, setup time, cutting time |
| **Tool wear prediction** | `spindle_load` trending over tool life, `vibration`, `part_count per tool` | Detect increasing spindle load at constant feed/speed as indicator of tool wear; predict tool change |
| **Heat treatment process compliance** | `furnace_temperature` profile vs. spec, `soak_time`, `quench_rate` | Overlay actual process curves against specification; flag deviations for Nadcap compliance records |
| **Press tonnage monitoring** | `press_tonnage` per stroke, trending over die life | Detect tonnage drift indicating die wear; predict die replacement |
| **Casting quality correlation** | `pour_temperature`, `die_temperature`, `injection_speed/pressure`, scrap rate | Correlate process parameters with downstream quality inspection data (X-ray, CMM) |
| **Energy per part** | `power_consumption` per machine, `cycle_time`, `part_count` | Track energy cost per component; benchmark across machines |
| **Cross-site benchmarking** (ASG Group) | All OEE signals across Bradford and Coventry | Compare performance of same-type machines across sites |

### Compliance / Regulatory

| Standard | Requirement | Data Implication |
|----------|-------------|------------------|
| **AS9100** (aerospace QMS) | Full process traceability, nonconformance tracking, corrective action | Process data linked to part serial numbers; equipment calibration records |
| **Nadcap** (special process accreditation) | Detailed pyrometric records for heat treatment; documented quench rates, atmosphere control | Continuous furnace data logging with tamper-evident records (5s intervals minimum); thermocouple uniformity surveys |
| **IATF 16949** (automotive QMS) | SPC (Statistical Process Control), process capability (Cpk), PPAP | Dimensional and process data for capability analysis |
| **AMS 2750** (pyrometry) | Temperature uniformity, instrumentation accuracy, thermocouple records | Furnace temperature logging to specific requirements |
| **CQI-9** (heat treatment assessment) | Process monitoring, quench severity, time-temperature records | Detailed batch records with process parameters |

---

## Sector 5: Process Manufacturing

**Target customers:** Encirc (glass), British Sugar, Amtico (LVT flooring), Ideal Heating (boilers/heat pumps), Luxfer Gas Cylinders, CDE Group (wet processing equipment)  
**Revenue range:** £60m–£700m  
**Why this sector:** High-value continuous/batch processes with clear data needs, several are TMMX award winners showing digital appetite, and they represent diverse use cases that test CollatrEdge's breadth.

### Typical Equipment

| Equipment | Vendors | Controllers/PLCs | Protocol |
|-----------|---------|-------------------|----------|
| **Glass furnaces** (melting) | Fives, SORG, Horn | Siemens S7-1500, ABB 800xA | OPC-UA, Modbus TCP |
| **Glass forming machines** (IS machines) | Emhart Glass (Bucher), BDF | Proprietary controllers with OPC-UA | OPC-UA |
| **Boiler assembly lines** | Custom / in-house | Siemens, Allen-Bradley | OPC-UA, Modbus TCP |
| **Calendar lines** (flooring) | Custom / specialist | Siemens S7-1500, Beckhoff | OPC-UA, EtherCAT |
| **Rotocure machines** (flooring) | Custom | Siemens | OPC-UA |
| **Gas cylinder forming** | In-house / specialist | Siemens, Allen-Bradley | OPC-UA, Modbus TCP |
| **Sugar processing** (diffusers, evaporators, crystallisers) | BMA, Putsch, in-house | Siemens S7-1500, ABB | OPC-UA, Modbus TCP |
| **Industrial boilers/burners** | Various | Honeywell, Siemens burner controllers | Modbus TCP |
| **Vision inspection** | Cognex, Keyence, ISRA Vision | Proprietary with HTTP/REST APIs | HTTP/REST, OPC-UA |
| **Wet processing plant** (CDE) | CDE (in-house) | Siemens, Allen-Bradley | OPC-UA, Modbus TCP, Siemens MindSphere |

### Data Signals

#### Glass Manufacturing (Encirc — Hot End)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `furnace_temperature` | 1400–1600 | °C | 10s | OPC-UA, Modbus TCP |
| `crown_temperature` | 1500–1600 | °C | 10s | Modbus TCP |
| `bottom_temperature` | 1100–1300 | °C | 10s | Modbus TCP |
| `gas_flow_rate` | 0–5000 | Nm³/hr | 10s | Modbus TCP |
| `combustion_air_flow` | 0–50,000 | Nm³/hr | 10s | Modbus TCP |
| `glass_level` | 0–100 | % | 30s | Modbus TCP |
| `pull_rate` | 100–600 | tonnes/day | 60s | OPC-UA |
| `gob_weight` | 100–2000 | g | Per gob | OPC-UA |
| `gob_temperature` | 1050–1150 | °C | Per gob | OPC-UA |
| `forming_machine_speed` | 5–20 | cuts/min | 1s | OPC-UA |
| `bottles_produced` | 0–999,999 | count | Counter | OPC-UA |
| `reject_count` | 0–9999 | count | Counter | OPC-UA |
| `defect_type` | 0–20 | enum | Per reject | HTTP/REST (vision system) |
| `lehr_temperature_zone_N` | 400–600 | °C | 30s | Modbus TCP |

#### Boiler/Heat Pump Assembly (Ideal Heating)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `station_cycle_time` | 10–120 | seconds | Per unit | OPC-UA |
| `torque_value_N` | 0–100 | Nm | Per fastening | OPC-UA |
| `torque_result` | PASS/FAIL | bool | Per fastening | OPC-UA |
| `leak_test_pressure` | 0–50 | mbar | Per unit | OPC-UA |
| `leak_test_result` | PASS/FAIL | bool | Per unit | OPC-UA |
| `vision_inspection_result` | PASS/FAIL | bool | Per unit | HTTP/REST |
| `defect_count` | 0–99 | count | Per shift | HTTP/REST |
| `units_produced` | 0–9999 | count | Counter | OPC-UA |
| `line_speed` | 0–30 | units/hr | 1s | OPC-UA |
| `air_pressure` | 5–8 | bar | 30s | Modbus TCP |

#### Sugar Processing (British Sugar)

| Signal Name | Typical Range | Units | Sample Rate | Protocol |
|-------------|---------------|-------|-------------|----------|
| `diffuser_temperature` | 60–75 | °C | 30s | OPC-UA |
| `juice_brix` | 12–18 | °Brix | 60s | Modbus TCP (refractometer) |
| `evaporator_temperature_N` | 100–130 | °C | 30s | OPC-UA |
| `evaporator_vacuum_N` | -0.8–0 | bar | 30s | OPC-UA |
| `syrup_brix` | 60–70 | °Brix | 60s | Modbus TCP |
| `crystalliser_temperature` | 65–80 | °C | 30s | OPC-UA |
| `centrifuge_speed` | 1000–1500 | RPM | 1s | Modbus TCP |
| `sugar_moisture` | 0–0.5 | % | 300s (NIR) | HTTP/REST |
| `steam_consumption` | 0–200 | tonnes/hr | 60s | OPC-UA |
| `beet_throughput` | 0–15,000 | tonnes/day | 300s | OPC-UA |
| `energy_consumption` | 0–50 | MW | 60s | Modbus TCP |

### Key Analytics Use Cases

| Use Case | Signals Involved | What Collatr Does |
|----------|-----------------|-------------------|
| **Glass quality (hot end → cold end)** | `gob_temperature`, `gob_weight`, `forming_speed`, `defect_type` (vision) | Correlate hot-end parameters with cold-end inspection defects; this is Encirc's world-first I4.0 glass line use case |
| **Furnace energy optimisation** | `furnace_temperature`, `gas_flow`, `air_flow`, `pull_rate` | Optimise combustion ratio for minimum energy at target melt rate |
| **Assembly line balancing** | `station_cycle_time` across all stations | Identify bottleneck stations; balance work content for improved throughput |
| **Leak test trending** | `leak_test_pressure` profiles over time | Detect gradual degradation in sealing processes before they cause test failures |
| **Sugar campaign monitoring** | All processing signals over the 4–5 month beet campaign | Track extraction efficiency, energy per tonne of sugar, juice purity trends |

### Compliance / Regulatory

| Standard | Requirement | Data Implication |
|----------|-------------|------------------|
| **ISO 9001** (generic QMS) | Process monitoring, nonconformance tracking | Production data linked to quality records |
| **BS EN 1935 / EN 12600** (glass) | Product performance testing records | Test data correlated with production parameters |
| **Gas Safe / CE marking** (heating) | Test records for every unit, leak test certification | Individual unit test data, torque records |
| **ISO 50001** (energy management) | Energy monitoring, performance tracking | Continuous energy data per process and per product |
| **Environmental permits** | Emissions monitoring (SOx, NOx, particulates for glass furnaces) | CEMS (Continuous Emission Monitoring System) data |

---

## Cross-Sector Common Signals

These data types appear in **nearly every manufacturing SME** regardless of sector. They form the "universal" data layer that CollatrEdge must handle well:

### Universal Signals

| Signal Category | Specific Signals | Typical Protocol | Why Universal |
|----------------|-----------------|------------------|---------------|
| **Machine state** | Running/Idle/Fault/Setup/Maintenance (enum or bitmask) | OPC-UA, Modbus (coils/HR) | Every machine has an operating state — foundation of OEE |
| **Production counters** | Good count, reject count, total count | Modbus (uint32 HR), OPC-UA (UInt32) | Every production line counts output |
| **Line/machine speed** | Speed in m/min, RPM, units/hr, strokes/min | Modbus (float32 HR), OPC-UA (Double) | Rate is universal across all manufacturing |
| **Temperature** | Process temp, ambient temp, motor temp (°C) | Modbus TCP (int16×10 or float32), OPC-UA | Temperature monitoring exists in every sector |
| **Pressure** | Process pressure, hydraulic pressure, pneumatic supply (bar/Pa) | Modbus TCP (float32), OPC-UA | Present in packaging, food, pharma, automotive, process |
| **Motor/drive data** | Current (A), speed (RPM), torque (%), power (kW) | Modbus TCP (float32), OPC-UA | Every motor-driven process |
| **Energy consumption** | kWh per machine, per line, per facility | Modbus TCP (smart meters), HTTP/REST | Growing ESG/Net Zero requirements across all sectors |
| **Fault/alarm codes** | Numeric codes with timestamps | OPC-UA (events), Modbus (HR) | Every PLC generates alarms |
| **Vibration** (retrofit) | mm/s RMS or g peak, typically 3-axis | MQTT (wireless sensor), Modbus TCP | Condition monitoring retrofit applies everywhere |
| **Ambient environment** | Room temp (°C), humidity (%RH) | Modbus TCP/RTU, BACnet, MQTT | BRC/GMP requires it; useful context everywhere |

### Common Modbus Register Patterns

```
The "typical UK SME" Modbus layout (Siemens/Schneider PLCs):

Holding Registers (FC03):
  HR 0-1:     Line Speed          (float32, ABCD)
  HR 2-3:     Process Temperature (float32, ABCD)
  HR 4-5:     Process Pressure    (float32, ABCD)
  HR 10-11:   Good Count          (uint32)
  HR 12-13:   Reject Count        (uint32)
  HR 20:      Machine State       (uint16, enum)
  HR 21:      Fault Code          (uint16)
  HR 30-31:   Motor Current       (float32, ABCD)
  HR 32-33:   Motor Speed RPM     (float32, ABCD)

Input Registers (FC04):
  IR 0:       Analogue Input 1    (int16, ×10)
  IR 1:       Analogue Input 2    (int16, ×10)
  IR 2-3:     Power Consumption   (float32, ABCD)

Coils (FC01):
  Coil 0:     Running
  Coil 1:     Fault Active
  Coil 2:     E-Stop Active

Discrete Inputs (FC02):
  DI 0:       Guard Door Open
  DI 1:       Material Present
  DI 2:       Cycle Complete

Note: Allen-Bradley PLCs behind Modbus TCP gateways
typically use CDAB (word-swapped) byte order.
```

### Common OPC-UA Tag Hierarchy

```
Root
└── Objects
    └── [Site/Plant]
        └── [Line/Area]
            └── [Machine]
                ├── State           (UInt16 or String enum)
                ├── Speed           (Double, units vary)
                ├── Production
                │   ├── GoodCount   (UInt32)
                │   ├── RejectCount (UInt32)
                │   └── TotalCount  (UInt32)
                ├── Process
                │   ├── Temperature (Double, °C)
                │   ├── Pressure    (Double, bar)
                │   └── [sector-specific signals]
                ├── Drive
                │   ├── Current     (Double, A)
                │   ├── Speed       (Double, RPM)
                │   └── Power       (Double, kW)
                └── Alarms
                    ├── ActiveCount (UInt16)
                    └── LastCode    (UInt16)
```

---

## The Demo Dataset Spec

### What an ideal test/demo dataset should contain

Based on the analysis above, the ideal demo dataset should represent a **generic UK SME production line** that's instantly recognisable to buyers in any of our target sectors, while being specific enough to demonstrate real value.

### Recommended: "Packaging Production Line" Demo

**Why packaging:** It's the most accessible sector (widest range of prospects, Doubly Good's deepest domain knowledge, and equipment patterns that translate easily to other sectors). A packaging line demo is directly relevant to Stream 2 targets and serves as a credible proxy for food, pharma, and general manufacturing.

#### Signal Inventory (40 signals)

| # | Signal Name | Type | Range | Units | Rate | Source |
|---|-------------|------|-------|-------|------|--------|
| 1 | `press.line_speed` | gauge | 50–400 | m/min | 1s | Modbus/OPC-UA |
| 2 | `press.web_tension` | gauge | 20–500 | N | 500ms | OPC-UA |
| 3 | `press.registration_error_x` | gauge | -0.5–+0.5 | mm | 500ms | OPC-UA |
| 4 | `press.registration_error_y` | gauge | -0.5–+0.5 | mm | 500ms | OPC-UA |
| 5 | `press.ink_viscosity` | gauge | 15–60 | seconds | 30s | Modbus |
| 6 | `press.ink_temperature` | gauge | 18–35 | °C | 10s | Modbus |
| 7 | `press.dryer_temp_zone_1` | gauge | 40–120 | °C | 5s | Modbus |
| 8 | `press.dryer_temp_zone_2` | gauge | 40–120 | °C | 5s | Modbus |
| 9 | `press.dryer_temp_zone_3` | gauge | 40–120 | °C | 5s | Modbus |
| 10 | `press.dryer_setpoint_zone_1` | gauge | 40–120 | °C | event | Modbus |
| 11 | `press.dryer_setpoint_zone_2` | gauge | 40–120 | °C | event | Modbus |
| 12 | `press.dryer_setpoint_zone_3` | gauge | 40–120 | °C | event | Modbus |
| 13 | `press.impression_count` | counter | 0–999M | count | 1s | Modbus |
| 14 | `press.good_count` | counter | 0–999M | count | 1s | Modbus |
| 15 | `press.waste_count` | counter | 0–99K | count | 1s | Modbus |
| 16 | `press.machine_state` | gauge | 0–5 | enum | event | OPC-UA |
| 17 | `press.main_drive_current` | gauge | 0–200 | A | 1s | Modbus |
| 18 | `press.main_drive_speed` | gauge | 0–3000 | RPM | 1s | Modbus |
| 19 | `press.nip_pressure` | gauge | 0–10 | bar | 5s | Modbus |
| 20 | `press.unwind_diameter` | gauge | 50–1500 | mm | 10s | Modbus |
| 21 | `press.rewind_diameter` | gauge | 50–1500 | mm | 10s | Modbus |
| 22 | `laminator.nip_temp` | gauge | 30–80 | °C | 5s | Modbus |
| 23 | `laminator.nip_pressure` | gauge | 1–8 | bar | 5s | Modbus |
| 24 | `laminator.oven_temp` | gauge | 40–100 | °C | 5s | Modbus |
| 25 | `laminator.web_speed` | gauge | 50–400 | m/min | 1s | Modbus |
| 26 | `laminator.adhesive_weight` | gauge | 1.0–5.0 | g/m² | 30s | Modbus |
| 27 | `slitter.speed` | gauge | 100–800 | m/min | 1s | Modbus |
| 28 | `slitter.web_tension` | gauge | 10–200 | N | 500ms | OPC-UA |
| 29 | `slitter.reel_count` | counter | 0–9999 | count | event | Modbus |
| 30 | `coder.state` | gauge | 0–4 | enum | event | HTTP/REST |
| 31 | `coder.prints_total` | counter | 0–999M | count | event | HTTP/REST |
| 32 | `coder.ink_level` | gauge | 0–100 | % | 60s | HTTP/REST |
| 33 | `coder.printhead_temp` | gauge | 25–50 | °C | 30s | HTTP/REST |
| 34 | `env.ambient_temp` | gauge | 15–35 | °C | 60s | MQTT |
| 35 | `env.ambient_humidity` | gauge | 30–80 | %RH | 60s | MQTT |
| 36 | `energy.line_power` | gauge | 0–200 | kW | 1s | Modbus |
| 37 | `energy.cumulative_kwh` | counter | 0–999,999 | kWh | 60s | Modbus |
| 38 | `vibration.main_drive_x` | gauge | 0–50 | mm/s RMS | 1s | MQTT |
| 39 | `vibration.main_drive_y` | gauge | 0–50 | mm/s RMS | 1s | MQTT |
| 40 | `vibration.main_drive_z` | gauge | 0–50 | mm/s RMS | 1s | MQTT |

#### Anomalies and Events to Simulate

| Event Type | Frequency | Signals Affected | Pattern |
|------------|-----------|-----------------|---------|
| **Job changeover** | 3–6 per shift | `machine_state` → Setup → Running; counters reset; speed ramp-up | 10–30 min duration, speed ramps from 0 to target over 2–5 min |
| **Web break** | 1–2 per week | `machine_state` → Fault; `web_tension` spike then zero; `line_speed` → 0 | Sudden tension spike >600N, then all signals drop |
| **Dryer temperature drift** | Gradual | `dryer_temp_zone_N` drifts 5–10°C above setpoint over 2 hours | Slow creep, preceding quality issues |
| **Motor bearing wear** | Gradual over weeks | `vibration_x/y/z` slowly increasing trend (10→25 mm/s); `main_drive_current` increase at constant speed | Detectable 2–4 weeks before failure |
| **Ink viscosity excursion** | 2–3 per shift | `ink_viscosity` drops below 18s or rises above 45s | Correlates with print quality defects |
| **Registration drift** | Random | `registration_error_x/y` exceeds ±0.3mm | Occurs during speed changes or temperature shifts |
| **Unplanned stop** | 1–2 per shift | `machine_state` → Fault; `fault_code` set; all outputs stop | Random, 5–60 min duration |
| **Shift change** | 3 per day | Brief idle period (5–15 min); possible speed/quality difference between shifts | Pattern visible in 24h OEE view |
| **Energy spike** | 2–3 per day | `line_power` spikes 50% during cold start or after changeover | Correlates with motor inrush on startup |

#### Data Volume

| Parameter | Value |
|-----------|-------|
| **Total signals** | 40 |
| **Average sample rate** | ~2 samples/second (across all signals) |
| **Data points per hour** | ~7,200 |
| **Data points per day** | ~172,800 |
| **Data points per month** | ~5.2 million |
| **Storage (compressed JSON)** | ~50 MB/day, ~1.5 GB/month |
| **History to generate** | 90 days minimum (1 quarter) |
| **Total demo dataset size** | ~4.5 GB (~15.6 million data points) |

#### Tags/Metadata

```
Global tags:
  site = "demo_factory"
  area = "packaging"
  line = "line_3"

Per-source tags:
  device_id = "press_1" | "laminator_1" | "slitter_1" | "coder_1"
  protocol = "modbus" | "opcua" | "http" | "mqtt"
  subsystem = "press" | "laminator" | "slitter" | "coder" | "env" | "energy" | "vibration"
```

---

## Priority Ranking

### Which sector's data patterns to simulate FIRST

| Rank | Sector | Score | Rationale |
|------|--------|-------|-----------|
| **1** | **Packaging, Printing & Labelling** | ⭐⭐⭐⭐⭐ | Deepest domain knowledge (Domino heritage); highest number of accessible prospects (12+ in Stream 2); equipment patterns (presses, laminators, slitters) are distinct and compelling; OEE/waste reduction is the universal language; signals translate easily to demo for other sectors; natural Domino coding equipment entry point |
| **2** | **Food & Beverage Manufacturing** | ⭐⭐⭐⭐ | UK's largest manufacturing sector; strong regulatory pull (BRC); signals overlap significantly with packaging (temperature, speed, counters); Compleat Food Group's new Digital Director is a time-sensitive opportunity; temperature monitoring (ovens, cold chain) is highly relatable |
| **3** | **Automotive & Aerospace Supply Chain** | ⭐⭐⭐⭐ | Most data-intensive processes (CNC generates 100s of tags); strongest compliance drivers (Nadcap, AS9100); several prospects already investing in IIoT (Mettis, Sertec, ASG); but requires MTConnect support (post-MVP) for CNC machines, which limits immediate demo capability |
| **4** | **Pharmaceutical & Life Sciences** | ⭐⭐⭐½ | Highest value per deployment; strongest regulatory pull (GxP data integrity); but longest sales cycles, most complex validation requirements, and post-MVP features (hash chain tamper-evidence, signed exports) needed for full GxP compliance |
| **5** | **Process Manufacturing** | ⭐⭐⭐ | Diverse and interesting (glass, sugar, flooring); but prospects are larger/more complex; fewer targets in sweet spot revenue range; each sub-sector is quite different requiring distinct demo scenarios |

### Recommended Build Sequence

1. **Immediately:** Build the Packaging Production Line simulator (40 signals above) — this becomes the primary demo, test, and development dataset
2. **Week 2–3:** Add a Food & Bev overlay — reuse many signals but add oven temperature zones, fill weight, cold chain monitoring. Demonstrates cross-sector applicability
3. **Month 2:** Add CNC machine monitoring profile — prepare for automotive/aerospace conversations even if MTConnect isn't in MVP (OPC-UA can cover many CNC machines via gateway)
4. **Month 3:** Add pharma environmental monitoring profile — temperature, humidity, differential pressure, particle counts. Distinct value proposition, opens high-value conversations
5. **Ongoing:** Use real customer engagement to refine and add sector-specific signals based on actual equipment encountered

---

## Appendix: Equipment-to-Protocol Quick Reference

This table helps a solutions engineer quickly determine which CollatrEdge input plugin to configure for common equipment:

| Equipment | Primary Protocol | Secondary Protocol | CollatrEdge Plugin | Notes |
|-----------|-----------------|-------------------|-------------------|-------|
| Siemens S7-1200/1500 PLC | OPC-UA | Modbus TCP (via gateway) | `opcua` | Native OPC-UA server built into S7-1500; S7-1200 needs firmware update |
| Schneider Modicon PLC | Modbus TCP | OPC-UA (via gateway) | `modbus` | Modbus is native; OPC-UA via Schneider gateway |
| Allen-Bradley CompactLogix/ControlLogix | EtherNet/IP | OPC-UA (via Kepware/gateway) | `opcua` (via gateway) | Native EtherNet/IP is post-MVP; use Kepware/Ignition as OPC-UA bridge |
| Eurotherm temperature controller | Modbus TCP | — | `modbus` | Direct Modbus TCP; slave ID per zone |
| Domino inkjet printer | HTTP/REST | — | `http_listener` or `exec` | REST API for status and counters |
| Fanuc CNC controller | FOCAS | OPC-UA (via MTConnect adapter) | `opcua` (via adapter) | FOCAS is post-MVP; use MTConnect-to-OPC-UA adapter |
| Vaisala viewLinc (env monitoring) | Modbus TCP | HTTP/REST | `modbus` or `http_listener` | Modbus for sensor values; REST API for alarms and history |
| MQTT wireless sensors | MQTT | — | `mqtt_consumer` | Vibration, temperature, humidity sensors (e.g., Banner, Pepperl+Fuchs) |
| Smart power meters (Schneider PM5xxx) | Modbus TCP | — | `modbus` | Well-documented Modbus register maps |
| Checkweighers (Ishida, Mettler Toledo) | HTTP/REST | Modbus TCP | `http_listener` | REST for detailed per-item data; Modbus for summary counters |
| Vision inspection (Cognex) | HTTP/REST | OPC-UA | `http_listener` | REST API for pass/fail and defect data |
| BMS/HVAC controllers | BACnet | Modbus TCP | `modbus` (via BACnet-to-Modbus gateway) | BACnet is post-MVP; many systems also expose Modbus |

---

*Research conducted 2026-02-25. Based on analysis of Collatr marketing prospect research (Streams 1–6), Close the Loop research papers, protocol & integration research, and CollatrEdge PRD. Signal specifications are derived from equipment vendor documentation, industry standards, and the specific equipment mentioned in prospect profiles. All ranges and sample rates are representative — actual deployments will vary by specific equipment model and customer requirements.*
