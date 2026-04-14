# ZPL Printing Service

A Node.js service for handling ZPL (Zebra Programming Language) label printing.

## Prerequisites

- Node.js 18 or higher
- CUPS commands available (`lp` and `lpstat`)

## Installation & Setup

Run the installer:

```bash
chmod +x install.sh
./install.sh
```

The installer will:
- Install dependencies (`npm ci` or `npm install`)
- Create `.env` from `.env.example` if missing
- Prompt for `PRINTER_NAME` and `PORT`
- Run preflight checks
- Optionally install a Linux `systemd` service

You can also run:

```bash
npm run setup
```

## Validation

Run preflight checks any time:

```bash
npm run doctor
```

This checks:
- Node/npm availability and Node version
- `.env` presence and `PORT` validity
- `lp`/`lpstat` commands
- Printer detection and `PRINTER_NAME`

## Running the Service

Start the service with:

```bash
npm start
```

The service will be available at `http://localhost:3000` (or your configured port).

## Configuration

The service uses:
- `PRINTER_NAME`: The name of your ZPL-compatible printer
- `PORT`: The port number for the service (default: 3000)

## Production Deployment (Linux systemd)

Install and enable the service automatically:

```bash
npm run service:install
```

Then inspect logs:

```bash
sudo journalctl -u zpl.service -f
```

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
