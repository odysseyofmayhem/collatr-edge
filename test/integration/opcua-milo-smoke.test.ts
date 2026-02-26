// Smoke test: live connection to Eclipse Milo public demo server
// PRD refs: Appendix D (OPC-UA Input Plugin Specification)
// ──────────────────────────────────────────────────────────────────────
// This is the acceptance test that proves CollatrEdge can connect to a
// real OPC-UA server and receive live data changes. It targets the
// public Eclipse Milo demo server at opc.tcp://milo.digitalpetri.com:62541/milo.
//
// The entire describe block is skipped when the server is unreachable
// (e.g., in CI or when the public server is down). This is checked
// via a quick connect probe at module load time.
// ──────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import { RealOpcuaClient } from "@core/opcua-client";
import type { DataChangeEvent } from "@plugins/inputs/opcua";

// ---------------------------------------------------------------------------
// Milo demo server coordinates
// ---------------------------------------------------------------------------

const MILO_ENDPOINT = "opc.tcp://milo.digitalpetri.com:62541/milo";

const DYNAMIC_NODES = [
  { nodeId: "ns=2;s=Dynamic/RandomInt32", name: "random_int32" },
  { nodeId: "ns=2;s=Dynamic/RandomFloat", name: "random_float" },
  { nodeId: "ns=2;s=Dynamic/RandomDouble", name: "random_double" },
] as const;

const CLIENT_OPTIONS = {
  securityPolicy: "None",
  securityMode: "None",
  connectTimeout: 5000,
  requestTimeout: 10000,
  sessionTimeout: 30000,
} as const;

// ---------------------------------------------------------------------------
// Reachability probe — determines whether to skip the entire describe block
// ---------------------------------------------------------------------------

let miloReachable = false;

try {
  const probe = new RealOpcuaClient();
  await probe.connect(MILO_ENDPOINT, CLIENT_OPTIONS);
  await probe.disconnect();
  miloReachable = true;
} catch {
  // Server unreachable — tests will be skipped
}

// ---------------------------------------------------------------------------
// Tests — skipped entirely when the Milo server is unreachable
// ---------------------------------------------------------------------------

describe.skipIf(!miloReachable)(
  "Smoke test: Eclipse Milo demo server (live)",
  () => {
    it("connects, subscribes to 3 dynamic nodes, and receives data changes", async () => {
      const client = new RealOpcuaClient();
      const received = new Map<string, DataChangeEvent[]>();

      // Track data changes per node
      for (const node of DYNAMIC_NODES) {
        received.set(node.nodeId, []);
      }

      client.onDataChange((event: DataChangeEvent) => {
        const events = received.get(event.nodeId);
        if (events) {
          events.push(event);
        }
      });

      try {
        // 1. Connect
        await client.connect(MILO_ENDPOINT, CLIENT_OPTIONS);
        expect(client.isConnected).toBe(true);

        // 2. Create anonymous session
        await client.createSession({ type: "anonymous" });
        expect(client.sessionActive).toBe(true);

        // 3. Create subscription (2s publishing interval)
        await client.createSubscription({
          publishingInterval: 2000,
          maxKeepAliveCount: 10,
          lifetimeCount: 100,
          maxNotificationsPerPublish: 100,
        });

        // 4. Add monitored items for 3 dynamic nodes
        for (const node of DYNAMIC_NODES) {
          await client.addMonitoredItem({
            nodeId: node.nodeId,
            samplingInterval: 1000,
            queueSize: 10,
            deadbandType: "none",
            deadbandValue: 0,
            trigger: "status_value",
          });
        }

        // 5. Wait for data changes (up to 10s)
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const allHaveData = DYNAMIC_NODES.every(
            (n) => (received.get(n.nodeId)?.length ?? 0) >= 1,
          );
          if (allHaveData) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        // 6. Verify: at least 1 data change received per node
        for (const node of DYNAMIC_NODES) {
          const events = received.get(node.nodeId)!;
          expect(events.length).toBeGreaterThanOrEqual(1);

          const first = events[0]!;

          // 7. Verify: field values are numeric (not null, not string)
          expect(typeof first.value).toBe("number");
          expect(first.value).not.toBeNull();

          // 8. Verify: source timestamps are present and recent (within last 60s)
          expect(first.sourceTimestamp).not.toBeNull();
          if (first.sourceTimestamp) {
            const age = Date.now() - first.sourceTimestamp.getTime();
            expect(age).toBeLessThan(60_000);
            expect(age).toBeGreaterThanOrEqual(0);
          }

          // Verify data type is a known numeric type
          expect(["Int32", "Float", "Double"]).toContain(first.dataType);

          // Verify status code is good (0)
          expect(first.statusCode).toBe(0);
          expect(first.quality).toBe("good");
        }
      } finally {
        // 9. Clean shutdown
        await client.closeSession();
        await client.disconnect();
        expect(client.isConnected).toBe(false);
      }
    }, 30_000);

    it("server certificate fingerprint is available after connect", async () => {
      const client = new RealOpcuaClient();

      try {
        await client.connect(MILO_ENDPOINT, CLIENT_OPTIONS);
        const fingerprint = client.getServerCertificateFingerprint();

        // Milo server should provide a certificate
        expect(fingerprint).not.toBeNull();
        if (fingerprint) {
          // SHA-256 fingerprint format: colon-separated uppercase hex
          expect(fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
        }
      } finally {
        await client.disconnect();
      }
    }, 15_000);
  },
);
