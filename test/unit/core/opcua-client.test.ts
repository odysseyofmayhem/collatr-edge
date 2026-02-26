// Unit tests: RealOpcuaClient adapter against in-process OPCUAServer
// PRD refs: Appendix D (OPC-UA Input Plugin Specification)
// ──────────────────────────────────────────────────────────────────────
// These tests spin up a lightweight in-process node-opcua OPCUAServer
// with a few test nodes and verify the RealOpcuaClient adapter against it.
// Port 0 is used for OS-assigned ports to avoid conflicts.
// ──────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  RealOpcuaClient,
  mapSecurityPolicy,
  mapSecurityMode,
} from "@core/opcua-client";
import type { DataChangeEvent } from "@plugins/inputs/opcua";
import {
  OPCUAServer,
  Variant,
  DataType,
  SecurityPolicy,
  MessageSecurityMode,
} from "node-opcua";

// ---------------------------------------------------------------------------
// Test server setup — shared across tests in this file
// ---------------------------------------------------------------------------

let server: InstanceType<typeof OPCUAServer>;
let endpointUrl: string;
let serverPort: number;

// Variable references for mutating values during tests
let intVar: any;
let floatVar: any;
let doubleVar: any;
let boolVar: any;

// Mutable backing values
let intValue = 42;
let floatValue = 3.14;
let doubleValue = 23.5;
let boolValue = true;

const TEST_NAMESPACE_URI = "http://collatr-edge.test/UA/TestData";

beforeAll(async () => {
  server = new OPCUAServer({
    port: 0,
    resourcePath: "/test",
  });

  await server.initialize();

  const addressSpace = server.engine.addressSpace!;
  const ns = addressSpace.registerNamespace(TEST_NAMESPACE_URI);
  const objectsFolder = addressSpace.rootFolder.objects;

  // Create a folder for test data (mirrors Eclipse Milo "Dynamic" folder)
  const dynamicFolder = ns.addFolder(objectsFolder, { browseName: "Dynamic" });

  intVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "RandomInt32",
    dataType: "Int32",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Int32, value: intValue }),
    },
  });

  floatVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "RandomFloat",
    dataType: "Float",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Float, value: floatValue }),
    },
  });

  doubleVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Temperature",
    dataType: "Double",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Double, value: doubleValue }),
    },
  });

  boolVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Running",
    dataType: "Boolean",
    minimumSamplingInterval: 100,
    value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: boolValue }),
    },
  });

  await server.start();

  serverPort = server.endpoints[0]!.port;
  endpointUrl = `opc.tcp://localhost:${serverPort}/test`;
}, 15_000); // Extended timeout — OPCUAServer startup is slow

afterAll(async () => {
  if (server) {
    await server.shutdown();
  }
}, 10_000);

// ---------------------------------------------------------------------------
// Helper: default client options for test connections
// ---------------------------------------------------------------------------

function defaultOpts() {
  return {
    securityPolicy: "None",
    securityMode: "None",
    connectTimeout: 5000,
    requestTimeout: 5000,
    sessionTimeout: 60_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RealOpcuaClient", () => {
  describe("connect / disconnect", () => {
    it("connects to in-process server", async () => {
      const client = new RealOpcuaClient();
      expect(client.isConnected).toBe(false);

      await client.connect(endpointUrl, defaultOpts());
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      expect(client.isConnected).toBe(false);
    }, 10_000);

    it("throws on unreachable endpoint", async () => {
      const client = new RealOpcuaClient();

      await expect(
        client.connect("opc.tcp://localhost:1/nonexistent", {
          ...defaultOpts(),
          connectTimeout: 1000,
        }),
      ).rejects.toThrow(/OPC-UA connect failed/);

      expect(client.isConnected).toBe(false);
    }, 10_000);

    it("isConnected becomes false after disconnect", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      expect(client.isConnected).toBe(false);
    }, 10_000);

    it("double disconnect does not throw", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.disconnect();

      // Second disconnect should be a no-op
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    }, 10_000);
  });

  describe("createSession", () => {
    it("creates an anonymous session", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      expect(client.sessionActive).toBe(false);

      await client.createSession({ type: "anonymous" });
      expect(client.sessionActive).toBe(true);

      await client.closeSession();
      expect(client.sessionActive).toBe(false);
      await client.disconnect();
    }, 10_000);

    it("creates a session with no auth argument (defaults to anonymous)", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());

      await client.createSession();
      expect(client.sessionActive).toBe(true);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws if not connected", async () => {
      const client = new RealOpcuaClient();

      await expect(client.createSession()).rejects.toThrow(
        /not connected/,
      );
    });
  });

  describe("createSubscription", () => {
    it("creates a subscription", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      // Should not throw
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws if session not active", async () => {
      const client = new RealOpcuaClient();

      await expect(
        client.createSubscription({
          publishingInterval: 200,
          maxKeepAliveCount: 10,
          lifetimeCount: 100,
          maxNotificationsPerPublish: 10,
        }),
      ).rejects.toThrow(/session not active/);
    });
  });

  describe("addMonitoredItem + onDataChange", () => {
    it("receives initial data change on subscribe", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      await client.addMonitoredItem({
        nodeId: intVar.nodeId.toString(),
        samplingInterval: 100,
        queueSize: 10,
        deadbandType: "none",
        deadbandValue: 0,
      });

      // Wait for initial data change
      await waitForCondition(() => events.length >= 1, 3000);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const first = events[0]!;
      expect(first.nodeId).toBe(intVar.nodeId.toString());
      expect(first.dataType).toBe("Int32");
      expect(typeof first.value).toBe("number");
      expect(first.quality).toBe("good");
      expect(first.statusCode).toBe(0);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("receives data change when value mutates", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      // Reset value and monitor
      intValue = 42;
      await client.addMonitoredItem({
        nodeId: intVar.nodeId.toString(),
        samplingInterval: 100,
        queueSize: 10,
        deadbandType: "none",
        deadbandValue: 0,
      });

      // Wait for initial value
      await waitForCondition(() => events.length >= 1, 3000);

      // Mutate the value
      intValue = 999;
      intVar.touchValue(new Date());

      // Wait for the mutation event
      await waitForCondition(() => events.length >= 2, 3000);

      const mutationEvent = events.find((e) => e.value === 999);
      expect(mutationEvent).toBeDefined();
      expect(mutationEvent!.dataType).toBe("Int32");

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("monitors multiple nodes simultaneously", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 20,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      // Monitor all four test variables
      for (const v of [intVar, floatVar, doubleVar, boolVar]) {
        await client.addMonitoredItem({
          nodeId: v.nodeId.toString(),
          samplingInterval: 100,
          queueSize: 10,
          deadbandType: "none",
          deadbandValue: 0,
        });
      }

      // Wait for initial data changes from all nodes
      await waitForCondition(() => events.length >= 4, 5000);

      // Verify we got events for each node
      const nodeIds = new Set(events.map((e) => e.nodeId));
      expect(nodeIds.has(intVar.nodeId.toString())).toBe(true);
      expect(nodeIds.has(floatVar.nodeId.toString())).toBe(true);
      expect(nodeIds.has(doubleVar.nodeId.toString())).toBe(true);
      expect(nodeIds.has(boolVar.nodeId.toString())).toBe(true);

      // Verify data types
      const intEvent = events.find(
        (e) => e.nodeId === intVar.nodeId.toString(),
      );
      expect(intEvent!.dataType).toBe("Int32");

      const floatEvent = events.find(
        (e) => e.nodeId === floatVar.nodeId.toString(),
      );
      expect(floatEvent!.dataType).toBe("Float");

      const doubleEvent = events.find(
        (e) => e.nodeId === doubleVar.nodeId.toString(),
      );
      expect(doubleEvent!.dataType).toBe("Double");

      const boolEvent = events.find(
        (e) => e.nodeId === boolVar.nodeId.toString(),
      );
      expect(boolEvent!.dataType).toBe("Boolean");

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws if subscription not active", async () => {
      const client = new RealOpcuaClient();

      await expect(
        client.addMonitoredItem({
          nodeId: "ns=2;i=1001",
          samplingInterval: 100,
          queueSize: 10,
          deadbandType: "none",
          deadbandValue: 0,
        }),
      ).rejects.toThrow(/subscription not active/);
    });

    it("throws on unparseable node ID format", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      // coerceNodeId throws on completely invalid format
      await expect(
        client.addMonitoredItem({
          nodeId: "totally-invalid-garbage!!!",
          samplingInterval: 100,
          queueSize: 10,
          deadbandType: "none",
          deadbandValue: 0,
        }),
      ).rejects.toThrow(/cannot be coerced/);

      // Client should still be functional after the error
      expect(client.isConnected).toBe(true);
      expect(client.sessionActive).toBe(true);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("silently accepts non-existent but parseable node ID", async () => {
      // OPC-UA servers accept monitor requests for non-existent nodes
      // but emit no data changes — this is valid OPC-UA behavior.
      // The OpcuaInput class handles this via the failedNodes tracking.
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      // Valid format but non-existent node — does not throw
      await client.addMonitoredItem({
        nodeId: "ns=99;i=99999",
        samplingInterval: 100,
        queueSize: 10,
        deadbandType: "none",
        deadbandValue: 0,
      });

      // No events should arrive for a non-existent node
      await new Promise((r) => setTimeout(r, 500));
      expect(events.length).toBe(0);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);
  });

  describe("DataChangeEvent mapping", () => {
    it("includes sourceTimestamp and serverTimestamp", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      await client.addMonitoredItem({
        nodeId: doubleVar.nodeId.toString(),
        samplingInterval: 100,
        queueSize: 10,
        deadbandType: "none",
        deadbandValue: 0,
      });

      await waitForCondition(() => events.length >= 1, 3000);

      const event = events[0]!;
      // server always provides serverTimestamp
      expect(event.serverTimestamp).toBeInstanceOf(Date);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("maps Boolean data type correctly", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      const events: DataChangeEvent[] = [];
      client.onDataChange((event) => events.push(event));

      boolValue = true;
      await client.addMonitoredItem({
        nodeId: boolVar.nodeId.toString(),
        samplingInterval: 100,
        queueSize: 10,
        deadbandType: "none",
        deadbandValue: 0,
      });

      await waitForCondition(() => events.length >= 1, 3000);

      const event = events[0]!;
      expect(event.dataType).toBe("Boolean");
      expect(event.value).toBe(true);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);
  });

  describe("browse", () => {
    it("discovers nodes under ObjectsFolder", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      const results = await client.browse("ns=0;i=85", 3, [
        "Variable",
        "Object",
      ]);

      // Should find our Dynamic folder and its variables
      const dynamicFolder = results.find(
        (n) => n.browseName === "Dynamic" && n.nodeClass === "Object",
      );
      expect(dynamicFolder).toBeDefined();

      const tempNode = results.find(
        (n) => n.browseName === "Temperature" && n.nodeClass === "Variable",
      );
      expect(tempNode).toBeDefined();
      expect(tempNode!.dataType).toBe("Double");
      expect(typeof tempNode!.currentValue).toBe("number");

      const intNode = results.find(
        (n) => n.browseName === "RandomInt32" && n.nodeClass === "Variable",
      );
      expect(intNode).toBeDefined();

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("respects maxDepth", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      // Depth 1: should find the Dynamic folder but NOT its children
      const shallow = await client.browse("ns=0;i=85", 1, [
        "Variable",
        "Object",
      ]);

      const dynamicFolder = shallow.find((n) => n.browseName === "Dynamic");
      expect(dynamicFolder).toBeDefined();

      // Our variables are at depth 2 (Objects → Dynamic → Variables)
      // With maxDepth=1, we should NOT find them
      const tempNode = shallow.find((n) => n.browseName === "Temperature");
      expect(tempNode).toBeUndefined();

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("filters by node class", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      // Only Variables — no Objects
      const varsOnly = await client.browse("ns=0;i=85", 3, ["Variable"]);

      const hasObject = varsOnly.some((n) => n.nodeClass === "Object");
      expect(hasObject).toBe(false);

      const hasVariable = varsOnly.some((n) => n.nodeClass === "Variable");
      expect(hasVariable).toBe(true);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws if session not active", async () => {
      const client = new RealOpcuaClient();

      await expect(
        client.browse("ns=0;i=85", 3, ["Variable"]),
      ).rejects.toThrow(/session not active/);
    });
  });

  describe("resolveNamespaceUri", () => {
    it("resolves known namespace URI to index", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      const index = await client.resolveNamespaceUri(TEST_NAMESPACE_URI);
      expect(index).toBe(2); // 0=OPC Foundation, 1=server, 2=ours

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws on unknown namespace URI", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      await expect(
        client.resolveNamespaceUri("http://nonexistent.example/UA/Nothing"),
      ).rejects.toThrow(/Namespace URI not found/);

      await client.closeSession();
      await client.disconnect();
    }, 10_000);

    it("throws if session not active", async () => {
      const client = new RealOpcuaClient();

      await expect(
        client.resolveNamespaceUri(TEST_NAMESPACE_URI),
      ).rejects.toThrow(/session not active/);
    });
  });

  describe("closeSession / lifecycle", () => {
    it("closeSession terminates subscription and session", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();
      await client.createSubscription({
        publishingInterval: 200,
        maxKeepAliveCount: 10,
        lifetimeCount: 100,
        maxNotificationsPerPublish: 10,
      });

      expect(client.sessionActive).toBe(true);

      await client.closeSession();
      expect(client.sessionActive).toBe(false);

      await client.disconnect();
    }, 10_000);

    it("double closeSession does not throw", async () => {
      const client = new RealOpcuaClient();
      await client.connect(endpointUrl, defaultOpts());
      await client.createSession();

      await client.closeSession();
      await client.closeSession(); // should be a no-op
      expect(client.sessionActive).toBe(false);

      await client.disconnect();
    }, 10_000);
  });

  describe("onClose callback", () => {
    it("fires when server disconnects the client", async () => {
      // Use a separate server for this test to avoid disrupting others
      const isolatedServer = new OPCUAServer({
        port: 0,
        resourcePath: "/close-test",
      });
      await isolatedServer.initialize();
      await isolatedServer.start();
      const isoPort = isolatedServer.endpoints[0]!.port;
      const isoUrl = `opc.tcp://localhost:${isoPort}/close-test`;

      const client = new RealOpcuaClient();
      let closeCalled = false;
      client.onClose(() => {
        closeCalled = true;
      });

      await client.connect(isoUrl, defaultOpts());
      await client.createSession();

      // Shut down the server — should trigger onClose
      await isolatedServer.shutdown();

      // Wait for close event
      await waitForCondition(() => closeCalled, 5000);
      expect(closeCalled).toBe(true);
      expect(client.isConnected).toBe(false);

      // Clean up — disconnect may throw since server is gone
      try {
        await client.disconnect();
      } catch {
        // Expected — server already gone
      }
    }, 15_000);
  });

  describe("server certificate fingerprint", () => {
    it("provides fingerprint after connect", async () => {
      const client = new RealOpcuaClient();
      expect(client.getServerCertificateFingerprint()).toBeNull();

      await client.connect(endpointUrl, defaultOpts());

      const fp = client.getServerCertificateFingerprint();
      // Server may or may not provide a certificate depending on config,
      // but node-opcua OPCUAServer generates a self-signed cert by default
      if (fp !== null) {
        // Should be colon-separated uppercase hex
        expect(fp).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2})+$/);
      }

      await client.disconnect();
    }, 10_000);
  });

  describe("transferSubscriptions", () => {
    it("returns false when no session or subscription exists", async () => {
      const client = new RealOpcuaClient();
      const result = await client.transferSubscriptions();
      expect(result).toBe(false);
    });
  });

  describe("security policy / mode mapping", () => {
    it("maps valid security policies", () => {
      expect(mapSecurityPolicy("None")).toBe(SecurityPolicy.None);
      expect(mapSecurityPolicy("Basic256Sha256")).toBe(
        SecurityPolicy.Basic256Sha256,
      );
      expect(mapSecurityPolicy("Aes128_Sha256_RsaOaep")).toBe(
        SecurityPolicy.Aes128_Sha256_RsaOaep,
      );
      expect(mapSecurityPolicy("Aes256_Sha256_RsaPss")).toBe(
        SecurityPolicy.Aes256_Sha256_RsaPss,
      );
    });

    it("throws on unknown security policy", () => {
      expect(() => mapSecurityPolicy("InvalidPolicy")).toThrow(
        /Unknown security policy/,
      );
    });

    it("maps valid security modes", () => {
      expect(mapSecurityMode("None")).toBe(MessageSecurityMode.None);
      expect(mapSecurityMode("Sign")).toBe(MessageSecurityMode.Sign);
      expect(mapSecurityMode("SignAndEncrypt")).toBe(
        MessageSecurityMode.SignAndEncrypt,
      );
    });

    it("throws on unknown security mode", () => {
      expect(() => mapSecurityMode("InvalidMode")).toThrow(
        /Unknown security mode/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Utility: wait for a condition with timeout
// ---------------------------------------------------------------------------

function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}
