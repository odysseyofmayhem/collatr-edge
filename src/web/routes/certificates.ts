// CollatrEdge — OPC-UA certificate management routes
// PRD refs: Appendix D §D.3-D.4 (certificate workflow, TOFU), §17 Local Web UI
// Phase 9 Task 9.6: OPC-UA certificate helper page
//
// Endpoints:
//   GET  /api/certificates/client           — client certificate info
//   GET  /api/certificates/client/download   — download client certificate file
//   GET  /api/certificates/status            — per-input connection status
//   POST /api/certificates/trust             — trust a server certificate (TOFU)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { dirname } from "node:path";
import type { WebUIAdapter } from "../adapter";
import { CertificatesPage } from "../views/certificates";

// ---------------------------------------------------------------------------
// GET /api/certificates/client
// Returns client certificate info (thumbprint, subject, validity, paths).
// ---------------------------------------------------------------------------

export function handleCertificateClient(adapter: WebUIAdapter): Response {
  const certInfo = adapter.getCertificateInfo();

  if (!certInfo.clientCert) {
    return new Response(
      JSON.stringify({
        configured: false,
        message: "No OPC-UA inputs with client certificate configured",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const { path, exists, thumbprint, subject, validFrom, validTo } =
    certInfo.clientCert;

  return new Response(
    JSON.stringify({
      configured: true,
      path,
      exists,
      thumbprint: thumbprint ?? null,
      subject: subject ?? null,
      validFrom: validFrom ?? null,
      validTo: validTo ?? null,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /api/certificates/client/download?format=pem|der
// Downloads the client certificate file.
// ---------------------------------------------------------------------------

export function handleCertificateDownload(
  adapter: WebUIAdapter,
  query: { format?: string },
): Response {
  const certInfo = adapter.getCertificateInfo();

  if (!certInfo.clientCert?.exists || !certInfo.clientCert.path) {
    return new Response(
      JSON.stringify({ error: "Client certificate not found on disk" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const format = (query.format ?? "pem").toLowerCase();
  if (format !== "pem" && format !== "der") {
    return new Response(
      JSON.stringify({ error: "format must be 'pem' or 'der'" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const pemData = readFileSync(certInfo.clientCert.path);

    if (format === "pem") {
      return new Response(pemData, {
        headers: {
          "Content-Type": "application/x-pem-file",
          "Content-Disposition":
            "attachment; filename=collatr-edge-client.pem",
        },
      });
    }

    // DER format: parse PEM and extract raw DER bytes
    const cert = new X509Certificate(pemData);
    const derBuffer = cert.raw;

    return new Response(derBuffer, {
      headers: {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition":
          "attachment; filename=collatr-edge-client.der",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to read certificate file" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/certificates/status
// Returns per-OPC-UA-input connection status and server certificate info.
// ---------------------------------------------------------------------------

export function handleCertificateStatus(adapter: WebUIAdapter): Response {
  const certInfo = adapter.getCertificateInfo();

  return new Response(
    JSON.stringify({ inputs: certInfo.inputs }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// POST /api/certificates/trust
// Trust a server certificate by writing to the TOFU trust store.
// Body: { endpoint: string, thumbprint: string }
// This is the only write operation in the MVP Web UI (PRD Appendix D §D.4).
// ---------------------------------------------------------------------------

export interface TrustRequest {
  endpoint?: string;
  thumbprint?: string;
}

interface TrustedServer {
  endpoint: string;
  thumbprint: string;
  trustedAt: string;
}

interface TrustStore {
  trustedServers: TrustedServer[];
}

export async function handleCertificateTrust(
  adapter: WebUIAdapter,
  body: TrustRequest,
): Promise<Response> {
  const { endpoint, thumbprint } = body;

  if (!endpoint || !thumbprint) {
    return new Response(
      JSON.stringify({ error: "endpoint and thumbprint are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate thumbprint format: colon-separated hex pairs (e.g., "AB:CD:EF:12:...")
  if (!/^([0-9A-Fa-f]{2}:)*[0-9A-Fa-f]{2}$/.test(thumbprint)) {
    return new Response(
      JSON.stringify({ error: "invalid thumbprint format — expected colon-separated hex (e.g., AB:CD:EF:12:...)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const trustStorePath = adapter.getTrustStorePath();
  if (!trustStorePath) {
    return new Response(
      JSON.stringify({ error: "No trust store configured — no OPC-UA inputs with certificate paths" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    // Read existing trust store or create new
    let store: TrustStore = { trustedServers: [] };
    if (existsSync(trustStorePath)) {
      const raw = readFileSync(trustStorePath, "utf-8");
      store = JSON.parse(raw) as TrustStore;
    }

    // Update or add the trusted server
    const existing = store.trustedServers.findIndex(
      (s) => s.endpoint === endpoint,
    );
    const entry: TrustedServer = {
      endpoint,
      thumbprint: thumbprint.toUpperCase(),
      trustedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      store.trustedServers[existing] = entry;
    } else {
      store.trustedServers.push(entry);
    }

    // Write trust store
    const dir = dirname(trustStorePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(trustStorePath, JSON.stringify(store, null, 2));

    return new Response(
      JSON.stringify({ ok: true, message: `Trusted server certificate for ${endpoint}` }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to write trust store: ${(err as Error).message}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /certificates — render the certificate management page
// ---------------------------------------------------------------------------

export function handleCertificatesPage(adapter: WebUIAdapter): Response {
  const page = CertificatesPage({ adapter });
  return new Response(page, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
