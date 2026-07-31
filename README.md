# ZPL Printing Service

A Node.js service for handling ZPL (Zebra Programming Language) label printing.

## Prerequisites

- Node.js 18 or higher

## Installation & Setup

1. **Clone the repository** (if applicable)
   ```bash
   git clone git@github.com:Kuunika/zplexpress.git
   cd zplexpress
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   - Rename `.env.example` to `.env`
   - Update the configuration with your printer details:
   ```env
   PRINTER_NAME=your_printer_name
   PORT=3000
   ```

## Configuration

The service requires the following environment variables:

- `PRINTER_NAME`: The name of your ZPL-compatible printer
- `PORT`: The port number for the service (default: 3000)

## Running the Service

### Development Mode

Start the service with:

```bash
node main.js
```

The service will be available at `http://localhost:3000` (or your configured port).

### Production Deployment (Linux systemd)

For production deployment, you can configure the service to run as a systemd service:

1. **Update the service file**
   - Edit the `zpl.service` file in your project directory
   - Update the paths to match your actual installation:
   ```ini
   [Unit]
   Description=zpl printing Service
   After=network.target
   
   [Service]
   ExecStart=/usr/bin/node /path/to/your/main.js
   Restart=always
   User=nobody
   Group=nogroup
   Environment=PATH=/usr/bin:/usr/local/bin
   Environment=NODE_ENV=production
   WorkingDirectory=/path/to/your/app
   
   [Install]
   WantedBy=multi-user.target
   ```

2. **Install and enable the service**
   ```bash
   sudo cp zpl.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable zpl.service
   ```

3. **Start the service**
   ```bash
   sudo systemctl start zpl.service
   ```

4. **Check service status**
   ```bash
   sudo systemctl status zpl.service
   ```

5. **View service logs**
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