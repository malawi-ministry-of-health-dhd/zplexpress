# ZPL Printing Service

A Node.js service for handling ZPL (Zebra Programming Language) label printing.

## Install

Download the latest `zplexpress_<version>_all.deb` from the
[GitHub Releases](https://github.com/malawi-ministry-of-health-dhd/zplexpress/releases)
page, then install it either way (both pull in `nodejs` and `cups`):

**GUI:** double-click the downloaded `.deb` — it opens in the desktop's
software installer (GNOME Software / GDebi / Discover); click **Install**.

**Terminal:**

```bash
VER=1.0.0
curl -fsSLO https://github.com/malawi-ministry-of-health-dhd/zplexpress/releases/download/v$VER/zplexpress_${VER}_all.deb
sudo apt install ./zplexpress_${VER}_all.deb
```

Either way this installs the app to `/opt/zplexpress`, registers a
`zpl.service` systemd unit (enabled + started automatically), adds a
`zplexpress` command, and puts a **ZPL Print Service** entry in the
Applications menu.

### Configure

Everything can be configured from the browser dashboard — no terminal needed:

1. Open **Applications → ZPL Print Service** (or browse to
   `http://<this-host>:3000/`).
2. Pick the **printer** from the dropdown.
3. Set the **port** if you want to change it (the page reloads on the new port).

Prefer the terminal? Run `sudo zplexpress setup` for the interactive wizard.
The service listens on port **3000** by default.

**Upgrading:** download the newer `.deb` and `sudo apt install ./…deb` again.
Your printer/port config in `/etc/zplexpress/config.json` is preserved.
**Removing:** `sudo apt remove zplexpress` (or `apt purge` to also delete config).

## Development / manual setup

### Prerequisites

- Node.js 18 or higher

### From source

1. **Clone the repository** (if applicable)
   ```bash
   git clone git@github.com:Kuunika/zplexpress.git
   cd zplexpress
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the printer and port (terminal wizard)**
   ```bash
   node main.js setup
   ```
   This detects the printers connected to your system (via CUPS), shows a
   list to choose from, and asks which port the server should run on. Your
   choice is saved to `config.json`.

## Configuration

Configuration is stored in `config.json` and managed through the interactive
setup wizard:

```bash
node main.js setup
```

The wizard lets you:

- **Select a printer** — all printers registered with CUPS (`lpstat -p`) are
  listed; if more than one is connected you pick the one to use.
- **Set the port** — the port the print server listens on.

`config.json` holds two values:

- `printerName`: The name of the selected ZPL-compatible printer
- `port`: The port number for the service (default: 3000)

If no printer has been configured yet, the setup wizard runs automatically the
first time you start the server. Environment variables (`PRINTER_NAME`, `PORT`
in `.env`) are still honored as a fallback when `config.json` is absent.

## Running the Service

### Development Mode

Start the service with:

```bash
node main.js
```

The service will be available at `http://localhost:3000` (or your configured port).

### Production Deployment (Linux systemd)

An installer script sets up the systemd service automatically. It detects the
`node` binary and project directory, generates the unit file with the correct
paths, then enables and starts the service.

1. **Configure the printer first** (systemd has no terminal for the wizard):
   ```bash
   npm run setup
   ```

2. **Install the service** (re-runs itself with `sudo` if needed):
   ```bash
   npm run install-service
   # or: ./install-service.sh
   ```

That's it — the service is enabled (starts on boot) and running.

**View service logs:**
```bash
sudo journalctl -u zpl.service -f
```

**Check status / restart manually:**
```bash
sudo systemctl status zpl.service
sudo systemctl restart zpl.service
```

The installer runs the service as the invoking user (so it can access the
printer and read `config.json`). To use a different user, edit
`/etc/systemd/system/zpl.service` after installing, or re-run the installer
with `RUN_USER` / `RUN_GROUP` set.

## Usage

Once the service is running, you can send ZPL commands to your configured printer through the API endpoints.

## Requirements

- Node.js 18+
- ZPL-compatible printer (Zebra printers)
- Proper printer driver installation and network/USB connection

## Troubleshooting

- Ensure your printer is properly connected and recognized by the system
- Verify the printer name matches exactly with your system's printer configuration
- Check that the specified port is available and not in use by other services