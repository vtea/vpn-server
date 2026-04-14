[20:23:40] Step 9/9: Installing vpn-agent ...
[20:23:40]   WARNING: could not download vpn-agent, deploy manually:
[20:23:40]     GOOS=linux GOARCH=amd64 go build -o vpn-agent ./cmd/agent
[20:23:40]     scp vpn-agent root@<this-node>:/usr/local/bin/
Created symlink /etc/systemd/system/multi-user.target.wants/vpn-agent.service → /etc/systemd/system/vpn-agent.service.
[20:23:40] ============================================
[20:23:40] Node setup completed!
[20:23:40]   Node ID:     张家界
[20:23:40]   Node Number: 20
[20:23:40]   Public IP:   42.48.123.124
[20:23:40] 
[20:23:40] OpenVPN instances:
[20:23:40]   openvpn-node-direct -> :56710/udp
[20:23:40]   openvpn-cn-split -> :56711/udp
[20:23:40]   openvpn-global -> :56712/udp
[20:23:40] 
[20:23:40] WireGuard tunnels:
[20:23:40]   wg-shanghai: 172.16.0.1 <-> 172.16.0.2
[20:23:40] 
[20:23:40] Agent: WebSocket -> http://192.168.110.62:56700
[20:23:40] ============================================
