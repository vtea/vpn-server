sudo bash -c 'cat > /etc/apt/sources.list <<EOF
deb http://archive.ubuntu.com/ubuntu jammy main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu jammy-updates main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu jammy-security main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu jammy-backports main restricted universe multiverse
EOF
apt update
apt install -y jq openvpn wireguard-tools easy-rsa dnsmasq'

sudo bash -c 'systemctl stop systemd-resolved
systemctl disable systemd-resolved
rm -f /etc/resolv.conf
echo "nameserver 8.8.8.8" > /etc/resolv.conf
systemctl restart dnsmasq
systemctl status dnsmasq --no-pager'