// CollatrEdge — OPC-UA certificate management page
// PRD refs: Appendix D §D.3-D.4, §17 Local Web UI
// Phase 9 Task 9.6: OPC-UA certificate helper page
//
// Page sections (per PRD Appendix D §D.4 Step 3):
//   1. Client Certificate — download, thumbprint, validity, subject
//   2. Connection Status — per OPC-UA input with error details
//   3. Server Certificates — per OPC-UA input server cert + Trust button
//
// If no OPC-UA inputs are configured, shows a clear message.

import type { WebUIAdapter, CertificateInfo, ClientCertInfo, OpcuaConnectionInfo } from "../adapter";
import { Layout } from "./layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CertificatesProps {
  adapter: WebUIAdapter;
  adminToken?: string;
}

// ---------------------------------------------------------------------------
// Client certificate section
// ---------------------------------------------------------------------------

function ClientCertSection({ cert }: { cert: ClientCertInfo | null }): string {
  if (!cert) {
    return (
      <div class="card card-full">
        <h2>Client Certificate</h2>
        <p style="color:#64748b;">
          No client certificate configured. Set the <code>certificate</code> path
          in your OPC-UA input configuration to enable certificate-based security.
        </p>
      </div>
    ) as string;
  }

  if (!cert.exists) {
    return (
      <div class="card card-full">
        <h2>Client Certificate</h2>
        <p style="color:#854d0e;">
          Certificate file not found at: <code>{cert.path}</code>
        </p>
        <p style="color:#64748b;font-size:0.85rem;">
          The certificate will be auto-generated on the first connection attempt.
          Start CollatrEdge with an OPC-UA input configured to generate it.
        </p>
      </div>
    ) as string;
  }

  return (
    <div class="card card-full">
      <h2>Client Certificate</h2>
      <div class="cert-details">
        {cert.thumbprint ? (
          <div class="cert-row">
            <span class="cert-label">Thumbprint (SHA-1)</span>
            <code class="cert-value mono">{cert.thumbprint}</code>
          </div>
        ) : ""}
        {cert.subject ? (
          <div class="cert-row">
            <span class="cert-label">Subject</span>
            <span class="cert-value">{cert.subject}</span>
          </div>
        ) : ""}
        {cert.validFrom ? (
          <div class="cert-row">
            <span class="cert-label">Valid From</span>
            <span class="cert-value">{cert.validFrom}</span>
          </div>
        ) : ""}
        {cert.validTo ? (
          <div class="cert-row">
            <span class="cert-label">Valid To</span>
            <span class="cert-value">{cert.validTo}</span>
          </div>
        ) : ""}
        <div class="cert-row">
          <span class="cert-label">File Path</span>
          <code class="cert-value mono">{cert.path}</code>
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <a href="/api/certificates/client/download?format=pem" class="btn">Download .pem</a>
        <a href="/api/certificates/client/download?format=der" class="btn btn-secondary">Download .der</a>
      </div>
      <p style="color:#64748b;font-size:0.8rem;margin-top:8px;">
        Add this certificate to your OPC-UA server&apos;s trusted client store to allow connections.
      </p>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Connection status section
// ---------------------------------------------------------------------------

function ConnectionStatusSection({ inputs }: { inputs: OpcuaConnectionInfo[] }): string {
  return (
    <div class="card card-full">
      <h2>Connection Status</h2>
      <table>
        <thead>
          <tr>
            <th>Alias</th>
            <th>Endpoint</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((input) => (
            <tr>
              <td style="font-weight:500;">{input.alias}</td>
              <td><code style="font-size:0.8rem;">{input.endpoint}</code></td>
              <td>
                <span class={`status-dot dot-${connectionDotClass(input.connectionState)}`}></span>
                {connectionLabel(input.connectionState)}
              </td>
              <td style="color:#888;font-size:0.85rem;">
                {input.errorMessage ?? "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) as string;
}

function connectionDotClass(state: string): string {
  switch (state) {
    case "connected": return "ok";
    case "rejected": return "error";
    case "disconnected": return "stopped";
    default: return "stopped";
  }
}

function connectionLabel(state: string): string {
  switch (state) {
    case "connected": return "Connected";
    case "rejected": return "Rejected";
    case "disconnected": return "Disconnected";
    default: return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Server certificates section
// ---------------------------------------------------------------------------

function ServerCertSection({ inputs, adminToken }: { inputs: OpcuaConnectionInfo[]; adminToken?: string }): string {
  const hasServerCerts = inputs.some((i) => i.serverCert);
  // Escape token for safe embedding in JS string literal
  const escapedToken = adminToken ? adminToken.replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";

  return (
    <div class="card card-full">
      <h2>Server Certificates</h2>
      {hasServerCerts ? (
        <>
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Thumbprint</th>
                <th>Subject</th>
                <th>Validity</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {inputs.filter((i) => i.serverCert).map((input) => (
                <tr>
                  <td style="font-weight:500;">{input.alias}</td>
                  <td><code style="font-size:0.75rem;">{input.serverCert!.thumbprint}</code></td>
                  <td style="font-size:0.85rem;">{input.serverCert!.subject}</td>
                  <td style="font-size:0.85rem;">
                    {input.serverCert!.validFrom} &mdash; {input.serverCert!.validTo}
                  </td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-small trust-btn"
                      data-endpoint={input.endpoint}
                      data-thumbprint={input.serverCert!.thumbprint}
                    >Trust</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <script>{`(function(){var t='${escapedToken}';document.querySelectorAll('.trust-btn').forEach(function(b){b.addEventListener('click',async function(){var ep=this.dataset.endpoint,tp=this.dataset.thumbprint;var h={'Content-Type':'application/json'};if(t)h['Authorization']='Bearer '+t;try{var r=await fetch('/api/certificates/trust',{method:'POST',headers:h,body:JSON.stringify({endpoint:ep,thumbprint:tp})});var d=await r.json();if(r.ok){this.textContent='Trusted';this.disabled=true;this.style.opacity='0.6';}else{alert('Error: '+(d.error||r.statusText));}}catch(e){alert('Network error: '+e.message);}});});})();`}</script>
        </>
      ) : (
        <p style="color:#64748b;">
          Server certificate information will be available after connecting to OPC-UA servers.
          Certificates are received during endpoint discovery, even if the connection is rejected.
        </p>
      ) as string}
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Certificates page
// ---------------------------------------------------------------------------

export function CertificatesPage({ adapter, adminToken }: CertificatesProps): string {
  const certInfo = adapter.getCertificateInfo();
  const noOpcuaInputs = certInfo.inputs.length === 0 && !certInfo.clientCert;

  return Layout({
    title: "CollatrEdge \u2014 Certificates",
    children: (
      <>
        <div class="header">
          <h1>CollatrEdge</h1>
          <div style="display:flex;align-items:center;">
            <nav>
              <a href="/">Dashboard</a>
            </nav>
          </div>
        </div>

        <div class="container">
          <h2 style="font-size:1.1rem;margin-bottom:16px;">OPC-UA Certificate Management</h2>

          {noOpcuaInputs ? (
            <div class="card card-full">
              <p style="color:#64748b;">
                No OPC-UA inputs are configured. Certificate management is only needed
                when connecting to OPC-UA servers.
              </p>
              <p style="color:#64748b;font-size:0.85rem;margin-top:8px;">
                Add an <code>[[inputs.opcua]]</code> section to your configuration file
                to enable OPC-UA data collection.
              </p>
            </div>
          ) : (
            <>
              {ClientCertSection({ cert: certInfo.clientCert }) as "safe"}
              {ConnectionStatusSection({ inputs: certInfo.inputs }) as "safe"}
              {ServerCertSection({ inputs: certInfo.inputs, adminToken }) as "safe"}
            </>
          ) as string}

          <div class="footer">
            <a href="/" style="color:#94a3b8;">Back to Dashboard</a>
          </div>
        </div>
      </>
    ) as string,
  });
}
