# Research: Public Data Sources for Testing & Demonstrating CollatrEdge

**Date:** 2026-02-25  
**Purpose:** Identify real or realistic data sources to flow through CollatrEdge for testing edge cases, config problems, charting, and data export.

---

## Table of Contents

1. [OPC-UA Servers](#1-opc-ua-servers)
2. [Modbus TCP Servers & Simulators](#2-modbus-tcp-servers--simulators)
3. [HTTP/REST APIs with Industrial & Sensor Data](#3-httprest-apis-with-industrial--sensor-data)
4. [MQTT Brokers with Industrial Data](#4-mqtt-brokers-with-industrial-data)
5. [Local Simulators Worth Running](#5-local-simulators-worth-running)
6. [Recommended Starter Config](#6-recommended-starter-config)

---

## 1. OPC-UA Servers

### 1a. Public Internet-Accessible Servers

#### Eclipse Milo Demo Server ⭐ RECOMMENDED
- **Endpoint:** `opc.tcp://milo.digitalpetri.com:62541/milo`
- **Vendor:** Kevin Herron / Inductive Automation (open source)
- **Data:** Dynamically changing values, multiple data types, complex objects
- **Authentication:** Anonymous or username/password pairs:
  - `User` / `password` (AuthenticatedUser role)
  - `UserA` / `password` (SiteA read/write)
  - `UserB` / `password` (SiteB read/write)
  - `SiteAdmin` / `password` (SiteA+B read)
  - `SecurityAdmin` / `password`
- **Security:** Accepts unsecured and secured connections. All client certificates auto-trusted.
- **Live/Changing:** ✅ Yes — values change dynamically
- **Docker:** `docker run --rm -it -p 4840:4840 digitalpetri/opc-ua-demo-server`
- **Source:** https://github.com/digitalpetri/opc-ua-demo-server
- **License:** Open source (Eclipse)
- **Notes:** The most reliable and well-maintained public OPC-UA server. Uses Eclipse Milo (Java). Actively maintained as of 2025.

#### Sterfive Node-OPCUA Demo
- **Endpoint:** `opc.tcp://opcuademo.sterfive.com:26543`
- **Vendor:** Sterfive (commercial node-opcua company)
- **Data:** Standard demo nodes
- **Live/Changing:** ✅ Yes — includes simulation nodes
- **Notes:** Same stack we use (node-opcua), so good compatibility validation. May require registration.

#### Prosys OPC UA Demo Server
- **Endpoint:** `opc.tcp://uademo.prosysopc.com:53530/OPCUA/SimulationServer`
- **Vendor:** Prosys OPC
- **Data:** Simulation signals (sine, random, sawtooth, etc.)
- **Live/Changing:** ✅ Yes — predefined simulation signals
- **Security:** Multiple security modes supported
- **Notes:** Well-known in the OPC-UA community. Sometimes requires whitelisting.

#### Unified Automation Demo Server
- **Endpoint:** `opc.tcp://opcuaserver.com:48010`
- **Vendor:** Unified Automation (hosted by One-Way Automation)
- **Data:** Multiple data types, incrementing values, historical data (HA)
- **Live/Changing:** ✅ Yes
- **Notes:** May require contacting support@onewayautomation.com to enable client connections.

#### One-Way Automation Weather Data Server
- **Endpoint:** `opc.tcp://opcuaserver.com:48484`
- **Data:** Current weather data for locations worldwide via OPC-UA
- **Live/Changing:** ✅ Yes — real weather data
- **Source:** https://github.com/onewayautomation/aqw-opcua-server
- **Notes:** Particularly interesting for demo purposes — real-world data via OPC-UA. May require contacting support to enable access.

#### open62541 Test Server
- **Endpoint:** `opc.tcp://opcua.rocks:4840`
- **Data:** Basic test nodes
- **Live/Changing:** Minimal — mostly static reference data
- **Notes:** Based on open62541 C library. Good for basic connectivity testing.

#### OPC Labs Demo Servers
- **Sample Server:** `opc.tcp://opcua.demo-this.com:51210/UA/SampleServer`
- **Alarm Server:** `opc.tcp://opcua.demo-this.com:62544/Quickstarts/AlarmConditionServer`
- **Data:** Dynamic double-precision values (e.g., node `nsu=http://test.org/UA/Data/;i=10854`), alarms/conditions
- **Live/Changing:** ✅ Yes
- **License:** ⚠️ Restricted — "only licensed for use with QuickOPC" — **not suitable for CollatrEdge testing**
- **Notes:** Listed for completeness but usage restrictions make it unsuitable.

#### UMATI / Machine Tool Servers
- **Endpoint:** `opc.tcp://opcua3.umati.app:4840`
- **Data:** Machine tool companion spec demo data (built with node-opcua)
- **Live/Changing:** ✅ Yes
- **Notes:** Good for testing OPC UA companion specifications.

#### Other Listed Endpoints (unverified)
- `opc.tcp://opcua.123mc.com:4840/` — 123 MC demo server
- `opc.tcp://mfactorengineering.com:4840` — mFactor Engineering
- `opc.tcp://opc.mtconnect.org:4840` — MTConnect reference implementation over OPC-UA
- `opc.tcp://opcua.machinetool.app:4840` — Machine tool app
- `opc.tcp://opcua-demo.factry.io:51210` — Factry (InfluxDB metrics over OPC-UA)

### 1b. Summary Table

| Server | Endpoint | Live Data | Auth Required | Best For |
|--------|----------|-----------|---------------|----------|
| Eclipse Milo | `milo.digitalpetri.com:62541` | ✅ | Optional | **Primary testing** |
| Sterfive | `opcuademo.sterfive.com:26543` | ✅ | No | node-opcua compat |
| Prosys | `uademo.prosysopc.com:53530` | ✅ | No | Simulation signals |
| Unified Auto | `opcuaserver.com:48010` | ✅ | May need whitelist | Data types/HA |
| Weather OPC-UA | `opcuaserver.com:48484` | ✅ | May need whitelist | Real-world demo |

---

## 2. Modbus TCP Servers & Simulators

### 2a. Public Internet-Accessible Server

#### modsim (topmaker.net) ⭐ RECOMMENDED
- **Endpoint:** `modsim.topmaker.net:502`
- **Vendor:** gavinying (open source)
- **Data:** All 4 register types pre-populated:
  - **Coils:** addresses 0-15 (bool8)
  - **Discrete Inputs:** addresses 10000-10015 (bool8)
  - **Input Registers:** addresses 30000-30019 (uint16, int16, uint32, int32, float32)
  - **Holding Registers:** addresses 40000-40043 (uint16, int16, uint32, int32, float32, uint64, int64, float64, string16)
- **Live/Changing:** ⚠️ Static values unless written to via holding registers
- **Source:** https://github.com/gavinying/modsim
- **Notes:** This is the **only known publicly accessible Modbus TCP server on the internet**. Works well for connectivity and data type testing, but values are static. Public Modbus TCP servers are essentially non-existent due to security concerns around the Modbus protocol.

### 2b. Reality Check

Public Modbus TCP servers accessible over the internet are **extremely rare** — essentially just the modsim server above. This is because:
- Modbus has no built-in authentication or encryption
- Exposing Modbus to the internet is a security anti-pattern
- The protocol is designed for local/plant networks

**For Modbus testing, local simulators are essential** (see Section 5).

---

## 3. HTTP/REST APIs with Industrial & Sensor Data

### 3a. Weather & Environmental APIs

#### Open-Meteo ⭐ HIGHLY RECOMMENDED
- **Base URL:** `https://api.open-meteo.com/v1/forecast`
- **Auth:** None — no API key required
- **Rate Limit:** 10,000 requests/day (free, non-commercial)
- **Data:** Temperature, humidity, pressure, wind speed, solar radiation, precipitation — all real, live data
- **Example endpoint (verified working 2026-02-25):**
  ```
  https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,wind_speed_10m
  ```
- **Response format:** JSON with units, timestamps, current + hourly/daily arrays
- **Poll interval:** Every 15 minutes (data updates every 15 min)
- **Live/Changing:** ✅ Yes — real weather data, changes every 15 minutes
- **License:** Free for non-commercial use. CC BY 4.0 for data.
- **Notes:** Perfect proxy for industrial sensors — temperature ≈ process temperature, pressure ≈ vessel pressure, humidity ≈ ambient monitoring. Multiple locations can simulate multiple "plants". No signup friction.

#### OpenWeatherMap
- **Base URL:** `https://api.openweathermap.org/data/2.5/weather`
- **Auth:** API key required (free tier available)
- **Rate Limit:** 60 calls/minute, 1,000,000 calls/month (free tier)
- **Data:** Temperature, pressure, humidity, wind, visibility, clouds
- **Example:** `https://api.openweathermap.org/data/2.5/weather?q=London&appid={API_KEY}`
- **Live/Changing:** ✅ Yes
- **License:** Free tier available, requires attribution
- **Notes:** More complex signup than Open-Meteo but higher rate limits. Good fallback.

### 3b. IoT Sensor Platforms

#### ThingSpeak ⭐ RECOMMENDED
- **Base URL:** `https://api.thingspeak.com/channels/{channel_id}/feeds.json`
- **Auth:** None for public channels
- **Rate Limit:** Read requests are generous; 15-second minimum between reads recommended
- **Verified active channels (as of 2026-02-25):**

  **Channel 9 — Home Sensors** (Light + Outside Temperature)
  ```
  https://api.thingspeak.com/channels/9/feeds.json?results=2
  ```
  - Fields: Light (field1), Outside Temperature (field2)
  - Updates: ~every 16 minutes
  - Active since 2010, still updating

  **Channel 12397 — MathWorks Weather Station** ⭐
  ```
  https://api.thingspeak.com/channels/12397/feeds.json?results=2
  ```
  - Fields: Wind Direction (field1), Wind Speed (field2), Humidity (field3), Temperature (field4), Rain (field5), Pressure (field6), Power Level (field7), Light Intensity (field8)
  - Location: Natick, MA, USA
  - 8 fields of diverse sensor data — excellent for testing
  - Active since 2014, still updating

- **Browse more:** https://thingspeak.mathworks.com/channels/public
- **Live/Changing:** ✅ Yes — real sensor data from real devices
- **License:** Free, public channels require no key
- **Notes:** Huge variety of public channels. Real IoT data from real devices. Perfect for realistic testing. Can find channels with different update rates, data types, and failure modes (offline sensors = null values).

### 3c. Air Quality & Environmental Monitoring

#### OpenAQ
- **Base URL:** `https://api.openaq.org/v3/`
- **Auth:** API key required (free registration)
- **Data:** Global air quality measurements — PM2.5, PM10, NO2, O2, SO2, CO from 80,000+ locations
- **Example:** `https://api.openaq.org/v3/locations?limit=10&coordinates=51.5074,-0.1278&radius=25000`
- **Live/Changing:** ✅ Yes — real sensor data, many update hourly
- **License:** Free, CC BY 4.0
- **Notes:** Very high volume of data. Good for testing at scale.

#### PurpleAir
- **Base URL:** `https://api.purpleair.com/v1/sensors`
- **Auth:** API key required (free registration)
- **Data:** PM2.5, PM10, temperature, humidity, pressure from thousands of sensors
- **Live/Changing:** ✅ Yes — real-time updates every 2 minutes
- **License:** Free API key for non-commercial use
- **Notes:** Extremely large sensor network. Good for geo-distributed testing.

### 3d. Energy & Grid Data

#### U.S. EIA (Energy Information Administration)
- **Base URL:** `https://api.eia.gov/v2/`
- **Auth:** API key required (free registration at eia.gov)
- **Data:** Hourly electricity generation, demand, fuel mix, CO2 emissions for US grid
- **Example:** `https://api.eia.gov/v2/electricity/rto/fuel-type-data/?api_key={KEY}&frequency=hourly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=10`
- **Live/Changing:** ✅ Yes — hourly updates for real-time grid operations
- **License:** Public domain (US government data)
- **Notes:** Industrial-grade energy data. Good for simulating power monitoring scenarios.

#### BGS Sensor Data Service (British Geological Survey)
- **Base URL:** `https://sensors.bgs.ac.uk/FROST-Server/v1.1/`
- **Auth:** None
- **Standard:** OGC SensorThings API (REST/JSON)
- **Data:** Geological/environmental sensor data (groundwater, seismology, etc.)
- **Example:** `https://sensors.bgs.ac.uk/FROST-Server/v1.1/Things`
- **Live/Changing:** ✅ Yes
- **License:** Open Government Licence (UK)
- **Notes:** Follows SensorThings API standard — structured sensor metadata. Good for testing complex data models.

### 3e. Summary Table

| API | Key Required | Real-Time | Update Freq | Best For |
|-----|-------------|-----------|-------------|----------|
| **Open-Meteo** | No | ✅ | 15 min | Primary — no friction |
| **ThingSpeak Ch.12397** | No | ✅ | ~minutes | 8-field weather station |
| **ThingSpeak Ch.9** | No | ✅ | ~16 min | Simple 2-field |
| OpenWeatherMap | Yes (free) | ✅ | 1 min | Higher rate limits |
| OpenAQ | Yes (free) | ✅ | ~1 hour | Air quality at scale |
| US EIA | Yes (free) | ✅ | 1 hour | Energy/grid data |
| BGS SensorThings | No | ✅ | Varies | Structured sensor metadata |

---

## 4. MQTT Brokers with Industrial Data

### 4a. Public MQTT Brokers

#### test.mosquitto.org ⭐ RECOMMENDED
- **Broker:** `test.mosquitto.org`
- **Ports:**
  - `1883` — MQTT, unencrypted, unauthenticated
  - `1884` — MQTT, unencrypted, authenticated (`rw`/`readwrite`, `ro`/`readonly`, `wo`/`writeonly`)
  - `8883` — MQTT, TLS encrypted, unauthenticated
  - `8884` — MQTT, TLS, client certificate required
  - `8080` — MQTT over WebSockets, unencrypted
  - `8081` — MQTT over WebSockets, TLS
- **Topics:** Open — anyone can publish to any topic. Subscribe to `#` with username `wildcard` (20 second limit)
- **Data Quality:** Random — whatever people are publishing at any time. The MIMIC Sparkplug simulator (see below) publishes Sparkplug B data here.
- **Live/Changing:** ✅ Yes — constant traffic from many sources
- **License:** Free, community service by Eclipse Foundation
- **Notes:** The canonical public MQTT broker. Expect random data from many sources. No guaranteed topic structure, but you'll find real traffic on `#`. Experimental builds may cause instability.

#### broker.emqx.io ⭐ RECOMMENDED
- **Broker:** `broker.emqx.io`
- **Ports:**
  - `1883` — MQTT TCP
  - `8883` — MQTT TLS
  - `8083` — MQTT WebSocket
  - `8084` — MQTT WebSocket TLS
- **MQTT Version:** 3.1, 3.1.1, and 5.0
- **Topics:** Open — anyone can pub/sub
- **Live/Changing:** ✅ Yes
- **License:** Free, provided by EMQ Technologies
- **Notes:** More stable than mosquitto test server. Geo-distributed cluster. Good for testing MQTT 5.0 features. Dashboard at https://www.emqx.com/en/mqtt/public-mqtt5-broker shows live stats.

#### broker.hivemq.com
- **Broker:** `broker.hivemq.com`
- **Ports:**
  - `1883` — MQTT TCP
  - `8883` — MQTT TLS
  - `8000` — MQTT WebSocket (SSL)
- **Topics:** Open
- **Live/Changing:** ✅ Yes
- **License:** Free, provided by HiveMQ
- **Notes:** Web client available at hivemq.com for quick browser-based testing.

### 4b. Sparkplug B Data on Public Brokers

#### MIMIC MQTT Lab (Sparkplug B Simulator) ⭐ RECOMMENDED
- **Publishes to:** `test.mosquitto.org` AND `broker.hivemq.com`
- **Topic namespace:** `spBv1.0/#` (standard Sparkplug B namespace)
- **Data:** 100 simulated EON nodes publishing temperature telemetry in Sparkplug B binary format
- **Metric example:** `sensor11/XDK/temp` tag on each EON node
- **Lab URL:** http://mqtt.live.gambitcommunications.com:8080/lab?key=yiUVH%2FqpxpeWJTLOe%2FwOEQ%3D%3D
- **Live/Changing:** ✅ Yes — values change in real-time, lab reset ~midnight EST
- **License:** Free (shared, read-only lab)
- **Notes:** This is the **best freely available source of Sparkplug B data**. Subscribe to `spBv1.0/#` on test.mosquitto.org or broker.hivemq.com to receive binary Sparkplug payloads. You'll need a Sparkplug B decoder (protobuf-based). The data is real Sparkplug B with proper NBIRTH/DBIRTH/NDATA/DDATA message types.

### 4c. Self-Published Test Data Strategy

Since public MQTT topics are unreliable (anyone can publish anything), the best strategy is:

1. **Subscribe** to `spBv1.0/#` on test.mosquitto.org for Sparkplug B testing
2. **Publish your own** test data to a topic namespace on any public broker (e.g., `collatredge/test/+/+`)
3. Use the **mqtt-simulator** tool (see Section 5) to generate realistic JSON payloads

### 4d. Summary Table

| Broker | Port | Sparkplug B | Stability | Best For |
|--------|------|-------------|-----------|----------|
| test.mosquitto.org | 1883 | ✅ via MIMIC | Medium | Sparkplug B testing |
| broker.emqx.io | 1883 | No | High | Primary MQTT testing |
| broker.hivemq.com | 1883 | ✅ via MIMIC | High | Alternative + Sparkplug |

---

## 5. Local Simulators Worth Running

### 5a. OPC-UA Simulators

#### Microsoft OPC PLC Server ⭐ BEST LOCAL SIMULATOR
- **Docker:** `mcr.microsoft.com/iotedge/opc-plc:latest`
- **Run:**
  ```bash
  docker run --rm -it -p 50000:50000 -p 8080:8080 \
    mcr.microsoft.com/iotedge/opc-plc:latest \
    --pn=50000 --autoaccept --sph \
    --sn=5 --sr=10 --st=uint \
    --fn=5 --fr=1 --ft=uint --gn=5
  ```
- **Endpoint:** `opc.tcp://localhost:50000`
- **Data includes:**
  - Alternating boolean
  - Random signed/unsigned 32-bit integers
  - Sine wave with spike anomaly
  - Sine wave with dip anomaly
  - Positive and negative trend values
  - Periodical good/bad/uncertain status codes (slow: 10s, fast: 1s)
  - Complex boiler simulation (temperature, pressure, heater state)
  - DI companion spec boiler with AssetId, DeviceHealth, maintenance events
  - Configurable slow/fast changing nodes
  - Custom nodes via JSON configuration
- **Why it's great:** Generates anomalies, status code changes, events, complex types, and configurable data rates — exactly the edge cases we need to test.
- **Source:** https://github.com/Azure-Samples/iot-edge-opc-plc
- **License:** MIT

#### Eclipse Milo Demo Server (Docker)
- **Docker:** `digitalpetri/opc-ua-demo-server`
- **Run:** `docker run --rm -it -p 4840:4840 digitalpetri/opc-ua-demo-server`
- **Notes:** Same as the public server but local. Good for offline testing.

#### SampleServer-node-opcua ⭐ RECOMMENDED FOR node-opcua COMPAT
- **Docker:** `ghcr.io/andreasheine/sampleserver-node-opcua:main`
- **Run:** `docker run -it -p 4840:4840 -e PORT=4840 ghcr.io/andreasheine/sampleserver-node-opcua:main`
- **Data includes:**
  - OPC UA for Machinery companion spec
  - 3-phase electricity monitoring (voltage, current, energy)
  - Compressed air monitoring
  - Cooling water monitoring
  - Simulated fluctuations in active voltage and current
- **Source:** https://github.com/AndreasHeine/SampleServer-node-opcua
- **License:** Apache 2.0
- **Notes:** Built on node-opcua (same stack as CollatrEdge). Implements real OPC UA companion specifications. Very realistic industrial data models.

#### Prosys OPC UA Simulation Server (Desktop)
- **Download:** https://prosysopc.com/products/opc-ua-simulation-server/
- **Platform:** Windows, Linux, macOS (Java-based)
- **Free Edition:** Supports data changes, data history, events, security modes, PubSub (limited)
- **License:** Free edition available, requires registration
- **Notes:** GUI-based, easy to configure. Good for demos. Professional edition adds custom information models.

### 5b. Modbus TCP Simulators

#### oitc/modbus-server (Docker) ⭐ RECOMMENDED
- **Docker:** `oitc/modbus-server`
- **Run:**
  ```bash
  docker run --rm -p 5020:5020 oitc/modbus-server:latest
  ```
- **Port:** 5020 (configurable)
- **Features:**
  - All 4 register types: coils, discrete inputs, holding registers, input registers
  - JSON configuration file for pre-populating register values
  - TLS support
  - Prometheus metrics endpoint
  - Persistence support
- **Config example** (save as `modbus_config.json`):
  ```json
  {
    "server": {
      "listenerAddress": "0.0.0.0",
      "listenerPort": 5020
    },
    "registers": {
      "initializeUndefinedRegisters": true,
      "holdingRegister": {
        "0": 2500,
        "1": 7500,
        "2": 1013,
        "3": 4500
      },
      "inputRegister": {
        "0": 220,
        "1": 380,
        "2": 50
      }
    }
  }
  ```
- **Limitation:** Values are static unless written to by a Modbus client. For changing values, combine with a script that periodically writes.
- **Source:** https://github.com/cybcon/modbus-server
- **License:** MIT

#### pymodbus Simulator
- **Install:** `pip install pymodbus`
- **Features:**
  - Full Modbus TCP server in Python
  - Programmable data stores
  - Can add callbacks to dynamically update values
- **Best for:** Writing a custom simulator script that generates realistic industrial data (sinusoidal temperatures, random fluctuations, etc.)
- **Example snippet:**
  ```python
  from pymodbus.server import StartTcpServer
  from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext
  
  # Pre-populate with industrial-ish values
  store = ModbusSlaveContext(
      hr=ModbusSequentialDataBlock(0, [2500, 7500, 1013, 4500, 220, 380]),  # temp*100, pressure*100, etc.
      ir=ModbusSequentialDataBlock(0, [100, 200, 300, 400]),
  )
  context = ModbusServerContext(slaves=store, single=True)
  StartTcpServer(context=context, address=("0.0.0.0", 502))
  ```

#### modsim (Docker)
- **Docker:** Available via Dockerfile in repo
- **Run:** `docker run -p 5020:5020 modsim`
- **Source:** https://github.com/gavinying/modsim
- **Notes:** Same as the public server but local. Pre-configured with all register types.

### 5c. MQTT Simulators

#### mqtt-simulator ⭐ RECOMMENDED
- **Source:** https://github.com/DamascenoRafael/mqtt-simulator
- **Run:**
  ```bash
  pip install paho-mqtt
  python3 mqtt-simulator/main.py -f config/settings.json
  ```
  Or via Docker:
  ```bash
  docker build -t mqtt-simulator .
  docker run mqtt-simulator
  ```
- **Features:**
  - JSON-configurable topics and data patterns
  - Simulated random walk with configurable min/max, step size, and probabilities
  - Publish to any broker
  - Multiple topics with variable IDs
- **Config example** for industrial-style data:
  ```json
  {
    "BROKER_URL": "broker.emqx.io",
    "TOPICS": [
      {
        "TYPE": "single",
        "PREFIX": "plant/boiler1",
        "TIME_INTERVAL": 5,
        "DATA": [
          {"NAME": "temperature", "TYPE": "float", "MIN_VALUE": 150, "MAX_VALUE": 200, "MAX_STEP": 2},
          {"NAME": "pressure", "TYPE": "float", "MIN_VALUE": 90, "MAX_VALUE": 110, "MAX_STEP": 1},
          {"NAME": "flow_rate", "TYPE": "float", "MIN_VALUE": 40, "MAX_VALUE": 60, "MAX_STEP": 3}
        ]
      }
    ]
  }
  ```
- **License:** MIT

#### Eclipse Tahu (Sparkplug B Reference Implementation)
- **Source:** https://github.com/eclipse-sparkplug/sparkplug
- **Languages:** Java, Python, C/C++, JavaScript
- **Features:**
  - Reference edge node implementation
  - Proper Sparkplug B payload encoding (protobuf)
  - Birth/death certificate handling
  - Metric templates
- **Notes:** Best for generating proper Sparkplug B traffic to a local or public broker. The Python client is the easiest to get started with.

### 5d. Custom Modbus Simulator Script (Recommended)

Since static Modbus values aren't useful for testing, here's a recommended approach — a Python script that runs alongside oitc/modbus-server and periodically updates register values:

```python
#!/usr/bin/env python3
"""Industrial Modbus data simulator — writes realistic changing values to a Modbus server."""
import time, math, random
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient('localhost', port=5020)
client.connect()

t = 0
while True:
    # Temperature: 150-200°C with sine wave + noise (stored as x100 integer)
    temp = 17500 + int(2500 * math.sin(t * 0.01) + random.gauss(0, 200))
    # Pressure: 95-105 bar with slow drift + noise
    pressure = 10000 + int(500 * math.sin(t * 0.005) + random.gauss(0, 100))
    # Flow rate: 45-55 L/min with random walk
    flow = 5000 + int(500 * math.sin(t * 0.02) + random.gauss(0, 300))
    # Vibration: 0-100 with occasional spikes
    vibration = int(abs(random.gauss(30, 10)))
    if random.random() < 0.02:  # 2% chance of spike
        vibration = random.randint(80, 100)
    
    client.write_registers(0, [temp, pressure, flow, vibration])
    
    t += 1
    time.sleep(1)
```

---

## 6. Recommended Starter Config

### Phase 1: Immediate Setup (Zero Config, Internet Required)

Wire up these sources first — they require no registration, no local setup, and provide real changing data:

| Protocol | Source | Endpoint | What You Get |
|----------|--------|----------|-------------|
| **OPC-UA** | Eclipse Milo | `opc.tcp://milo.digitalpetri.com:62541/milo` | Dynamic values, multiple types, auth testing |
| **HTTP/REST** | Open-Meteo | `https://api.open-meteo.com/v1/forecast?latitude=...&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m` | Temperature, humidity, pressure, wind — 15 min updates |
| **HTTP/REST** | ThingSpeak Ch.12397 | `https://api.thingspeak.com/channels/12397/feeds.json?results=5` | 8-field weather station — wind, temp, pressure, rain, light |
| **MQTT** | EMQX Public | `broker.emqx.io:1883` — subscribe to `spBv1.0/#` and any user topics | Raw MQTT traffic |
| **MQTT (Sparkplug B)** | MIMIC Lab | Subscribe to `spBv1.0/#` on `test.mosquitto.org:1883` | Real Sparkplug B from 100 simulated EON nodes |

### Phase 2: Local Docker Stack (Richer Data, Offline-Capable)

Add these Docker containers for more control and realistic industrial data:

```bash
# OPC-UA: Microsoft OPC PLC (anomalies, trends, status codes, boiler sim)
docker run -d --name opcplc -p 50000:50000 -p 8080:8080 \
  mcr.microsoft.com/iotedge/opc-plc:latest \
  --pn=50000 --autoaccept --sph --sn=5 --sr=10 --st=uint --fn=5 --fr=1 --ft=uint --gn=5

# OPC-UA: SampleServer (node-opcua companion specs, energy monitoring)
docker run -d --name opcua-sample -p 4841:4840 \
  ghcr.io/andreasheine/sampleserver-node-opcua:main

# Modbus TCP: Static register server (combine with update script)
docker run -d --name modbus -p 5020:5020 oitc/modbus-server:latest

# MQTT: Local Mosquitto broker
docker run -d --name mosquitto -p 1883:1883 -p 9001:9001 eclipse-mosquitto:latest

# MQTT: Data simulator publishing to local broker
# (configure mqtt-simulator settings.json to point at localhost:1883)
```

### Phase 3: Full Test Matrix

For comprehensive edge-case testing, add:
- **Multiple OPC-UA servers** simultaneously (test multi-source)
- **Custom Modbus updater script** for realistic changing values with noise, drift, and spikes
- **Multiple Open-Meteo locations** (simulates multiple plants/sites)
- **Sparkplug B via Eclipse Tahu** to local Mosquitto (full Sparkplug lifecycle testing)
- **Intentionally broken sources**: wrong ports, expired certs, intermittent connectivity (test error handling)

### Key Testing Scenarios These Sources Enable

| Scenario | Source |
|----------|--------|
| Smoothly changing values | Open-Meteo, Milo, OPC PLC (sine nodes) |
| Anomaly spikes/dips | OPC PLC (spike/dip anomaly nodes) |
| Status code changes (Good/Bad/Uncertain) | OPC PLC (status nodes) |
| Complex nested objects | OPC PLC (Boiler), SampleServer (machinery) |
| Historical data access | OPC PLC, Prosys (HA) |
| Multiple data types (int, float, bool, string) | Milo, modsim, OPC PLC |
| High-frequency updates | OPC PLC (fast nodes at 1s), mqtt-simulator |
| Real-world variability | Open-Meteo, ThingSpeak, OpenAQ |
| Sparkplug B encoding/decoding | MIMIC Lab, Eclipse Tahu |
| Connection failures & recovery | Intermittent internet → public servers |
| Auth & security modes | Milo (username/password), mosquitto (ports 1884/8883) |

---

*Research conducted 2026-02-25. All public endpoints and APIs were verified accessible at time of writing. Public servers may change without notice — always have local Docker simulators as fallback.*
