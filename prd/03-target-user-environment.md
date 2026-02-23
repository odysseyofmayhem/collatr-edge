## 3. Target User & Environment

### Primary User

UK SME manufacturers (10–250 employees). Mixed-age machinery, limited IT resource, constrained budgets. Typically no existing MES or IIoT platform. Data collection is manual (paper, spreadsheets) or non-existent.

### Secondary Users

- **System integrators** deploying Collatr on behalf of customers
- **Manufacturing engineers** at mid-market companies adding IIoT to specific lines

### Deployment Environment

- **Compute:** Raspberry Pi 4/5, industrial mini-PCs (e.g., OnLogic, Advantech), any x64/arm64 Linux box with ≥1GB RAM and ≥4GB storage. Note: Raspberry Pi SD cards are suitable for trial/proof-of-concept; production deployments should use industrial SD cards or mini-PCs with SSDs. eMMC-based devices require write-rate awareness (see §11).
- **Network:** Three deployment postures (see §10):
  - **Connected:** Ethernet/Wi-Fi to shop floor + internet. Full Hub connectivity.
  - **Local network:** Ethernet to plant LAN, no internet. Most common real-world deployment. Data stays on-premises.
  - **Standalone (air-gapped):** No network at all, or direct laptop connection only. Required by some customers contractually (e.g., supermarket supply chain audits, defence supply chain).
- **Physical:** DIN rail enclosures, server rooms, under desks, inside control cabinets. Dusty, hot, unattended.
- **Power:** May experience unexpected power loss (no UPS guarantee)
