#!/bin/bash

# ---- SETTINGS ----
CERT_DIR="./certs"

# ---- FUNCTIONS ----

# Function to validate IPv4 address
validate_ipv4() {
    local ip=$1
    local stat=1

    if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        OIFS=$IFS
        IFS='.'
        ip=($ip)
        IFS=$OIFS
        [[ ${ip[0]} -le 255 && ${ip[1]} -le 255 && ${ip[2]} -le 255 && ${ip[3]} -le 255 ]]
        stat=$?
    fi
    return $stat
}

# Function to get device IP from user
get_device_ip() {
    while true; do
        echo ""
        echo "🌐 Please enter your device's IP address:"
        echo "   (This should be the IP where MODS will run)"
        read -p "Device IP: " DEVICE_IP
        
        # Check if input is empty
        if [[ -z "$DEVICE_IP" ]]; then
            echo "❌ IP address cannot be empty. Please try again."
            continue
        fi
        
        # Validate IPv4 format
        if validate_ipv4 "$DEVICE_IP"; then
            echo "✅ Valid IPv4 address: $DEVICE_IP"
            break
        else
            echo "❌ Invalid IPv4 address format. Please enter a valid IP (e.g., 192.168.1.100)"
        fi
    done
}

# Function to confirm IP address
confirm_ip() {
    echo ""
    echo "📋 Certificate will be generated for:"
    echo "   • $DEVICE_IP (your device)"
    echo "   • localhost"
    echo "   • 127.0.0.1"
    echo ""
    read -p "Is this correct? (y/N): " confirm
    
    case $confirm in
        [yY]|[yY][eE][sS])
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# ---- MAIN SCRIPT ----

echo "🔐 mkcert Certificate Generator"
echo "=============================="

# ---- Step 1: Check if mkcert is installed ----
if ! command -v mkcert &> /dev/null; then
    echo "❌ mkcert not found. Please install mkcert before running this script."
    echo ""
    echo "Installation instructions:"
    echo "• macOS: brew install mkcert"
    echo "• Linux: Visit https://github.com/FiloSottile/mkcert#installation"
    echo "• Windows: Visit https://github.com/FiloSottile/mkcert#installation"
    exit 1
fi

# ---- Step 2: Get and validate device IP ----
get_device_ip

# ---- Step 3: Confirm IP address ----
while ! confirm_ip; do
    get_device_ip
done

# ---- Step 4: Install mkcert CA ----
echo ""
echo "✅ Installing mkcert local CA..."
if ! mkcert -install; then
    echo "❌ Failed to install mkcert CA. Please check permissions and try again."
    exit 1
fi

# ---- Step 5: Create certs directory ----
echo "✅ Creating certs directory at $CERT_DIR..."
if ! mkdir -p "$CERT_DIR"; then
    echo "❌ Failed to create directory $CERT_DIR. Please check permissions."
    exit 1
fi

# ---- Step 6: Generate certificates ----
echo "✅ Generating certificates for $DEVICE_IP, localhost, and 127.0.0.1..."
if ! mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" "$DEVICE_IP" localhost 127.0.0.1; then
    echo "❌ Certificate generation failed. Please check mkcert installation and try again."
    exit 1
fi

# ---- Step 7: Verify certificate files ----
if [[ ! -f "$CERT_DIR/cert.pem" || ! -f "$CERT_DIR/key.pem" ]]; then
    echo "❌ Certificate files not found after generation."
    exit 1
fi

# ---- Step 8: Show success and next steps ----
CAROOT=$(mkcert -CAROOT)
echo ""
echo "🎉 SUCCESS! Certificates generated successfully!"
echo "=============================================="
echo ""
echo "📁 Certificate files created:"
echo "   • $CERT_DIR/cert.pem"
echo "   • $CERT_DIR/key.pem"
echo ""
echo "🔑 Root CA location:"
echo "   • $CAROOT/rootCA.pem"
echo ""
echo "🚀 Next Steps:"
echo "1. Copy the root CA to your mobile device:"
echo "   $CAROOT/rootCA.pem"
echo ""
echo "2. Install the CA on your mobile device:"
echo "   📱 Android: Settings > Security > Encryption & credentials > Install a certificate > CA"
echo "   🍎 iOS: AirDrop the file to your device, then Settings > General > VPN & Device Management"
echo ""
echo "3. Use the certificates in your development server:"
echo "   • Certificate: $CERT_DIR/cert.pem"
echo "   • Private Key: $CERT_DIR/key.pem"
echo ""
echo "✨ Your HTTPS development server should now be trusted on all devices!"