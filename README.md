# ZPL Printing Service

A Node.js service that renders common ZPL label commands locally and prints
them through CUPS. OCOM printers can use either:

- `PDFRaster` (default): ZPL → exact-size PDF → CUPS raster → TSPL
- `NativeTSPL`: ZPL → TSPL using the OCOM driver's translator

ARGOX and ZEBRA queues receive raw ZPL directly. The PDF renderer is local, so
patient and label data is not sent to an Internet rendering service.

## Install

ZPLExpress uses the
[OCOM OCBP-T4201 driver](https://github.com/malawi-ministry-of-health-dhd/linux_printer_driver/releases)
to translate ZPL into the printer's native TSPL. Install that driver first,
then install `zplexpress_<version>_all.deb` from the
[ZPLExpress Releases](https://github.com/malawi-ministry-of-health-dhd/zplexpress/releases)
page. The OCOM driver is only required when the selected model is `OCOM`;
ARGOX and ZEBRA printers only require a working raw CUPS queue.

**GUI (recommended).** On Ubuntu 22.04+ the default "App Center" cannot install
local `.deb` files, so install **GDebi** once, then all installs are graphical:

```bash
sudo apt install gdebi     # one time, per machine
```

For an OCOM printer, install the OCOM driver `.deb` first. In **Files**,
right-click it →
**Open With Other Application** → **GDebi Package Installer** (tick *Set as
default* to enable double-click), and click **Install Package**. Repeat for the
ZPLExpress `.deb`.

**Terminal (alternative for OCOM).** Installing from a world-readable path
avoids the harmless `_apt` sandbox notice you get when installing from
`~/Downloads`:

```bash
DRIVER_VER=1.0.3
ZPLEXPRESS_VER=1.2.0

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
3. Select the printer model: **ARGOX**, **ZEBRA**, or **OCOM**.
4. For OCOM only, select **PDFRaster** for local PDF rendering or
   **NativeTSPL** for direct conversion. ARGOX and ZEBRA always receive raw ZPL.
5. Set the **port** if you want to change it (the page reloads on the new port).

The dashboard distinguishes an installed CUPS queue from the physical USB
connection. It shows **USB connected** only while the selected USB printer is
plugged in and powered on.

Prefer the terminal? Run `sudo zplexpress setup` for the interactive wizard.
The service listens on port **3000** by default.

**Upgrading:** download the newer `.deb` and `sudo apt install ./…deb` again.
Your printer/port config in `/etc/zplexpress/config.json` is preserved.
**Removing:** `sudo apt remove zplexpress` (or `apt purge` to also delete config).

### GitHub builds

Every push to `main` runs the tests, builds a Debian package, and creates a
`build-<run number>` prerelease with the `.deb` attached. Pushing a version tag
such as `v1.2.0` creates the normal versioned GitHub Release.

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
- **Select the printer model** — `ARGOX`, `ZEBRA`, or `OCOM`. ARGOX and ZEBRA
  use raw ZPL.
- **Set the port** — the port the print server listens on.
- **Select an OCOM renderer** — `PDFRaster` or `NativeTSPL`; this question is
  only shown for OCOM.

`config.json` holds four values:

- `printerName`: The name of the selected ZPL-compatible printer
- `printerModel`: `ARGOX`, `ZEBRA`, or `OCOM`
- `port`: The port number for the service (default: 3000)
- `renderMode`: `PDFRaster` (default) or `NativeTSPL`, used only for OCOM

If no printer has been configured yet, the setup wizard runs automatically the
first time you start the server. Environment variables (`PRINTER_NAME`,
`PRINTER_MODEL`, `ZPL_RENDER_MODE`, and `PORT` in `.env`) are still honored as
a fallback when `config.json` is absent.

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

Once the service is running, you can send ZPL commands to your configured
printer through the API endpoints. ARGOX and ZEBRA jobs are submitted with
`lp -o raw`; ZPLExpress does not translate their ZPL.

For OCOM in the default `PDFRaster` mode, ZPLExpress reads the selected CUPS
`PageSize`, creates a PDF with that exact physical media box, and submits it as
`application/pdf`. CUPS rasterizes the PDF and the OCOM driver produces TSPL.
The ZPL `^PW` and `^LL` remain logical coordinates and cannot change the
physical label feed length.

```bash
curl -X POST http://localhost:3000/print \
  -H 'Content-Type: application/json' \
  --data '{"zpl":"^XA^PW812^LL305^FO80,25^BY3^BCN,110,Y,N,N^FDJOHNDOE^FS^FO285,210^A0N,34,34^FDJOHN DOE^FS^XZ"}'
```

Preview the same local rendering without printing:

```bash
curl -X POST http://localhost:3000/render \
  -H 'Content-Type: application/json' \
  --data '{"zpl":"^XA^PW812^LL305^FO10,5^A0N,30,30^FDTEST^FS^XZ"}' \
  --output label-preview.pdf
```

Override the configured mode for one OCOM print:

```bash
curl -X POST http://localhost:3000/print \
  -H 'Content-Type: application/json' \
  --data '{"renderMode":"NativeTSPL","zpl":"^XA^FO10,5^A0N,30,30^FDTEST^FS^XZ"}'
```

### Configure the physical label size

Set the size on the CUPS queue. The service reads it for every PDF render:

```bash
# 101.6 x 38.1 mm
sudo lpadmin -p OCOM_Ubuntu_Driver -o PageSize=w288h108

# Confirm it
sudo lpoptions -p OCOM_Ubuntu_Driver |
  tr ' ' '\n' |
  grep '^PageSize='
```

For a custom size supported by the driver, use a CUPS custom media name such
as `Custom.101.6x38.1mm`. Do not rely on `^LL` to configure the stock; `^LL`
only describes the ZPL drawing canvas.

The local renderer currently handles the common commands used by ZPLExpress
labels: `^FO`, `^FT`, `^A`, `^CF`, `^FB`, `^FD`, `^FH`, `^GB`, `^GC`,
uncompressed `^GFA`, `^BY`, `^BC`, `^B3`, `^BQ`, and `^PQ`. Unsupported
specialized commands are ignored rather than being forwarded to an online
service. Use `NativeTSPL` when a label depends on a command implemented by the
OCOM translator but not by the PDF renderer.

If the configured OCOM USB printer is unplugged, this endpoint returns HTTP
`503` with an explanation instead of queueing a job that cannot print.

## Requirements

- Node.js 18+
- `ocom-ocbp-t4201-driver` 1.0.3 or newer for an OCOM OCBP-T4201
- A raw ZPL-compatible CUPS queue for ARGOX or ZEBRA
- CUPS and a USB connection to the printer

## Troubleshooting

- Confirm that the OCOM queue and live USB device are both visible:
  `lpstat -v OCOM_Ubuntu_Driver` and `lpinfo -v`
- If the queue is missing, run `sudo ocom-t4201-setup`
- Verify the printer name matches exactly with your system's CUPS configuration
- Check that the specified port is available and not in use by other services
