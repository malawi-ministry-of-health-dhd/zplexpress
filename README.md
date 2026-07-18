# ZPL Printing Service

A Node.js service for handling ZPL (Zebra Programming Language) label printing.

## Install

ZPLExpress uses the
[OCOM OCBP-T4201 driver](https://github.com/malawi-ministry-of-health-dhd/linux_printer_driver/releases)
to translate ZPL into the printer's native TSPL. Install that driver first,
then install `zplexpress_<version>_all.deb` from the
[ZPLExpress Releases](https://github.com/malawi-ministry-of-health-dhd/zplexpress/releases)
page. The ZPLExpress package declares the OCOM driver as a dependency so it
cannot be accidentally installed without the required print path.

**GUI (recommended).** On Ubuntu 22.04+ the default "App Center" cannot install
local `.deb` files, so install **GDebi** once, then all installs are graphical:

```bash
sudo apt install gdebi     # one time, per machine
```

Then install the OCOM driver `.deb` first. In **Files**, right-click it →
**Open With Other Application** → **GDebi Package Installer** (tick *Set as
default* to enable double-click), and click **Install Package**. Repeat for the
ZPLExpress `.deb`.

**Terminal (alternative).** Installing from a world-readable path avoids the
harmless `_apt` sandbox notice you get when installing from `~/Downloads`:

```bash
DRIVER_VER=1.0.3
ZPLEXPRESS_VER=1.0.4

curl -fsSLO "https://github.com/malawi-ministry-of-health-dhd/linux_printer_driver/releases/download/v${DRIVER_VER}/ocom-ocbp-t4201-driver_${DRIVER_VER}_amd64.deb"
curl -fsSLO "https://github.com/malawi-ministry-of-health-dhd/zplexpress/releases/download/v${ZPLEXPRESS_VER}/zplexpress_${ZPLEXPRESS_VER}_all.deb"

sudo apt install \
  "./ocom-ocbp-t4201-driver_${DRIVER_VER}_amd64.deb" \
  "./zplexpress_${ZPLEXPRESS_VER}_all.deb"
```

This installs the app to `/opt/zplexpress`, registers a
`zpl.service` systemd unit (enabled + started automatically), adds a
`zplexpress` command, and puts a **ZPL Print Service** entry in the
Applications menu.

### Configure

Everything can be configured from the browser dashboard — no terminal needed:

1. Open **Applications → ZPL Print Service** (or browse to
   `http://<this-host>:3000/`).
2. The installed `OCOM_Ubuntu_Driver` queue is selected automatically. If
   needed, pick a different printer from the dropdown.
3. Set the **port** if you want to change it (the page reloads on the new port).

The dashboard distinguishes an installed CUPS queue from the physical USB
connection. It shows **USB connected** only while the OCOM printer is plugged
in and powered on.

Prefer the terminal? Run `sudo zplexpress setup` for the interactive wizard.
The service listens on port **3000** by default.

**Upgrading:** download the newer `.deb` and `sudo apt install ./…deb` again.
Your printer/port config in `/etc/zplexpress/config.json` is preserved.
**Removing:** `sudo apt remove zplexpress` (or `apt purge` to also delete config).

### GitHub builds

Every push to `main` runs the tests, builds a Debian package, and creates a
`build-<run number>` prerelease with the `.deb` attached. Pushing a version tag
such as `v1.0.4` creates the normal versioned GitHub Release.

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
  listed; the OCOM queue is clearly marked and reports when its USB device is
  unplugged.
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

For an OCOM queue, ZPLExpress submits the job as
`application/vnd.ocom-zpl`. CUPS then runs the installed `zpl_to_tspl` filter;
it does not send incompatible raw ZPL to the TSPL-only printer. Genuine Zebra
queues continue to receive raw ZPL.

```bash
curl -X POST http://localhost:3000/print \
  -H 'Content-Type: application/json' \
  --data '{"zpl":"^XA^PW812^LL305^FO80,25^BY3^BCN,110,Y,N,N^FDJOHNDOE^FS^FO285,210^A0N,34,34^FDJOHN DOE^FS^XZ"}'
```

If the configured OCOM USB printer is unplugged, this endpoint returns HTTP
`503` with an explanation instead of queueing a job that cannot print.

## Requirements

- Node.js 18+
- `ocom-ocbp-t4201-driver` 1.0.3 or newer for an OCOM OCBP-T4201
- CUPS and a USB connection to the printer

## Troubleshooting

- Confirm that the OCOM queue and live USB device are both visible:
  `lpstat -v OCOM_Ubuntu_Driver` and `lpinfo -v`
- If the queue is missing, run `sudo ocom-t4201-setup`
- Verify the printer name matches exactly with your system's CUPS configuration
- Check that the specified port is available and not in use by other services
