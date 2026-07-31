# ZPLExpress

ZPLExpress is a local HTTP service for printing ZPL and EPL labels through
CUPS.

| Selected printer model | Printing method |
| --- | --- |
| Zebra or Argox | Sends the original ZPL/EPL directly with CUPS raw mode |
| OCOM | Sends ZPL/EPL to the installed OCOM driver for processing |

## Production installation

### 1. Install CUPS on Ubuntu

Check whether CUPS is already available:

```bash
command -v lpstat
```

If that command returns nothing, install and start CUPS:

```bash
sudo apt update
sudo apt install -y cups cups-client
sudo systemctl enable --now cups
```

Confirm that CUPS is running and list its printer queues:

```bash
systemctl is-active cups
lpstat -e
```

The printer must have a CUPS queue before it can be selected in ZPLExpress.

### 2. Clone and run in production

Install Node.js 18 or newer and npm, then confirm their versions:

```bash
node --version
npm --version
```

Clone the repository and install the production dependencies:

```bash
git clone https://github.com/malawi-ministry-of-health-dhd/zplexpress.git
cd zplexpress
npm ci --omit=dev
```

For an OCOM OCBP-T4201, obtain a compatible driver package from the
[OCOM Linux driver repository](https://github.com/malawi-ministry-of-health-dhd/linux_printer_driver)
and install it before configuring ZPLExpress. Zebra and Argox users skip this
step. Replace `OCOM_DRIVER_FILE.deb` with the exact downloaded filename.

```bash
cd ~/Downloads
sudo apt install ./OCOM_DRIVER_FILE.deb
cd -
```

Configure the printer and install the production systemd service:

```bash
npm run setup
npm run install-service
```

Confirm that it is running:

```bash
sudo systemctl status zpl.service
```

Open the dashboard on the port selected during setup. The default is
[http://localhost:3000](http://localhost:3000).

Keep the cloned directory in place because the systemd service runs
ZPLExpress from that directory.

### 3. Install the Debian package

For OCOM, first obtain and install the compatible driver from the
[OCOM Linux driver repository](https://github.com/malawi-ministry-of-health-dhd/linux_printer_driver).
Zebra and Argox users skip this step. Replace `OCOM_DRIVER_FILE.deb` with the
exact downloaded filename.

```bash
cd ~/Downloads
sudo apt install ./OCOM_DRIVER_FILE.deb
```

Obtain the ZPLExpress `.deb` supplied for your deployment. Replace
`ZPLEXPRESS_FILE.deb` with its exact filename:

```bash
cd ~/Downloads
sudo apt install ./ZPLEXPRESS_FILE.deb
```

The package installs ZPLExpress in `/opt/zplexpress`, enables
`zpl.service`, and attempts to open the setup dashboard. You can open it from
**Applications → ZPL Print Service** or use port `3000` in a browser by
default.

## Configure

In the dashboard:

1. Select the CUPS printer queue.
2. Select the correct model: **Zebra**, **Argox**, or **OCOM**.
3. Save the port, or keep the default `3000`.

Zebra and Argox always use raw CUPS mode:

```text
lp -d PRINTER_QUEUE -o raw
```

OCOM jobs are processed by the installed OCOM driver.

For a Debian installation, terminal setup is also available:

```bash
sudo zplexpress setup
sudo systemctl restart zpl.service
```

Dashboard changes apply immediately. The terminal setup requires the restart
shown above.

## Print through the API

Send a ZPL label:

```bash
curl -X POST http://localhost:3000/print \
  -H 'Content-Type: application/json' \
  --data '{"zpl":"^XA^FO40,30^A0N,30,30^FDTEST LABEL^FS^XZ"}'
```

The API accepts label commands in `commands`, `data`, `zpl`, or `epl`.
ZPLExpress detects whether the content is ZPL or EPL. Zebra and Argox receive
the original bytes unchanged; OCOM jobs are processed by its installed driver.

Useful endpoints:

- `GET /status` — service, printer, and last-job status
- `GET /printers` — available CUPS queues
- `POST /print` — print a label
- `POST /render` — create a local PDF preview without printing

## OCOM label size

The OCOM physical label size comes from its CUPS queue. The default target is
`102 × 36 mm`. ZPL `^LL` and EPL `Q` do not change the physical media
size.

Use the actual queue name shown by `lpstat -e`. Replace
`your-queue-name` below:

```bash
QUEUE="your-queue-name"
sudo lpadmin -p "$QUEUE" -o PageSize=OCOM102x36
lpoptions -p "$QUEUE" -l | grep '^PageSize/'
```

## Service commands

```bash
sudo systemctl status zpl.service
sudo systemctl restart zpl.service
sudo journalctl -u zpl.service -f
```

To update a Debian installation, run `sudo apt install` with the exact
filename of the newer package.

## Troubleshooting

List configured queues and connected printer devices:

```bash
lpstat -e
lpinfo -v
```

For OCOM:

- Install the driver before ZPLExpress.
- Calibrate the loaded labels at the printer before printing.
- If its queue is missing, run
  `sudo ocom-t4201-setup --media-tracking Calibrated --no-test`.

For Zebra or Argox, make sure the selected CUPS queue supports raw ZPL/EPL.

Check the service logs with:

```bash
sudo journalctl -u zpl.service -n 100 --no-pager
```

ZPLExpress has no built-in authentication and listens on the local network.
Run it only on a trusted network or protect it with a firewall/reverse proxy.
